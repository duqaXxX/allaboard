/**
 * `Transcript`: what a session's own process appends to its transcript, read from where the
 * session started, on real files. The entries are those of `goal-lifecycle-store.json` (recorded
 * 2026-10-20, SDK 0.3.304, `entrypoint` `sdk-ts`).
 */
import assert from "node:assert/strict";
import { appendFile, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { projectKey } from "../../../src/agent/claude/listing.ts";
import { NotAFileError, ownEntry, Transcript } from "../../../src/agent/claude/transcript.ts";
import { type JsonObject, sdkJson } from "../../support/fixtures.ts";

const SESSION = "68da9311-0000-4000-8000-000000000001";
const ENTRIES = (sdkJson("goal-lifecycle-store") as Array<{ entries: JsonObject[] }>)
  .flatMap((append) => append.entries)
  .filter(ownEntry);
const [FIRST, SECOND, THIRD] = ENTRIES as [JsonObject, JsonObject, JsonObject];

const lines = (...entries: JsonObject[]): string =>
  entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");

/** The read of the next record, as the session does it: up to where the file reached as it came. */
const next = (transcript: Transcript): Promise<unknown[]> => transcript.read(transcript.mark());

/** A projects directory and a folder whose transcripts it holds, removed when the test ends. */
async function stage(t: TestContext): Promise<{ projects: string; folder: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), "transcript-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, "app");
  const projects = join(root, "projects");
  await mkdir(folder);
  const project = join(projects, await projectKey(folder));
  await mkdir(project, { recursive: true });
  return { projects, folder, file: join(project, `${SESSION}.jsonl`) };
}

test("the recording's goal entries were written under the SDK's own entrypoint", () => {
  assert.equal(ENTRIES.length, 5);
});

test("a resumed session reads what is appended after it opened, not what was there", async (t) => {
  const { projects, folder, file } = await stage(t);
  await writeFile(file, lines(FIRST));
  const transcript = await Transcript.open(projects, folder, SESSION);
  assert.deepEqual(await next(transcript), []);
  await appendFile(file, lines(SECOND, THIRD));
  assert.deepEqual(await next(transcript), [SECOND, THIRD]);
  assert.deepEqual(await next(transcript), []);
});

test("a new session reads nothing before the stream names it, then from the start", async (t) => {
  const { projects, folder, file } = await stage(t);
  const transcript = await Transcript.open(projects, folder, null);
  assert.deepEqual(await next(transcript), []);
  transcript.locate(SESSION);
  // Not written yet: nothing, and no error.
  assert.equal(transcript.mark(), 0);
  assert.deepEqual(await next(transcript), []);
  await writeFile(file, lines(FIRST));
  assert.deepEqual(await next(transcript), [FIRST]);
  // The first id the stream gives holds.
  transcript.locate("68da9311-0000-4000-8000-000000000002");
  await appendFile(file, lines(SECOND));
  assert.deepEqual(await next(transcript), [SECOND]);
});

test("a folder with no transcripts yet is found once Claude Code makes it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "transcript-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, "app");
  await mkdir(folder);
  const projects = join(root, "projects");
  const transcript = await Transcript.open(projects, folder, null);
  transcript.locate(SESSION);
  assert.deepEqual(await next(transcript), []);
  const project = join(projects, await projectKey(folder));
  await mkdir(project, { recursive: true });
  await writeFile(join(project, `${SESSION}.jsonl`), lines(FIRST));
  assert.deepEqual(await next(transcript), [FIRST]);
});

test("the read for a record stops where the transcript reached when the record came", async (t) => {
  const { projects, folder, file } = await stage(t);
  const transcript = await Transcript.open(projects, folder, null);
  transcript.locate(SESSION);
  await writeFile(file, lines(FIRST));
  const first = transcript.mark();
  // Written after the record came, before its read ran: the next record's.
  await appendFile(file, lines(SECOND));
  assert.deepEqual(await transcript.read(first), [FIRST]);
  assert.deepEqual(await next(transcript), [SECOND]);
  assert.deepEqual(await next(transcript), []);
});

