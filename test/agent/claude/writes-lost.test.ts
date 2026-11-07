/**
 * What `ClaudeSession.close` reports when the CLI could not save to disk as it exited. The
 * fixture `session-writes-lost.json` is written by hand to the shape of `SDKSessionWritesLostMessage`
 * in `sdk.d.ts` 0.3.319 (no recording of one exists); the other records are of
 * `SDKSessionStateChangedMessage` and `SDKBackgroundTasksChangedMessage` in the same file.
 */
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { ClaudeSession, logger, type SessionConfig } from "../../../src/agent/claude/session.ts";
import type { RequestHandler } from "../../../src/agent/seam.ts";
import { END, type FakeQuery, type FakeScript, FakeSdk } from "../../support/fake-query.ts";
import { type JsonObject, sdkRecords } from "../../support/fixtures.ts";

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
const LOST = sdkRecords("session-writes-lost")[0] as JsonObject;
const SESSION = LOST.session_id as string;
const UUID = "00000000-0000-4000-8000-0000000000c2";

const state = (name: "idle" | "running" | "requires_action"): JsonObject => ({
  type: "system",
  subtype: "session_state_changed",
  state: name,
  uuid: UUID,
  session_id: SESSION,
});
const tasks = (...list: JsonObject[]): JsonObject => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks: list,
  uuid: UUID,
  session_id: SESSION,
});
const SHELL: JsonObject = { task_id: "bx1", task_type: "local_bash", description: "sleep 40" };
const lost = (change: JsonObject): JsonObject => ({ ...LOST, ...change });

