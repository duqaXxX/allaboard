/**
 * Does allaboard still work on this @anthropic-ai/claude-agent-sdk release?
 *
 *     node probe/main.ts            run if the pinned SDK is not certified yet
 *     node probe/main.ts --force    run anyway
 *     node probe/main.ts --full     record every family of messages too (`families.ts`), which a
 *                                   run otherwise does when its scenes find a difference, the
 *                                   SDK's message types changed, or the last one is a week old
 *     node probe/main.ts --latest   run on the newest release on npm, in a temporary worktree
 *     node probe/main.ts --surface  check docs/sdk-surface.md and the bundled CLI's variables
 *                                   (CLI_VARIABLES), and list the table's rows: no tokens
 *     node probe/main.ts --commands list the commands that are new or gone on this release: no tokens
 *     node probe/main.ts --surface --from <sdk.d.ts>
 *                                   also list what this release adds to or removes from the
 *                                   declarations in that file, and the rows that rest on it
 *
 * It uses the owner's Claude Code login and real tokens (Haiku), which is why it is not part of
 * the test suite. Exit status: 0 certified, 3 a claim or a row of the SDK surface is BROKEN, or
 * the bundled CLI no longer names a variable the daemon sets or cannot be read, 4 the stream
 * carries a shape the fixtures do not, 2 not every gesture claim could be proven; 1 is Node's own,
 * for a crash.
 *
 * Each claim is also sorted against the facts stored for the newest certified release below the
 * probed one (`probe/observations/<version>.json`): changed, no longer supported, newly supported,
 * not proven, no baseline, unchanged or retired. A changed claim does not move the exit status; the
 * report lists it first. A limit claim that no longer holds is newly supported: the report asks
 * for a change of docs/limits.md, and the exit status and the certificate are as without it. An
 * already certified release prints that report again from what was stored.
 *
 * A run that probes an uncertified release also prints Claude Code's changelog (`changelog.ts`)
 * from the CLI of that baseline to the CLI under test, every entry, after the claims.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { byVersion, changelogBetween, fetchChangelog } from "./changelog.ts";
import {
  broken,
  type Certificate,
  CLAIMS,
  canCertify,
  certificate,
  checklist,
  evaluate,
  type Outcome,
  type Result,
  result,
} from "./claims.ts";
import {
  type Changes,
  changes,
  report as commandsReport,
  offeredNow,
  recorded,
} from "./commands.ts";
import { report as diffReport, diffSurface, matches, readSurface } from "./diff.ts";
import { familiesReport, runFamilies } from "./families.ts";
import { byHand, features } from "./features.ts";
import { readLimits } from "./limits.ts";
import { runScenes } from "./scenes.ts";
import { differences, fixtureRecords, loadAccepted, shapesReport } from "./shapes.ts";
import {
  check as checkSurface,
  cliReport,
  installedDeclarations,
  loadSurface,
  messageTypes,
  missingFromCli,
  readReference,
  setAside,
  report as surfaceReport,
} from "./surface.ts";
import {
  classify,
  groupedReport,
  type Observations,
  observationsOf,
  readObservations,
  writeObservations,
} from "./verdicts.ts";

const REPO = join(import.meta.dirname, "..");
const CERTIFIED = join(import.meta.dirname, "certified-versions.json");
// What each certified release's claims saw, one file per SDK version: the next release's baseline.
const OBSERVATIONS = join(import.meta.dirname, "observations");
const PACKAGE = "@anthropic-ai/claude-agent-sdk";
const REGISTRY = `https://registry.npmjs.org/${PACKAGE}/latest`;
const CERTIFICATE_KEYS = ["cli", "date", "holds", "open", "retired"];
// Written only when a limit fell.
const OPTIONAL_CERTIFICATE_KEYS = ["fell"];
// Beside the certificate it is kept with: a run in a worktree writes to the checkout's.
const FULL_FILE = "full-recording.json";
const FULL_EVERY_DAYS = 7;

/** The last full recording that ran every family: its day, its release and the SDK's message types. */
export interface FullRecording {
  readonly date: string;
  readonly sdk: string;
  readonly cli: string;
  readonly types: readonly string[];
}

/** The last full recording, null when none ran; throws on a file that is not its shape. */
export function lastFull(path: string): FullRecording | null {
  if (!existsSync(path)) return null;
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  const shaped =
    typeof value === "object" &&
    value !== null &&
    "date" in value &&
    typeof value.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.date) &&
    "sdk" in value &&
    typeof value.sdk === "string" &&
    "cli" in value &&
    typeof value.cli === "string" &&
    "types" in value &&
    Array.isArray(value.types) &&
    value.types.every((type) => typeof type === "string");
  if (!shaped) throw new RangeError(`${path} is not a date, an sdk, a cli and the message types`);
  return value as FullRecording;
}