test("a record with no mark delivers nothing: its lines come with the next one that has one", async (t) => {
  const { file } = await stage(t);
  // Where the file is is not known yet, so the record cannot be measured.
  const transcript = new Transcript(async () => file, { session: SESSION });
  assert.equal(transcript.mark(), null);
  await writeFile(file, lines(FIRST, SECOND));
  assert.deepEqual(await transcript.read(null), []);
  assert.deepEqual(await next(transcript), [FIRST, SECOND]);
});

test("a line still being written is read once it ends, a character cut in two included", async (t) => {
  const { file } = await stage(t);
  const transcript = new Transcript(async () => file, { session: SESSION, path: file });
  const entry = { ...FIRST, condition: "caffè ☕" };
  const bytes = Buffer.from(lines(entry));
  // Cut inside the three bytes of the cup.
  const cut = bytes.indexOf(Buffer.from("☕")) + 1;
  await writeFile(file, bytes.subarray(0, cut));
  assert.deepEqual(await next(transcript), []);
  await appendFile(file, bytes.subarray(cut));
  assert.deepEqual(await next(transcript), [entry]);
});

test("entries of the terminal, an editor, a `claude -p` and no process at all are left out", async (t) => {
  const { file } = await stage(t);
  const transcript = new Transcript(async () => file, { session: SESSION, path: file });
  const { entrypoint: _, ...unnamed } = FIRST;
  await writeFile(
    file,
    lines(
      { ...FIRST, entrypoint: "cli" },
      { ...FIRST, entrypoint: "claude-desktop" },
      { ...FIRST, entrypoint: "claude-vscode" },
      { ...FIRST, entrypoint: "sdk-cli" },
      unnamed,
      SECOND,
    ),
  );
  assert.deepEqual(await next(transcript), [SECOND]);
});

test("a line that is not JSON is skipped and the next ones are read", async (t) => {
  const { file } = await stage(t);
  const transcript = new Transcript(async () => file, { session: SESSION, path: file });
  await writeFile(file, `not json\n\n${lines(FIRST)}`);
  assert.deepEqual(await next(transcript), [FIRST]);
});

test("a transcript rewritten shorter is read on from its new end", async (t) => {
  const { file } = await stage(t);
  const transcript = new Transcript(async () => file, { session: SESSION, path: file });
  await writeFile(file, lines(FIRST, SECOND, THIRD));
  assert.deepEqual(await next(transcript), [FIRST, SECOND, THIRD]);
  await writeFile(file, lines(FIRST));
  assert.deepEqual(await next(transcript), []);
  await appendFile(file, lines(SECOND));
  assert.deepEqual(await next(transcript), [SECOND]);
});

test("a folder where the transcript should be rejects, on every platform", async (t) => {
  const { file } = await stage(t);
  await mkdir(file);
  const transcript = new Transcript(async () => file, { session: SESSION, path: file });
  await assert.rejects(next(transcript), NotAFileError);
});

test("a start whose size could not be read is settled by the file, never by a mark", async (t) => {
  const { file } = await stage(t);
  const transcript = new Transcript(async () => file, {
    session: SESSION,
    offset: null,
    path: file,
  });
  // Not there: a missing file is not taken for one with nothing in it yet.
  assert.equal(transcript.mark(), null);
  await writeFile(file, lines(FIRST));
  const stale = transcript.mark();
  await appendFile(file, lines(SECOND));
  // Opened at its whole size: what it held is not told for new lines, even past the mark.
  assert.deepEqual(await transcript.read(stale), []);
  await appendFile(file, lines(THIRD));
  assert.deepEqual(await next(transcript), [THIRD]);
});

