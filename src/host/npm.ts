/**
 * What allaboard asks of the owner's npm to update itself: the newest published version, whether a
 * version is published, whether the running copy is the one `npm install -g` replaces, and the
 * install. It goes through `npm`, never over HTTP of its own, so the owner's registry, proxy and
 * credentials apply. npm runs through `RunAsync`: an install takes 30 to 60 seconds.
 *
 * The shapes of npm's failures were measured on npm 11.17.0 (2026-10-17): an unreachable registry
 * prints `npm error code ECONNREFUSED` and ends with status 1; a `lib/node_modules` that is not
 * writable prints `npm error code EACCES`, `npm error path <folder>` and ends with 243; a killed
 * npm ends with 137 and says nothing. An unknown version under `--json` prints `npm error code
 * E404` and ends with 1.
 */
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "../log.ts";
import { isVersion } from "../semver.ts";
import { packageVersion } from "../version.ts";
import { copyOf } from "./program.ts";
import type { CommandResult, RunAsync } from "./run.ts";

export const logger = getLogger("allaboard.host.npm");

export { isNewer, isVersion } from "../semver.ts";

/**
 * Why an npm command failed, from its own words: `network` when it could not reach the registry,
 * `permission` when it may not write a folder (`path`, the one npm names, or null), `other` with
 * its exit status otherwise (null when it could not start or was killed, 0 when it ended well and
 * said something unusable).
 */
export type NpmFailure =
  | { kind: "network" }
  | { kind: "permission"; path: string | null }
  | { kind: "other"; status: number | null };

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ECONNRESET",
  "ENETUNREACH",
]);

/** The failure that `result`, of a command that did not end well, tells. */
export function classifyFailure(result: CommandResult): NpmFailure {
  const code = /^npm error code (\S+)\s*$/m.exec(result.stderr)?.[1];
  if (code !== undefined && NETWORK_CODES.has(code)) return { kind: "network" };
  if (code === "EACCES" || code === "EPERM") {
    const path = /^npm error path (\/.+?)\s*$/m.exec(result.stderr)?.[1];
    return { kind: "permission", path: path ?? null };
  }
  return { kind: "other", status: result.status };
}

/** The version `npm view` printed for `args`, or why there is none. */
async function viewed(
  run: RunAsync,
  args: readonly string[],
  signal: AbortSignal | undefined,
): Promise<{ version: string } | { failure: NpmFailure; result: CommandResult }> {
  const result = await run("npm", ["view", ...args, "version", "--json"], signal);
  if (result.status !== 0) return { failure: classifyFailure(result), result };
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (typeof parsed === "string" && isVersion(parsed)) return { version: parsed };
  } catch {}
  return { failure: { kind: "other", status: 0 }, result };
}

/**
 * The newest version published on npm (`dist-tags.latest`), or the failure that hid it. Every
 * function below that runs npm takes the `signal` that ends it (SIGTERM, see `RunAsync`).
 */
export async function latestVersion(
  run: RunAsync,
  signal?: AbortSignal,
): Promise<{ version: string } | { failure: NpmFailure }> {
  const found = await viewed(run, ["allaboard"], signal);
  return "failure" in found ? { failure: found.failure } : { version: found.version };
}

/**
 * Whether npm publishes `version` of allaboard. An unknown version is `false`; npm that cannot
 * answer is the failure. A string that is no version is not asked about.
 */
export async function publishedVersion(
  run: RunAsync,
  version: string,
  signal?: AbortSignal,
): Promise<{ published: boolean } | { failure: NpmFailure }> {
  if (!isVersion(version)) return { published: false };
  const found = await viewed(run, [`allaboard@${version}`], signal);
  if ("version" in found) return { published: found.version === version };
  // The code of npm's refusal, not an exit status: an unknown version and a package that does
  // not exist both print E404.
  return /^npm error code E404\s*$/m.test(found.result.stderr)
    ? { published: false }
    : { failure: found.failure };
}

/** Why the running copy is not one an update can replace. */
export type Refusal =
  /** It is not `<npm root -g>/allaboard`; `folder` is the package folder it runs from. */
  | { kind: "not-global"; folder: string }
  /** `npm link` made `<npm root -g>/allaboard`: a link to a checkout, not an install. */
  | { kind: "link" }
  /** Its version is not on npm. */
  | { kind: "unpublished"; version: string }
  /** npm could not say. */
  | { kind: "npm"; failure: NpmFailure };

/** The real path of `path`, or `path` itself when it cannot be resolved. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Whether the copy that runs from `main` (the real path of its `dist/main.js`) at `version` is
 * the one `npm install -g allaboard` replaces: `<npm root -g>/allaboard` by real path, not a link,
 * its version published. Returns its package folder, else the refusal. `version` is the one the
 * process read at its start: after an install the copy's `package.json` holds the next one.
 */
export async function updatableCopy(
  run: RunAsync,
  main: string,
  version: string,
  signal?: AbortSignal,
): Promise<{ copy: string } | { refusal: Refusal }> {
  const rooted = await run("npm", ["root", "-g"], signal);
  if (rooted.status !== 0) return { refusal: { kind: "npm", failure: classifyFailure(rooted) } };
  const root = real(rooted.stdout.trim());
  const copy = join(root, "allaboard");
  const own = real(main);
  const running = copyOf(own);
  try {
    // `npm link` makes the global folder a link to the checkout; the process then runs from the
    // checkout, which is where the link points.
    if (lstatSync(copy).isSymbolicLink() && real(copy) === running) {
      return { refusal: { kind: "link" } };
    }
  } catch {}
  if (own !== join(copy, "dist", "main.js")) {
    return { refusal: { kind: "not-global", folder: running } };
  }
  const published = await publishedVersion(run, version, signal);
  if ("failure" in published) return { refusal: { kind: "npm", failure: published.failure } };
  return published.published ? { copy } : { refusal: { kind: "unpublished", version } };
}

/**
 * How an install ended: `installed` with the version the copy now holds; `mismatch` when npm
 * ended well and the copy holds another version (`found`), or none that can be read (null: a
 * killed npm leaves no `package.json`); `failed` with the classification.
 */
export type InstallResult =
  | { kind: "installed"; version: string }
  | { kind: "mismatch"; found: string | null }
  | { kind: "failed"; failure: NpmFailure };

/**
 * Runs `npm install -g allaboard@<version>` over the copy in `copy` and reads that copy's
 * `package.json` again. Throws a RangeError, with nothing run, for a `version` that is not an
 * exact version. npm's own words go to the log; the result carries only what they classify. An
 * install that `signal` ended is npm's own rollback (measured 2026-10-17: it finishes its current
 * step, puts the old folder back and ends with 1): a failure, the copy as it was.
 */
export async function installVersion(
  run: RunAsync,
  copy: string,
  version: string,
  signal?: AbortSignal,
): Promise<InstallResult> {
  if (!isVersion(version))
    throw new RangeError(`not a version to install: ${JSON.stringify(version)}`);
  const result = await run("npm", ["install", "-g", `allaboard@${version}`], signal);
  if (result.status !== 0) {
    const failure = classifyFailure(result);
    logger.error(
      `npm install allaboard@${version} failed with status ${result.status}: ${result.stderr.trim().slice(0, 4000)}`,
    );
    return { kind: "failed", failure };
  }
  const found = packageVersion(join(copy, "package.json"));
  return found === version ? { kind: "installed", version } : { kind: "mismatch", found };
}