/**
 * Why this run records every family as well (`families.ts`), or null when the scenes are enough:
 * asked for, a difference the scenes found, message types the last full recording did not know,
 * or a full recording older than FULL_EVERY_DAYS.
 */
export function fullDue(
  last: FullRecording | null,
  types: readonly string[],
  found: number,
  forced: boolean,
  today: string,
): string | null {
  if (forced) return "asked with --full";
  if (found > 0) return "the scenes found a shape the fixtures do not hold";
  if (last === null) return "no full recording has run yet";
  if ([...types].sort().join() !== [...last.types].sort().join()) {
    return "the SDK's message types changed since the last full recording";
  }
  const days = Math.floor((Date.parse(today) - Date.parse(last.date)) / 86_400_000);
  if (days >= FULL_EVERY_DAYS) return `the last full recording is ${days} days old`;
  return null;
}

function log(line: string): void {
  process.stderr.write(`${line}\n`);
}

type Certificates = Record<string, Certificate>;

/**
 * The certificates, by SDK version. Throws on a file of another shape, which a hand edit or an
 * interrupted write could leave: a certificate is never trusted on its looks.
 */
export function certified(path: string): Certificates {
  if (!existsSync(path)) return {};
  const known: unknown = JSON.parse(readFileSync(path, "utf8"));
  const name = path.split("/").at(-1);
  const entries =
    typeof known === "object" && known !== null && !Array.isArray(known)
      ? Object.values(known)
      : null;
  const shaped = entries?.every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      CERTIFICATE_KEYS.every((key) => key in entry) &&
      // A string would make `includes` match a prefix of an id: `L10` for `L1`.
      (!("fell" in entry) || isStrings(entry.fell)) &&
      Object.keys(entry).every(
        (key) => CERTIFICATE_KEYS.includes(key) || OPTIONAL_CERTIFICATE_KEYS.includes(key),
      ),
  );
  if (!shaped)
    throw new RangeError(`${name} is not a map of SDK versions to ${CERTIFICATE_KEYS.join(", ")}`);
  return known as Certificates;
}

/**
 * `packageJson` with the SDK pinned to `release`. Throws unless exactly one exact pin was
 * replaced: a pin written another way would leave the old SDK installed, and the probe would
 * certify a release it never ran.
 */
export function pinnedTo(packageJson: string, release: string): string {
  const pin = new RegExp(`("${PACKAGE.replace("/", "\\/")}"\\s*:\\s*")[0-9][0-9.]*"`, "g");
  const replaced = [...packageJson.matchAll(pin)].length;
  if (replaced !== 1) throw new RangeError(`expected one ${PACKAGE} exact pin, found ${replaced}`);
  return packageJson.replace(pin, `$1${release}"`);
}

/** Whether `value` is a list of strings. */
function isStrings(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** The SDK and the Claude Code it bundles, as the package in `root` declares them. */
function installed(root: string): { sdk: string; cli: string } {
  const manifest: unknown = JSON.parse(
    readFileSync(join(root, "node_modules", PACKAGE, "package.json"), "utf8"),
  );
  const { version, claudeCodeVersion } = manifest as {
    version?: unknown;
    claudeCodeVersion?: unknown;
  };
  if (typeof version !== "string" || typeof claudeCodeVersion !== "string") {
    throw new RangeError(`${PACKAGE} declares no version or no claudeCodeVersion`);
  }
  return { sdk: version, cli: claudeCodeVersion };
}

/** The newest release on the npm registry. */
async function latestRelease(): Promise<string> {
  const response = await fetch(REGISTRY, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`the npm registry answered ${response.status}`);
  const { version } = (await response.json()) as { version?: unknown };
  if (typeof version !== "string") throw new RangeError("the npm registry named no version");
  return version;
}

/** Where a checkout's installed package keeps its declarations. */
function declarationsOf(root: string): string {
  return join(root, "node_modules", PACKAGE, "sdk.d.ts");
}

/**
 * What the installed release adds to or removes from the declarations in `from`, and the limit
 * and feature rows that rest on a changed name or command; empty when nothing differs, null when
 * a file or a cell could not be read (one line says why).
 */
export function addedToSdk(from: string, found: Changes): string | null {
  // Never a reason to stop a run or to change its status: the block is a look, so a file or a
  // cell that cannot be read costs the block and one line.
  try {
    const diff = diffSurface(
      readSurface(readFileSync(from, "utf8")),
      readSurface(readFileSync(declarationsOf(REPO), "utf8")),
    );
    const limits = readLimits().map((row) => ({ ...row, feature: false }));
    const rows = [...limits, ...features().map((row) => ({ ...row, feature: true }))];
    const unreadable = rows.find((row) => row.restsOnError !== null);
    if (unreadable) throw new Error(unreadable.restsOnError ?? "");
    return diffReport(diff, matches(rows, diff, found));
  } catch (error) {
    log(
      `what the release adds cannot be listed: ${error instanceof Error ? error.message : error}`,
    );
    return null;
  }
}

/** The environment of a git command: the variables a hook sets must not point it elsewhere. */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[name];
  return env;
}