// A folder whose mode is 000 stops a `stat` of what is in it, except for root and on Windows.
const NO_DENIED_STAT =
  process.platform === "win32" || process.getuid?.() === 0
    ? "a mode of 000 does not stop root or Windows"
    : false;

test("a resumed session whose folder could not be looked at never replays its file", {
  skip: NO_DENIED_STAT,
}, async (t) => {
  const { projects, folder, file } = await stage(t);
  await writeFile(file, lines(FIRST, SECOND));
  await chmod(projects, 0o000);
  let transcript: Transcript;
  try {
    transcript = await Transcript.open(projects, folder, SESSION);
  } finally {
    await chmod(projects, 0o755);
  }
  transcript.locate(SESSION);
  assert.deepEqual(await next(transcript), []);
  await appendFile(file, lines(THIRD));
  assert.deepEqual(await next(transcript), [THIRD]);
});

test("a resumed transcript that is a link is not read from its start", {
  skip: process.platform === "win32" && "a link needs a privilege on Windows",
}, async (t) => {
  const { projects, folder, file } = await stage(t);
  const real = join(folder, "elsewhere.jsonl");
  await writeFile(real, lines(FIRST));
  await symlink(real, file);
  // The size of a link is not read and the link is not followed (`O_NOFOLLOW`): the read fails,
  // and none of what the file held is taken for the process's.
  const transcript = await Transcript.open(projects, folder, SESSION);
  await assert.rejects(next(transcript));
});

test("a new session's file found away from where it was looked for is read from its start", async (t) => {
  const { folder, file } = await stage(t);
  // A long folder name may be hashed otherwise by Claude Code: the file is not in `project`.
  const transcript = new Transcript(async () => file, { project: join(folder, "elsewhere") });
  transcript.locate(SESSION);
  await writeFile(file, lines(FIRST));
  assert.deepEqual(await next(transcript), []);
  assert.deepEqual(await next(transcript), [FIRST]);
});

test("a mark taken while the file cannot be looked at never sends a read back, nor a line ahead", {
  skip: NO_DENIED_STAT,
}, async (t) => {
  const { file } = await stage(t);
  const folder = join(file, "..");
  const transcript = new Transcript(async () => file, { session: SESSION, path: file });
  // Each record's mark is taken as it comes, before the reads in line run.
  await writeFile(file, lines(FIRST));
  const first = transcript.mark();
  await appendFile(file, lines(SECOND));
  await chmod(folder, 0o000);
  const unmeasured = transcript.mark();
  await chmod(folder, 0o755);
  await appendFile(file, lines(THIRD));
  const third = transcript.mark();
  assert.equal(unmeasured, null);
  // Each line once, in order, and none before the record that came after it was written.
  assert.deepEqual(await transcript.read(first), [FIRST]);
  assert.deepEqual(await transcript.read(unmeasured), []);
  assert.deepEqual(await transcript.read(third), [SECOND, THIRD]);
});

test("a file that cannot be looked at for good makes every read fail", {
  skip: NO_DENIED_STAT,
}, async (t) => {
  const { file } = await stage(t);
  const folder = join(file, "..");
  const transcript = new Transcript(async () => file, { session: SESSION, path: file });
  await writeFile(file, lines(FIRST));
  assert.deepEqual(await next(transcript), [FIRST]);
  await chmod(folder, 0o000);
  try {
    await assert.rejects(next(transcript));
    await assert.rejects(next(transcript));
  } finally {
    // Before the folder is removed (`stage`).
    await chmod(folder, 0o755);
  }
});

test("a resumed session whose file was missing at the start never replays what comes there", async (t) => {
  const { projects, folder, file } = await stage(t);
  // Missing when the session starts, there when Claude Code loads it: what it holds is old.
  const transcript = await Transcript.open(projects, folder, SESSION);
  await writeFile(file, lines(FIRST, SECOND));
  assert.deepEqual(await next(transcript), []);
  await appendFile(file, lines(THIRD));
  assert.deepEqual(await next(transcript), [THIRD]);
});
