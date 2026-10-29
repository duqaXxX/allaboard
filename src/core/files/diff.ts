/**
 * What `!diff` shows: the files that differ between the working tree and HEAD, untracked files
 * that are not ignored included (the terminal's `Current` view), and one file's unified diff.
 *
 * Plumbing only, and never an external diff or a textconv: the index is not refreshed or written
 * (see `changesOf` in `footer.ts`). The repository is one the owner trusted, and its own clean
 * filters still run when git compares a file with the index, as for the footer's counts.
 */

import type { FileChange, Repository } from "../../agent/seam.ts";
import { type Clock, monotonicClock } from "../../clock.ts";
import { compareCodePoints, strip } from "../../text.ts";
import { GIT_TIMEOUT, runGit } from "../footer.ts";
import { NotAFile, readOpenable, TooLarge } from "./read.ts";
import { TIMED_OUT, within } from "./waiting.ts";

/** One changed file: its path from the repository's root, and its lines added and removed. */
export interface DiffStat {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  /** Git (or the first bytes of an untracked file) takes it for binary: it has no text diff. */
  readonly binary: boolean;
}

/**
 * One file's diff. Empty `text` with `binary` and `large` false: the file is no longer changed.
 * `large`: the diff is over the limit asked for, and nothing of it is kept.
 */
export interface DiffPatch {
  readonly binary: boolean;
  readonly text: string;
  readonly large: boolean;
}

/** The most an untracked file is read for, in bytes: a larger one is listed as having no text diff. */
export const UNTRACKED_LIMIT = 1_048_576;

// Variables of an outer git are removed by `runGit`; these are git's own safe-reading flags.
const LITERAL = ["--literal-pathspecs", "--no-optional-locks"];
// A submodule counts by its commit alone: without `--ignore-submodules=dirty` git runs `git status` inside
// every dirty one, under that submodule's own config and filters (see `changesOf` in `footer.ts`).
const NO_FILTERS = ["--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=dirty"];

/** What to compare the work tree with: HEAD, or the empty tree while the repository has no commit. */
async function baseOf(repository: Repository, signal: AbortSignal): Promise<string | null> {
  const head = await runGit(
    repository,
    [...LITERAL, "rev-parse", "--verify", "--quiet", "HEAD"],
    signal,
  );
  if (head !== null) return "HEAD";
  const empty = await runGit(repository, ["hash-object", "-t", "tree", "/dev/null"], signal);
  return empty === null ? null : strip(empty) || null;
}

async function untrackedPaths(
  repository: Repository,
  signal: AbortSignal,
  path?: string,
): Promise<string[] | null> {
  const out = await runGit(
    repository,
    [
      ...LITERAL,
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      ...(path === undefined ? [] : ["--", path]),
    ],
    signal,
  );
  return out === null ? null : out.split("\0").filter((name) => name !== "");
}

/** The content of an untracked file, or null when it is no regular file or too large to read. */
async function contentOf(repository: Repository, path: string): Promise<Buffer | "large" | null> {
  try {
    return await readOpenable(repository.root, path, UNTRACKED_LIMIT);
  } catch (error) {
    if (error instanceof TooLarge) return "large";
    if (error instanceof NotAFile) return null;
    throw error;
  }
}

/** Git's own test for binary content: a NUL byte in the first 8000 bytes. */
function looksBinary(content: Buffer): boolean {
  return content.subarray(0, 8000).includes(0);
}

