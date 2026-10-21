/**
 * A goal's `goal_status` entries into changes, on the entries a session store received in a
 * recorded session (`test/fixtures/sdk/goal-lifecycle-store.json`, SDK 0.3.304, 2026-10-20): a
 * goal set and stopped, resumed by the next prompt (a check that failed, then achieved), a second
 * goal set and stopped, then cleared.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { goalChange, goalStore } from "../../../src/agent/claude/goals.ts";
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