/** Lets the pump read what the fake has already delivered. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function idle(
  t: TestContext,
  script: FakeScript = {},
  graceMs = 5_000,
): Promise<{ session: ClaudeSession; query: FakeQuery }> {
  const sdk = new FakeSdk({ start: [state("idle")], ...script });
  const session = new ClaudeSession(CONFIG, NO_REQUESTS, sdk.query, undefined, graceMs);
  t.after(() => session.close());
  await session.ready();
  await settle();
  return { session, query: sdk.only };
}

test(
  "a close that awaits the exit reads the report the CLI sends as it exits",
  LIMIT,
  async (t) => {
    const { session, query } = await idle(t);
    const closing = session.close({ awaitExit: true });
    await settle();
    assert.equal(query.closed, false, "the process is let exit on its own");
    query.inject([LOST, END]);
    assert.deepEqual(await closing, {
      unsaved: { conversation: true, settings: true, cause: "disk_full" },
    });
    assert.equal(query.closed, true);
  },
);

test("a report sent as the input ends is read", LIMIT, async (t) => {
  const { session } = await idle(t, { afterInput: [LOST, END] });
  const report = await session.close({ awaitExit: true });
  assert.equal(report.unsaved?.conversation, true);
});

test("the causes and the kinds of loss are told in neutral words", LIMIT, async (t) => {
  const cases: Array<[JsonObject, unknown]> = [
    [
      lost({ error_code: "EDQUOT", lost: ["global_config"] }),
      { conversation: false, settings: true, cause: "quota" },
    ],
    [
      lost({ error_code: "EIO", lost: ["transcript"] }),
      { conversation: true, settings: false, cause: "other" },
    ],
    [lost({ lost: ["something_new"] }), null],
    [lost({ lost: ["transcript"], transcript_session_ids: ["another-session"] }), null],
    [
      lost({ lost: ["transcript"], transcript_session_ids: undefined as never }),
      { conversation: true, settings: false, cause: "disk_full" },
    ],
  ];
  for (const [record, unsaved] of cases) {
    const { session } = await idle(t, { afterInput: [record, END] });
    assert.deepEqual((await session.close({ awaitExit: true })).unsaved, unsaved);
  }
});

test("a second close reports the same", LIMIT, async (t) => {
  const { session } = await idle(t, { afterInput: [LOST, END] });
  const first = await session.close({ awaitExit: true });
  assert.deepEqual(await session.close(), first);
  assert.notEqual(first.unsaved, null);
});

test("no report when none was sent", LIMIT, async (t) => {
  const { session } = await idle(t, { afterInput: [state("idle"), END] });
  assert.deepEqual(await session.close({ awaitExit: true }), { unsaved: null });
});

test("a close that does not await the exit closes the process at once", LIMIT, async (t) => {
  const { session, query } = await idle(t, { afterInput: [LOST, END] });
  await session.close();
  assert.equal(query.closed, true);
});

test(
  "a live background task closes at once: the CLI would run a turn after the close",
  LIMIT,
  async (t) => {
    const { session, query } = await idle(t, { start: [state("idle"), tasks(SHELL)] });
    const closing = session.close({ awaitExit: true });
    await settle();
    assert.equal(query.closed, true);
    await closing;
  },
);

test("an ambient task keeps the close from waiting too", LIMIT, async (t) => {
  const { session, query } = await idle(t, {
    start: [state("idle"), tasks({ ...SHELL, ambient: true })],
  });
  const closing = session.close({ awaitExit: true });
  await settle();
  assert.equal(query.closed, true);
  await closing;
});

test("a task list that was replaced by an empty one lets the close wait", LIMIT, async (t) => {
  const { session, query } = await idle(t, {
    start: [state("idle"), tasks(SHELL), tasks()],
  });
  const closing = session.close({ awaitExit: true });
  await settle();
  assert.equal(query.closed, false);
  query.inject([END]);
  await closing;
});

test("a session that is running, or waiting for an answer, closes at once", LIMIT, async (t) => {
  for (const name of ["running", "requires_action"] as const) {
    const { session, query } = await idle(t, { start: [state("idle"), state(name)] });
    const closing = session.close({ awaitExit: true });
    await settle();
    assert.equal(query.closed, true, name);
    await closing;
  }
});

test("any record but the three allowed cuts the wait", LIMIT, async (t) => {
  const records: JsonObject[] = [
    state("running"),
    { type: "system", subtype: "init", session_id: SESSION, uuid: UUID },
    { type: "system", subtype: "hook_started", session_id: SESSION, uuid: UUID },
    { type: "stream_event", event: { type: "message_start" }, session_id: SESSION, uuid: UUID },
  ];
  for (const record of records) {
    const { session, query } = await idle(t);
    const closing = session.close({ awaitExit: true });
    await settle();
    assert.equal(query.closed, false);
    query.inject([record]);
    await settle();
    assert.equal(query.closed, true, JSON.stringify(record.subtype ?? record.type));
    await closing;
  }
});

test("the three allowed records do not cut the wait", LIMIT, async (t) => {
  const { session, query } = await idle(t);
  const closing = session.close({ awaitExit: true });
  query.inject([state("idle"), tasks(), LOST]);
  await settle();
  assert.equal(query.closed, false);
  query.inject([END]);
  assert.equal((await closing).unsaved?.cause, "disk_full");
});

test("a stream that does not end is closed after the grace", LIMIT, async (t) => {
  const { session, query } = await idle(t, {}, 20);
  const started = Date.now();
  const closing = session.close({ awaitExit: true });
  await settle();
  assert.equal(query.closed, false);
  await closing;
  assert.equal(query.closed, true);
  assert.ok(Date.now() - started >= 15);
});

test("a close before the process answered its start closes at once", LIMIT, async (t) => {
  const sdk = new FakeSdk({ start: [state("idle")], initDelayMs: 50 });
  const session = new ClaudeSession(CONFIG, NO_REQUESTS, sdk.query, undefined, 5_000);
  t.after(() => session.close());
  await settle();
  await session.close({ awaitExit: true });
  assert.equal(sdk.only.closed, true);
});

test("a process lost on its own keeps the report its stream carried", LIMIT, async (t) => {
  t.mock.method(logger, "error", () => undefined);
  const sdk = new FakeSdk({ start: [LOST, END] });
  const session = new ClaudeSession(CONFIG, NO_REQUESTS, sdk.query);
  t.after(() => session.close());
  for await (const event of session.events) if (event.type === "process_lost") break;
  assert.equal((await session.close()).unsaved?.conversation, true);
});
