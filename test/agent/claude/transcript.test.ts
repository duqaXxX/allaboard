/**
 * `Transcript`: what a session's own process appends to its transcript, read from where the
 * session started, on real files. The entries are those of `goal-lifecycle-store.json` (recorded
 * 2026-10-20, SDK 0.3.304, `entrypoint` `sdk-ts`).
 */
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { projectKey } from "../../../src/agent/claude/listing.ts";
import { ownEntry, Transcript } from "../../../src/agent/claude/transcript.ts";
import { type JsonObject, sdkJson } from "../../support/fixtures.ts";

const SESSION = "68da9311-0000-4000-8000-000000000001";
const ENTRIES = (sdkJson("goal-lifecycle-store") as Array<{ entries: JsonObject[] }>)
  .flatMap((append) => append.entries)
  .filter(ownEntry);
const [FIRST, SECOND, THIRD] = ENTRIES as [JsonObject, JsonObject, JsonObject];

const lines = (...entries: JsonObject[]): string =>
  entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");

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
  assert.deepEqual(await transcript.read(), []);
  await appendFile(file, lines(SECOND, THIRD));
  assert.deepEqual(await transcript.read(), [SECOND, THIRD]);
  assert.deepEqual(await transcript.read(), []);
});

test("a new session reads nothing before the stream names it, then from the start", async (t) => {
  const { projects, folder, file } = await stage(t);
  const transcript = await Transcript.open(projects, folder, null);
  assert.deepEqual(await transcript.read(), []);
  transcript.locate(SESSION);
  // Not written yet: nothing, and no error.
  assert.deepEqual(await transcript.read(), []);
  await writeFile(file, lines(FIRST));
  assert.deepEqual(await transcript.read(), [FIRST]);
  // The first id the stream gives holds.
  transcript.locate("68da9311-0000-4000-8000-000000000002");
  await appendFile(file, lines(SECOND));
  assert.deepEqual(await transcript.read(), [SECOND]);
});

test("a folder with no transcripts yet is found once Claude Code makes it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "transcript-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, "app");
  await mkdir(folder);
  const projects = join(root, "projects");
  const transcript = await Transcript.open(projects, folder, null);
  transcript.locate(SESSION);
  assert.deepEqual(await transcript.read(), []);
  const project = join(projects, await projectKey(folder));
  await mkdir(project, { recursive: true });
  await writeFile(join(project, `${SESSION}.jsonl`), lines(FIRST));
  assert.deepEqual(await transcript.read(), [FIRST]);
});

test("a line still being written is read once it ends, a character cut in two included", async (t) => {
  const { file } = await stage(t);
  const transcript = new Transcript(async () => file, SESSION);
  const entry = { ...FIRST, condition: "caffè ☕" };
  const bytes = Buffer.from(lines(entry));
  // Cut inside the three bytes of the cup.
  const cut = bytes.indexOf(Buffer.from("☕")) + 1;
  await writeFile(file, bytes.subarray(0, cut));
  assert.deepEqual(await transcript.read(), []);
  await appendFile(file, bytes.subarray(cut));
  assert.deepEqual(await transcript.read(), [entry]);
});

test("entries of the terminal, an editor, a `claude -p` and no process at all are left out", async (t) => {
  const { file } = await stage(t);
  const transcript = new Transcript(async () => file, SESSION);
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
  assert.deepEqual(await transcript.read(), [SECOND]);
});

test("a line that is not JSON is skipped and the next ones are read", async (t) => {
  const { file } = await stage(t);
  const transcript = new Transcript(async () => file, SESSION);
  await writeFile(file, `not json\n\n${lines(FIRST)}`);
  assert.deepEqual(await transcript.read(), [FIRST]);
});

test("a transcript rewritten shorter is read on from its new end", async (t) => {
  const { file } = await stage(t);
  const transcript = new Transcript(async () => file, SESSION);
  await writeFile(file, lines(FIRST, SECOND));
  assert.deepEqual(await transcript.read(), [FIRST, SECOND]);
  await writeFile(file, lines(FIRST));
  assert.deepEqual(await transcript.read(), []);
  await appendFile(file, lines(THIRD));
  assert.deepEqual(await transcript.read(), [THIRD]);
});

test("a transcript that cannot be read rejects", async (t) => {
  const { file } = await stage(t);
  await mkdir(file);
  const transcript = new Transcript(async () => file, SESSION);
  await assert.rejects(transcript.read());
});
