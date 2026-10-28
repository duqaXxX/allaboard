/**
 * The advisor of a session, read from Claude Code's settings with the SDK's `resolveSettings`
 * (declared `@alpha` in `sdk.d.ts` 0.3.312; it read `"opus"` with provenance `user` from a
 * settings file holding `advisorModel`, measured 2026-10-28).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { advisorModel, type ResolveSettings } from "../../../src/agent/claude/advisor.ts";

function settings(effective: Awaited<ReturnType<ResolveSettings>>["effective"]): {
  resolve: ResolveSettings;
  asked: Parameters<ResolveSettings>[0][];
} {
  const asked: Parameters<ResolveSettings>[0][] = [];
  return {
    asked,
    resolve: async (options) => {
      asked.push(options);
      return { effective };
    },
  };
}

test("the advisor is the setting as it names the model, for the session's folder and sources", async () => {
  const { resolve, asked } = settings({ advisorModel: "opus" });
  assert.equal(await advisorModel("/work/app", ["user", "project"], {}, resolve), "opus");
  assert.deepEqual(asked, [{ cwd: "/work/app", settingSources: ["user", "project"] }]);
});

test("no setting, or an empty one, is no advisor", async () => {
  assert.equal(await advisorModel("/work/app", ["user"], {}, settings({}).resolve), null);
  assert.equal(
    await advisorModel("/work/app", ["user"], {}, settings({ advisorModel: "" }).resolve),
    null,
  );
});

test("the variable that turns the tool off wins over the setting, from the session or the settings", async () => {
  const set = settings({ advisorModel: "opus" }).resolve;
  const off = { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1" };
  assert.equal(await advisorModel("/work/app", ["user"], off, set), null);
  const inSettings = settings({ advisorModel: "opus", env: off }).resolve;
  assert.equal(await advisorModel("/work/app", ["user"], {}, inSettings), null);
});

test("the settings' own env wins over the session's environment", async () => {
  const resolve = settings({
    advisorModel: "opus",
    env: { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "0" },
  }).resolve;
  const off = { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1" };
  assert.equal(await advisorModel("/work/app", ["user"], off, resolve), "opus");
});