function linesOf(content: Buffer): string[] {
  const text = content.toString("utf8");
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The patch git would write for `path` as a file new to the repository. */
function newFilePatch(path: string, content: Buffer): string {
  const head = [`diff --git a/${path} b/${path}`, "new file mode 100644"];
  const lines = linesOf(content);
  if (lines.length === 0) return `${head.join("\n")}\n`;
  const body = [
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ];
  if (!content.toString("utf8").endsWith("\n")) body.push("\\ No newline at end of file");
  return `${[...head, ...body].join("\n")}\n`;
}

async function statsOf(repository: Repository, signal: AbortSignal): Promise<DiffStat[] | null> {
  const base = await baseOf(repository, signal);
  if (base === null) return null;
  const numstat = await runGit(
    repository,
    [...LITERAL, "diff-index", "--numstat", "-z", ...NO_FILTERS, base, "--"],
    signal,
  );
  if (numstat === null) return null;
  const rows: DiffStat[] = [];
  for (const entry of numstat.split("\0")) {
    const [added, removed, ...rest] = entry.split("\t");
    const path = rest.join("\t");
    if (added === undefined || removed === undefined || path === "") continue;
    const binary = added === "-";
    rows.push({
      path,
      added: binary ? 0 : Number(added),
      removed: binary ? 0 : Number(removed),
      binary,
    });
  }
  // `diff-index` does not refresh the index: a file git only sees as touched comes back with no
  // lines. It stays when its patch says something (a mode change, an empty file made or removed).
  const kept: DiffStat[] = [];
  for (const row of rows) {
    if (row.binary || row.added > 0 || row.removed > 0) {
      kept.push(row);
      continue;
    }
    const patch = await patchOf(repository, row.path, base, signal);
    if (patch !== null && patch !== "") kept.push(row);
  }
  const untracked = await untrackedPaths(repository, signal);
  if (untracked === null) return null;
  for (const path of untracked) {
    if (signal.aborted) return null;
    const content = await contentOf(repository, path);
    if (content === null) continue;
    if (content === "large" || looksBinary(content)) {
      kept.push({ path, added: 0, removed: 0, binary: true });
    } else {
      kept.push({ path, added: linesOf(content).length, removed: 0, binary: false });
    }
  }
  return kept.sort((a, b) => compareCodePoints(a.path, b.path));
}

async function patchOf(
  repository: Repository,
  path: string,
  base: string,
  signal: AbortSignal,
  maxBytes?: number,
): Promise<string | null> {
  return runGit(
    repository,
    [...LITERAL, "diff-index", "-p", ...NO_FILTERS, base, "--", path],
    signal,
    maxBytes,
  );
}

/**
 * The files of `repository` that differ from HEAD in the work tree, as paths from its root, sorted
 * by path. Null when git fails or runs over `GIT_TIMEOUT`.
 */
export async function diffStats(
  repository: Repository,
  clock: Clock = monotonicClock,
): Promise<DiffStat[] | null> {
  const found = await within(clock, GIT_TIMEOUT / 1000, (signal) => statsOf(repository, signal));
  return found === TIMED_OUT ? null : found;
}

async function patchFor(
  repository: Repository,
  path: string,
  limit: number,
  signal: AbortSignal,
): Promise<DiffPatch | null> {
  const none: DiffPatch = { binary: false, text: "", large: false };
  if (path === "" || path.includes("\0")) return none;
  const base = await baseOf(repository, signal);
  if (base === null) return null;
  const text = await patchOf(repository, path, base, signal, limit);
  if (text === null) return null;
  if (text !== "") {
    if (Buffer.byteLength(text) > limit) return { ...none, large: true };
    // git writes this line for a file it takes for binary, and no hunk.
    return /^Binary files .* differ$/m.test(text) && !text.includes("\n@@")
      ? { ...none, binary: true }
      : { ...none, text };
  }
  const untracked = await untrackedPaths(repository, signal, path);
  if (untracked === null) return null;
  if (!untracked.includes(path)) return none;
  const content = await contentOf(repository, path);
  if (content === null) return none;
  if (content === "large" || looksBinary(content)) return { ...none, binary: true };
  const made = newFilePatch(path, content);
  return Buffer.byteLength(made) > limit ? { ...none, large: true } : { ...none, text: made };
}

/**
 * The unified diff of `path` (from the repository's root) against HEAD; an untracked file's is a
 * new-file patch written here, since `git diff --no-index` exits 1 and `runGit` reads that as a
 * failure. `path` is a literal name. A diff over `limit` bytes (what the chat takes as one file)
 * is not collected: `large`. Null when git fails or runs over `GIT_TIMEOUT`.
 */
export async function diffPatch(
  repository: Repository,
  path: string,
  limit: number,
  clock: Clock = monotonicClock,
): Promise<DiffPatch | null> {
  const found = await within(clock, GIT_TIMEOUT / 1000, (signal) =>
    patchFor(repository, path, limit, signal),
  );
  return found === TIMED_OUT ? null : found;
}

// ---- what a turn edited, from the agent's own report of its calls

/** One file with everything a turn did to it, in order. */
export interface EditedFile {
  /** From the repository's root. */
  readonly path: string;
  readonly changes: readonly FileChange[];
}

/**
 * The files `changes` edited, each with its changes in the order they happened, sorted by path.
 * `locate` turns the path as the agent named it into one from the repository's root, or null for
 * a file outside the repository, which the terminal's diff does not cover either.
 */
export function groupEdits(
  changes: readonly FileChange[],
  locate: (path: string) => string | null,
): EditedFile[] {
  const files = new Map<string, FileChange[]>();
  for (const change of changes) {
    const path = locate(change.path);
    if (path === null) continue;
    const held = files.get(path);
    if (held === undefined) files.set(path, [change]);
    else held.push(change);
  }
  return [...files]
    .map(([path, held]) => ({ path, changes: held }))
    .sort((a, b) => compareCodePoints(a.path, b.path));
}

/** One hunk of a file's patch: where it starts, and its lines with their signs. */
interface PatchHunk {
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: readonly string[];
}

/**
 * The hunks one change contributes, as the patch holds them. A created file with no hunks of its
 * own is one hunk that adds its content.
 */
function hunksOfChange(change: FileChange): readonly PatchHunk[] {
  if (change.kind !== "created" || change.hunks.length > 0) return change.hunks;
  const content = change.content ?? "";
  const lines = linesOf(Buffer.from(content));
  if (lines.length === 0) return [];
  const added = lines.map((line) => `+${line}`);
  if (!content.endsWith("\n")) added.push("\\ No newline at end of file");
  return [{ oldStart: 0, newStart: 1, lines: added }];
}

/** A file's line counts: exactly the signs of the hunks `patchOfEdits` writes. */
export function statOfEdits(file: EditedFile): DiffStat {
  let added = 0;
  let removed = 0;
  for (const change of file.changes) {
    for (const hunk of hunksOfChange(change)) {
      for (const line of hunk.lines) {
        if (line.startsWith("+")) added += 1;
        else if (line.startsWith("-")) removed += 1;
      }
    }
  }
  return { path: file.path, added, removed, binary: false };
}

/**
 * The unified diff of what a turn did to one file: the hunks of every change in the order they
 * happened, a created file's content as a hunk that adds it. Two changes of one file are hunks
 * against the file as each found it, so the patch reads in order and does not apply as one.
 */
export function patchOfEdits(file: EditedFile): string {
  const [first] = file.changes;
  if (first === undefined) return "";
  const out = [`diff --git a/${file.path} b/${file.path}`];
  if (first.kind === "created") out.push("new file mode 100644", "--- /dev/null");
  else out.push(`--- a/${file.path}`);
  out.push(`+++ b/${file.path}`);
  for (const change of file.changes) {
    for (const hunk of hunksOfChange(change)) {
      const before = hunk.lines.filter((line) => !line.startsWith("+") && !line.startsWith("\\"));
      const after = hunk.lines.filter((line) => !line.startsWith("-") && !line.startsWith("\\"));
      out.push(
        `@@ -${hunk.oldStart},${before.length} +${hunk.newStart},${after.length} @@`,
        ...hunk.lines,
      );
    }
  }
  return `${out.join("\n")}\n`;
}