/** The newest certified release below `sdk`: what a run of `sdk` is compared with (null: none). */
export function baselineOf(known: Certificates, sdk: string): string | null {
  const below = Object.keys(known).filter((version) => byVersion(version, sdk) < 0);
  return below.sort(byVersion).at(-1) ?? null;
}

/**
 * Claude Code's changelog from the CLI of the baseline certificate to `cli`, unfiltered; empty
 * when it cannot be had (one line says why).
 */
export async function changelogOf(
  known: Certificates,
  from: string | null,
  cli: string,
): Promise<string> {
  // Never a reason to stop a run or to change its status: the block is a look.
  const baseline = from === null ? undefined : known[from]?.cli;
  if (baseline === undefined)
    return "No certified release below this one: no changelog range to show.";
  try {
    return changelogBetween(await fetchChangelog(), baseline, cli);
  } catch (error) {
    log(
      `Claude Code's changelog cannot be listed: ${error instanceof Error ? error.message : error}`,
    );
    return "";
  }
}

function sorted(known: Certificates): Certificates {
  return Object.fromEntries(Object.entries(known).sort(([a], [b]) => byVersion(a, b)));
}

/**
 * Runs the probe on the newest SDK in a detached worktree of HEAD, the way the release watch
 * moves the pin; the certificate is written to this checkout, the pin here is left alone.
 */
