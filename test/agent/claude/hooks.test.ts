/**
 * The inputs of the three hooks the daemon registers, as Claude Code 2.1.280 and later hand them:
 * `stop-hook.json` and `post-tool-use-hook.json`, recorded from real sessions, and
 * `post-model-switch-hook.json`, written to the shape of `PostModelSwitchHookInput` in the SDK's
 * `sdk.d.ts` (0.3.301).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  postModelSwitchHookEvents,
  postToolUseHookEvents,
  stopHookEvents,
} from "../../../src/agent/claude/hooks.ts";
import { type JsonObject, sdkJson } from "../../support/fixtures.ts";

const STOP = sdkJson("stop-hook") as JsonObject;
// Written to the shape of `StopHookInput.session_crons` in `sdk.d.ts` 0.3.304: one `/loop 1m` job.
const STOP_WITH_JOB = sdkJson("stop-hook-session-crons") as JsonObject;
const POST_TOOL_USE = sdkJson("post-tool-use-hook") as JsonObject;
const MODEL_SWITCH = sdkJson("post-model-switch-hook") as JsonObject;
const PROJECT = "/home/dev/project";

test("a Stop hook gives the effort the session runs at, its scheduled jobs, then its folder", () => {
  assert.deepEqual(stopHookEvents(STOP), [
    { type: "effort_observed", level: "medium" },
    { type: "scheduled_jobs", jobs: [] },
    { type: "folder_changed", folder: PROJECT },
  ]);
});

test("a Stop hook lists the jobs the session has scheduled, whole", () => {
  assert.deepEqual(stopHookEvents(STOP_WITH_JOB)[1], {
    type: "scheduled_jobs",
    jobs: [{ id: "a1b2c3d4", schedule: "*/1 * * * *", recurring: true, prompt: "check the build" }],
  });
});

test("a Stop hook that lists no jobs, or a job it cannot read, keeps what the session knew", () => {
  const { session_crons: _, ...without } = STOP_WITH_JOB;
  for (const session_crons of [undefined, null, "none", { id: "a" }]) {
    assert.deepEqual(
      stopHookEvents({ ...STOP_WITH_JOB, session_crons }).map((event) => event.type),
      ["effort_observed", "folder_changed"],
    );
  }
  assert.deepEqual(
    stopHookEvents(without).map((event) => event.type),
    ["effort_observed", "folder_changed"],
  );
  // One job that is no job is left out; the others stand.
  const listed = stopHookEvents({
    ...STOP_WITH_JOB,
    session_crons: [
      { id: "a", schedule: "0 9 * * *", recurring: false, prompt: "once" },
      { id: "", schedule: "0 9 * * *", recurring: true, prompt: "no id" },
      { id: "b", schedule: 7, recurring: true, prompt: "no schedule" },
      "x",
    ],
  });
  assert.deepEqual(listed[1], {
    type: "scheduled_jobs",
    jobs: [{ id: "a", schedule: "0 9 * * *", recurring: false, prompt: "once" }],
  });
});

test("a Stop hook with no effort is a model that takes none", () => {
  const { effort: _, ...without } = STOP;
  assert.deepEqual(stopHookEvents(without), [
    { type: "effort_observed", level: null },
    { type: "scheduled_jobs", jobs: [] },
    { type: "folder_changed", folder: PROJECT },
  ]);
  for (const effort of ["medium", null, [], { level: 7 }, {}]) {
    assert.deepEqual(stopHookEvents({ ...STOP, effort })[0], {
      type: "effort_observed",
      level: null,
    });
  }
});

test("a PostToolUse hook gives the folder alone", () => {
  assert.deepEqual(postToolUseHookEvents(POST_TOOL_USE), [
    { type: "folder_changed", folder: PROJECT },
  ]);
});

test("a PostToolUse hook's effort is not an observation", () => {
  // Every hook input may carry it; the Stop hook's is the one the footer reads.
  const withEffort = { ...POST_TOOL_USE, effort: { level: "high" } };
  assert.deepEqual(postToolUseHookEvents(withEffort), [
    { type: "folder_changed", folder: PROJECT },
  ]);
});

test("a hook input that names no folder moves none", () => {
  for (const cwd of ["", null, 7, undefined]) {
    assert.deepEqual(stopHookEvents({ ...STOP, cwd }), [
      { type: "effort_observed", level: "medium" },
      { type: "scheduled_jobs", jobs: [] },
    ]);
    assert.deepEqual(postToolUseHookEvents({ ...POST_TOOL_USE, cwd }), []);
  }
});

test("what is no hook input gives the Stop hook's unknown effort and nothing else", () => {
  for (const input of [null, undefined, "stop", []]) {
    assert.deepEqual(stopHookEvents(input), [{ type: "effort_observed", level: null }]);
    assert.deepEqual(postToolUseHookEvents(input), []);
  }
});

test("a PostModelSwitch hook gives the model the session runs after the switch", () => {
  assert.deepEqual(postModelSwitchHookEvents(MODEL_SWITCH), [
    { type: "model_changed", model: "claude-opus-5-5" },
  ]);
});

test("every source of a switch gives the model", () => {
  for (const source of ["command", "picker", "sdk", "auto", "resume"]) {
    assert.deepEqual(postModelSwitchHookEvents({ ...MODEL_SWITCH, source }), [
      { type: "model_changed", model: "claude-opus-5-5" },
    ]);
  }
});

test("a PostModelSwitch input with no model says nothing", () => {
  for (const to_model of [undefined, null, "", 7]) {
    assert.deepEqual(postModelSwitchHookEvents({ ...MODEL_SWITCH, to_model }), []);
  }
  assert.deepEqual(postModelSwitchHookEvents(null), []);
});
