/**
 * The transcript lines a hidden command (`/model`, `/goal clear`) wrote stay hidden with its
 * records, whatever the reads of its records could measure (issue #145). Records and entries are
 * the recorded ones (`model-command.json`, `goal-lifecycle.jsonl`, `goal-lifecycle-store.json`).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { goalChange } from "../../../src/agent/claude/goals.ts";
import { ClaudeSession, type SessionConfig } from "../../../src/agent/claude/session.ts";
import { Transcript } from "../../../src/agent/claude/transcript.ts";
import type { Prompt, RequestHandler } from "../../../src/agent/seam.ts";
import { type FakeScript, FakeSdk, written } from "../../support/fake-query.ts";
import { type JsonObject, sdkJson, sdkRecords } from "../../support/fixtures.ts";

const LIMIT = { timeout: 10_000 };
const CONFIG: SessionConfig = {
  folder: "/srv/alice/app",
  resume: null,
  settingsSources: ["user", "project", "local"],
  model: null,
  effort: null,
  chrome: false,
};
const NO_REQUESTS: RequestHandler = {
  permission: async () => ({ allow: true }),
  question: async () => ({ answered: false, message: "skipped" }),
};
const PROMPT: Prompt = { id: "00000000-0000-4000-8000-0000000000b1", content: "Say ok" };
const TOOLS = sdkRecords("tools");
const MODEL_COMMAND = sdkJson("model-command") as JsonObject[];
const GOAL_RECORDS = sdkRecords("goal-lifecycle");
const CLEAR_TURN = GOAL_RECORDS.slice(
  GOAL_RECORDS.findLastIndex(
    (record) => record.type === "command_lifecycle" && record.state === "queued",
  ),
);
const CLEAR_STARTED = CLEAR_TURN.find((record) => record.state === "started") as JsonObject;
const STORE_ENTRIES = (sdkJson("goal-lifecycle-store") as Array<{ entries: JsonObject[] }>).flatMap(
  (append) => append.entries,
);
// The first goal set, which a turn after the command would write.
const GOAL_SET = STORE_ENTRIES.filter((entry) => goalChange(entry)?.state === "set").slice(0, 1);
const CLEARED = STORE_ENTRIES.filter(
  (entry) => (entry.attachment as JsonObject | undefined)?.sentinel === true,
).slice(-1);

function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

/** A transcript whose first `blind` marks fail, as a `stat` that failed would. */
class BlindTranscript extends Transcript {
  blind = 0;

  override mark(): number | null {
    if (this.blind > 0) {
      this.blind -= 1;
      return null;
    }
    return super.mark();
  }
}

async function folderOf(t: TestContext): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "late-lines-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

async function started(
  t: TestContext,
  transcript: Transcript,
  script: FakeScript,
): Promise<{ session: ClaudeSession; query: FakeSdk["only"] }> {
  const sdk = new FakeSdk(script);
  const session = new ClaudeSession({ ...CONFIG, transcript }, NO_REQUESTS, sdk.query);
  t.after(() => session.close());
  await session.ready();
  return { session, query: sdk.only };
}

/** The goal changes the next prompt's turn gives, up to its end. */
async function goalsOfNextTurn(session: ClaudeSession, query: FakeSdk["only"]): Promise<string[]> {
  await session.send(PROMPT);
  query.answer(TOOLS);
  return goalsUntilTurnEnd(session);
}

async function goalsUntilTurnEnd(session: ClaudeSession): Promise<string[]> {
  const goals: string[] = [];
  for await (const event of session.events) {
    if (event.type === "goal_changed") goals.push(event.goal.state);
    if (event.type === "turn_ended") break;
  }
  return goals;
}

test(
  "a /goal clear whose marks could not be measured leaves its line out of the next turn",
  LIMIT,
  async (t) => {
    const folder = await folderOf(t);
    const path = join(folder, "cce8a58a-5d75-487b-a79a-2f38a183fea7.jsonl");
    const transcript = new BlindTranscript(async () => path, { project: folder });
    const { session, query } = await started(t, transcript, { transcript: path });
    // Every record of the command's turn, the result and the completed included.
    transcript.blind = CLEAR_TURN.length + 1;
    const clearing = session.clearGoal();
    await pause();
    query.answer([
      ...CLEAR_TURN.slice(0, -1),
      written(CLEARED),
      CLEAR_TURN.at(-1) as JsonObject,
      { ...CLEAR_STARTED, state: "completed" },
    ]);
    await clearing;
    await pause();
    assert.deepEqual(await goalsOfNextTurn(session, query), []);
  },
);

test(
  "a transcript Claude Code hashed to another folder keeps the hidden /model's lines out of the next turn",
  LIMIT,
  async (t) => {
    const folder = await folderOf(t);
    // The reader works the path out under a folder that is not where Claude Code wrote.
    const path = join(folder, "68da9311-0000-4000-8000-000000000001.jsonl");
    const transcript = new Transcript(async () => path, { project: join(folder, "never") });
    const { session, query } = await started(t, transcript, { transcript: path });
    const setting = session.setModel("haiku");
    await pause();
    query.answer([...MODEL_COMMAND.slice(0, -2), written(CLEARED), ...MODEL_COMMAND.slice(-2)]);
    await setting;
    await pause();
    assert.deepEqual(await goalsOfNextTurn(session, query), []);
  },
);

test(
  "on a healthy transcript the next turn's goal line is not taken for the command's",
  LIMIT,
  async (t) => {
    const folder = await folderOf(t);
    const path = join(folder, "68da9311-0000-4000-8000-000000000001.jsonl");
    const transcript = new Transcript(async () => path, { project: folder });
    const { session, query } = await started(t, transcript, { transcript: path });
    const setting = session.setModel("haiku");
    await pause();
    // The caller is resolved at the result: the next turn may write before the read is in line.
    query.answer([...MODEL_COMMAND, written(GOAL_SET), ...TOOLS]);
    await setting;
    assert.deepEqual(await goalsUntilTurnEnd(session), ["set"]);
  },
);

test("a cancelled command ends the hiding and keeps its late lines out", LIMIT, async (t) => {
  const folder = await folderOf(t);
  const path = join(folder, "68da9311-0000-4000-8000-000000000001.jsonl");
  const transcript = new Transcript(async () => path, { project: join(folder, "never") });
  const { session, query } = await started(t, transcript, { transcript: path });
  const setting = session.setModel("haiku");
  await pause();
  const completed = MODEL_COMMAND.findIndex(
    (record) => record.type === "command_lifecycle" && record.state === "completed",
  );
  query.answer([
    MODEL_COMMAND[0] as JsonObject,
    written(CLEARED),
    { ...MODEL_COMMAND[completed], state: "cancelled" },
  ]);
  await assert.rejects(setting, /cancelled/);
  await pause();
  assert.deepEqual(await goalsOfNextTurn(session, query), []);
});