async function onLatest(force: boolean, full: boolean): Promise<number> {
  const latest = await latestRelease();
  const { sdk: pinned } = installed(REPO);
  if (latest === pinned) {
    log(`${PACKAGE} ${pinned} is the newest release`);
    return run({
      certificates: CERTIFIED,
      observations: OBSERVATIONS,
      force,
      full,
      pinnedDeclarations: null,
    });
  }
  log(`${PACKAGE} ${latest} is out (pinned ${pinned}); probing it in a temporary worktree`);
  const parent = mkdtempSync(join(tmpdir(), "allaboard-probe-worktree-"));
  const tree = join(parent, "tree");
  const inherit = { stdio: "inherit" as const };
  try {
    const added = spawnSync("git", ["worktree", "add", "--detach", tree], {
      cwd: REPO,
      env: gitEnv(),
      ...inherit,
    });
    if (added.status !== 0) throw new Error("git worktree add failed");
    try {
      const install = spawnSync(
        "npm",
        ["install", "--save-exact", "--no-audit", "--no-fund", `${PACKAGE}@${latest}`],
        {
          cwd: tree,
          ...inherit,
        },
      );
      if (install.status !== 0) throw new Error("npm install failed");
      // The pin and the package in the tree are the release this run says it probes.
      const manifest = readFileSync(join(tree, "package.json"), "utf8");
      if (pinnedTo(manifest, latest) !== manifest || installed(tree).sdk !== latest) {
        throw new Error(`the worktree does not hold ${PACKAGE} ${latest}`);
      }
      const command = [
        join(tree, "probe", "main.ts"),
        "--certificate",
        CERTIFIED,
        "--observations",
        OBSERVATIONS,
        "--pinned-declarations",
        declarationsOf(REPO),
        ...(force ? ["--force"] : []),
        ...(full ? ["--full"] : []),
      ];
      return spawnSync(process.execPath, command, { cwd: tree, ...inherit }).status ?? 1;
    } finally {
      // Not checked: a failed removal must not hide why the run above failed.
      const removed = spawnSync("git", ["worktree", "remove", "--force", tree], {
        cwd: REPO,
        env: gitEnv(),
      });
      if (removed.status !== 0) log(`could not remove the worktree: run \`git worktree prune\``);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

/** Where a run keeps and finds what it compares, and what it was asked. */
interface RunOptions {
  /** The certificates file. */
  readonly certificates: string;
  /** The folder of observation files; a run in a worktree reads and writes the checkout's. */
  readonly observations: string;
  readonly force: boolean;
  readonly full: boolean;
  /** The older release's `sdk.d.ts` to diff against, null when the run has none. */
  readonly pinnedDeclarations: string | null;
}

/**
 * The grouped report of `results` against the observations of the newest certified release
 * below `sdk`; reads one file and starts nothing.
 */
export function compared(
  results: readonly Result[],
  known: Certificates,
  observations: string,
  cli: string,
  sdk: string,
): string {
  const from = baselineOf(known, sdk);
  const baseline = {
    sdk: from,
    observations: from === null ? null : readObservations(observations, from),
  };
  const tiedTo = (id: string) =>
    features()
      .filter((f) => f.claims.includes(id))
      .map((f) => f.name);
  const checked = (id: string) =>
    readLimits()
      .filter((row) => row.checkedBy.includes(id))
      .map((row) => `"${row.name}": ${row.text}`);
  return groupedReport(
    classify(results, baseline.observations),
    cli,
    sdk,
    baseline,
    tiedTo,
    checked,
  );
}

/** The results a certificate stored for its release, with the facts of that release's observations. */
export function storedResults(entry: Certificate, stored: Observations): Result[] {
  const outcomes: [readonly string[], Outcome][] = [
    [entry.holds, "HOLDS"],
    [entry.open, "UNPROVEN"],
    [entry.retired, "RETIRED"],
    [entry.fell ?? [], "FELL"],
  ];
  return CLAIMS.flatMap((subject) => {
    const found = outcomes.find(([ids]) => ids.includes(subject.id));
    return found ? [result(subject, found[1], "", stored.claims[subject.id])] : [];
  });
}

async function run(options: RunOptions): Promise<number> {
  const { certificates: path, force, full } = options;
  const { sdk, cli } = installed(REPO);
  const known = certified(path);
  // Keyed by the SDK release: a new one can bundle a certified CLI and still change the
  // TypeScript side (its message types, `query`).
  const entry = known[sdk];
  if (entry && !force) {
    // The comparison of the run that certified it, rebuilt from what was stored: it is the only
    // place the changes of a release are read once that run is over.
    const facts = readObservations(options.observations, sdk);
    console.log(
      facts
        ? compared(storedResults(entry, facts), known, options.observations, cli, sdk)
        : `No observations stored for ${sdk}: its comparison cannot be shown`,
    );
    log(`${PACKAGE} ${sdk} (Claude Code ${cli}) is already certified`);
    return 0;
  }
  // Read before the scenes: a broken map stops the run before it spends tokens, and cannot
  // come between a finished run and its verdict.
  const left = byHand();
  // The limits page too: a cell nobody can read stops the run before the scenes.
  readLimits();
  // The baseline too: a malformed file stops the run here, at no cost.
  const from = baselineOf(known, sdk);
  if (from !== null) readObservations(options.observations, from);
  // The SDK surface map, on the release this run is on: a symbol the package no longer defines
  // needs no scene to be known, so it stops the run here.
  const mapped = checkSurface(loadSurface(), await readReference(), setAside());
  console.log(`${surfaceReport(mapped)}\n`);
  if (mapped.broken) {
    console.log("Not certified: the package no longer defines a symbol the daemon uses.");
    return 3;
  }
  const unread = missingFromCli();
  console.log(`${cliReport(unread)}\n`);
  if (unread === null || unread.length > 0) {
    console.log(
      unread === null
        ? "Not certified: the bundled CLI could not be read for the variables the daemon sets."
        : "Not certified: the bundled CLI no longer names a variable the daemon sets.",
    );
    return 3;
  }
  // The commands of this release against the recorded list: a new one is typed in Slack from
  // the day the SDK is pinned. Read before the scenes, like the surface, and printed after the
  // claims: it asks for a look, and stops no certificate.
  const commandChanges = changes(await offeredNow(), recorded());
  const commands = commandsReport(commandChanges, cli);
  // Fetched while the scenes run, and never rejected: a slow host costs no wait of its own.
  const changelog = changelogOf(known, from, cli);
  // Read before the scenes too: what the release adds is a look for a person, never a verdict.
  const added =
    options.pinnedDeclarations === null
      ? ""
      : (addedToSdk(options.pinnedDeclarations, commandChanges) ?? "");
  // The fixtures and the accepted shapes, read before the scenes for the same reason as the map.
  const fixtures = fixtureRecords();
  const accepted = loadAccepted();
  const fullPath = join(dirname(path), FULL_FILE);
  const last = lastFull(fullPath);
  const types = messageTypes(installedDeclarations());
  const records: unknown[] = [];
  const seen = await runScenes(log, records);
  const results = CLAIMS.map((claim) => evaluate(claim, seen[claim.id]));
  console.log(compared(results, known, options.observations, cli, sdk));
  console.log(`\n${commands}`);
  if (added) console.log(`\n${added}`);
  const entries = await changelog;
  if (entries) console.log(`\n${entries}`);
  // The streams the scenes produced against the fixtures: a shape no test has read stops the
  // certificate until its fixture is recorded again or the shape is accepted.
  let shapes = differences(records, fixtures, accepted);
  const today = new Date().toISOString().slice(0, 10);
  const due = fullDue(last, types, shapes.length, full, today);
  let families = "";
  if (due !== null) {
    log(`full recording: ${due}`);
    const runs = await runFamilies(log);
    shapes = differences([...records, ...runs.flatMap((one) => one.records)], fixtures, accepted);
    families = `\n${familiesReport(runs)}`;
    if (runs.every((one) => one.failed === null)) {
      writeFileSync(fullPath, `${JSON.stringify({ date: today, sdk, cli, types }, null, 2)}\n`);
    }
  }
  console.log(`\n${shapesReport(shapes, cli)}${families}`);
  const hand = checklist(results);
  if (hand) console.log(`\n${hand}`);
  // What no claim covers at all, from the coverage map: printed on every run, certified or not.
  if (left) console.log(`\n${left}`);
  if (broken(results)) {
    console.log("\nNot certified: a claim is BROKEN. Do not pin this release.");
    return 3;
  }
  if (shapes.length > 0) {
    console.log("\nNot certified: the stream carries a shape the fixtures do not.");
    return 4;
  }
  if (!canCertify(results)) {
    console.log("\nNot certified: a gesture claim could not be proven.");
    return 2;
  }
  // The facts first: a write that fails must not leave a certified version with no baseline.
  writeObservations(options.observations, sdk, observationsOf(results, cli, today));
  known[sdk] = certificate(results, cli, today);
  writeFileSync(path, `${JSON.stringify(sorted(known), null, 2)}\n`);
  console.log(`\nCertified: ${PACKAGE} ${sdk} added to ${path.split("/").at(-1)}.`);
  return 0;
}

/**
 * The SDK surface map against the installed release and the published reference, with the rows
 * a run only counts. It starts no session, so it spends nothing.
 */
async function showSurface(from: string | undefined): Promise<number> {
  const mapped = checkSurface(loadSurface(), await readReference(), setAside());
  console.log(surfaceReport(mapped, true));
  const unread = missingFromCli();
  console.log(cliReport(unread));
  if (from !== undefined) {
    // No session is started, so the commands of the release are not part of it.
    const added = addedToSdk(from, { new: [], gone: [] });
    if (added !== null) console.log(`\n${added || "The declarations are the same."}`);
  }
  return mapped.broken || unread === null || unread.length > 0 ? 3 : 0;
}

/**
 * The commands a session is offered on the installed release against the recorded list. It
 * starts Claude Code and sends no prompt, so it spends nothing.
 */
async function showCommands(): Promise<number> {
  console.log(commandsReport(changes(await offeredNow(), recorded()), installed(REPO).cli));
  return 0;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      force: { type: "boolean", default: false },
      latest: { type: "boolean", default: false },
      surface: { type: "boolean", default: false },
      commands: { type: "boolean", default: false },
      full: { type: "boolean", default: false },
      // Where the certificate is kept: the run in a worktree writes to the checkout's file.
      certificate: { type: "string", default: CERTIFIED },
      // Where the observations are kept: the run in a worktree reads and writes the checkout's.
      observations: { type: "string", default: OBSERVATIONS },
      // The older release's sdk.d.ts: a worktree run gets the pinned one, `--surface` any file.
      "pinned-declarations": { type: "string" },
      from: { type: "string" },
    },
  });
  if (values.surface) return showSurface(values.from);
  if (values.commands) return showCommands();
  return values.latest
    ? onLatest(values.force, values.full)
    : run({
        certificates: values.certificate,
        observations: values.observations,
        force: values.force,
        full: values.full,
        pinnedDeclarations: values["pinned-declarations"] ?? null,
      });
}

// `import.meta.main`, as `src/main.ts` did before it became a Node-version check: `--latest` starts this file in a worktree under
// macOS's tmpdir, a `/var` that links to `/private/var`, where `process.argv[1]` and the module's
// own path differ and a comparison of the two would skip `main` and exit 0.
if (import.meta.main) {
  process.exit(await main());
}
