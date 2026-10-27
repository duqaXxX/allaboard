/**
 * A goal's `goal_status` entries into changes, on the entries a session store received in a
 * recorded session (`test/fixtures/sdk/goal-lifecycle-store.json`, SDK 0.3.304, 2026-10-20): a
 * goal set and stopped, resumed by the next prompt (a check that failed, then achieved), a second
 * goal set and stopped, then cleared.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { goalChange, goalStore, stopHookSummary } from "../../../src/agent/claude/goals.ts";
import type { SessionEvent } from "../../../src/agent/seam.ts";
import { type JsonObject, sdkJson } from "../../support/fixtures.ts";

const APPENDS = sdkJson("goal-lifecycle-store") as Array<{ entries: JsonObject[] }>;
const ENTRIES = APPENDS.flatMap((append) => append.entries);
const FIRST =
  "the files a1.txt to a20.txt exist in the current folder, created one per Bash call, each holding its own number";
const SECOND = FIRST.replace("a1.txt to a20.txt", "b1.txt to b20.txt");

test("each goal_status entry is the change the terminal shows for it", () => {
  const changes = ENTRIES.map(goalChange).filter((change) => change !== null);
  assert.deepEqual(changes, [
    { state: "set", condition: FIRST },
    { state: "not_met", condition: FIRST },
    { state: "achieved", condition: FIRST, turns: 2, durationMs: 46_068, tokens: 3291 },
    { state: "set", condition: SECOND },
    { state: "cleared", condition: SECOND },
  ]);
});

test("any other entry is no change", () => {
  const others = ENTRIES.filter((entry) => entry.type !== "attachment");
  assert.ok(others.length > 0);
  for (const entry of others) assert.equal(goalChange(entry), null);
  assert.equal(goalChange({ type: "attachment", attachment: { type: "goal_status" } }), null);
});

test("an achieved goal with no counts keeps the change and loses the counts", () => {
  const entry = {
    type: "attachment",
    attachment: { type: "goal_status", met: true, condition: "x" },
  };
  assert.deepEqual(goalChange(entry), {
    state: "achieved",
    condition: "x",
    turns: null,
    durationMs: null,
    tokens: null,
  });
});

test("the store delivers the main transcript's changes, keeps nothing and loads nothing", async () => {
  const delivered: SessionEvent[] = [];
  const sessionStore = goalStore((event) => delivered.push(event));
  const key = {
    projectKey: "-home-dev-project",
    sessionId: "68da9311-0000-4000-8000-000000000001",
  };
  await sessionStore.append({ ...key, subpath: "subagents/agent-a1b2c3" }, ENTRIES as never);
  assert.equal(delivered.length, 0);
  await sessionStore.append(key, ENTRIES as never);
  assert.equal(delivered.length, 5);
  assert.equal(await sessionStore.load(key), null);
});

// A project Stop hook that refused once, then let the turn end, on the entries a session store
// received (`stop-hook-block-store.json`, SDK 0.3.310, 2026-10-27): the summary of the refusal
// and the summary of the Stop that followed. Both list the daemon's own Stop callback.
const BLOCK_ENTRIES = (
  sdkJson("stop-hook-block-store") as Array<{ entries: JsonObject[] }>
).flatMap((append) => append.entries);
const REFUSAL = "PROBE-REASON-7731: reply with the single word OSPREY";
const REFUSED = {
  type: "stop_hooks_ran",
  hooks: 3,
  stopReason: null,
  errors: [REFUSAL],
  context: [],
};

test("only the stop_hook_summary of a refusal is an event, counted without the daemon's callback", () => {
  const summaries = BLOCK_ENTRIES.filter((entry) => entry.subtype === "stop_hook_summary");
  assert.equal(summaries.length, 2);
  assert.deepEqual(
    BLOCK_ENTRIES.map(stopHookSummary).filter((event) => event !== null),
    [REFUSED],
  );
});

// The two other things a stop hook says, each from a run of its own (`stop-hook-said-store.json`,
// SDK 0.3.310, 2026-10-27): a context added for the agent, whose turn goes on and ends on a
// summary that says nothing, and the session stopped with a reason.
const SAID_ENTRIES = (sdkJson("stop-hook-said-store") as Array<{ entries: JsonObject[] }>).flatMap(
  (append) => append.entries,
);

test("an added context and a stop with its reason are events, a summary that says nothing is not", () => {
  assert.equal(SAID_ENTRIES.filter((entry) => entry.subtype === "stop_hook_summary").length, 3);
  assert.deepEqual(
    SAID_ENTRIES.map(stopHookSummary).filter((event) => event !== null),
    [
      {
        type: "stop_hooks_ran",
        hooks: 3,
        stopReason: null,
        errors: [],
        context: ["PROBE-REASON-7731 context line one\nline two"],
      },
      {
        type: "stop_hooks_ran",
        hooks: 3,
        stopReason: "PROBE-REASON-7731 stopped by the hook",
        errors: [],
        context: [],
      },
    ],
  );
});

test("a stop with no reason is an event with none, as the terminal still counts the hooks", () => {
  const summary = { type: "system", subtype: "stop_hook_summary", hookCount: 1, stopReason: "" };
  assert.deepEqual(stopHookSummary({ ...summary, preventedContinuation: true }), {
    type: "stop_hooks_ran",
    hooks: 1,
    stopReason: null,
    errors: [],
    context: [],
  });
  // A reason with nothing stopped is not drawn by the terminal either.
  assert.equal(
    stopHookSummary({ ...summary, stopReason: "x", preventedContinuation: false }),
    null,
  );
});

test("a goal's failed check writes no event of the stop hooks", () => {
  // The summary a goal's check leaves has no error (measured 2026-10-27 on real transcripts):
  // its line is the goal's own.
  const summary = { type: "system", subtype: "stop_hook_summary", hookCount: 1, hookErrors: [] };
  assert.equal(stopHookSummary(summary), null);
  assert.equal(stopHookSummary({ ...summary, hookErrors: ["no"], hookCount: "1" }), null);
});

test("the store delivers what the stop hooks said", async () => {
  const delivered: SessionEvent[] = [];
  const sessionStore = goalStore((event) => delivered.push(event));
  const key = {
    projectKey: "-home-dev-project",
    sessionId: "68da9311-0000-4000-8000-000000000002",
  };
  await sessionStore.append(key, BLOCK_ENTRIES as never);
  assert.deepEqual(
    delivered.filter((event) => event.type === "stop_hooks_ran"),
    [REFUSED],
  );
});
