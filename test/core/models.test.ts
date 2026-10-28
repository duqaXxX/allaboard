import assert from "node:assert/strict";
import { test } from "node:test";
import { agentInfo } from "../../src/agent/claude/info.ts";
import { modelName, settingName } from "../../src/core/models.ts";
import { sdkJson } from "../support/fixtures.ts";

// The recorded list (`server-info.json`, Claude Code 2.1.286).
const MODELS = agentInfo(sdkJson("server-info")).models;

test("a model is named by its display name in the agent's list, found by its full id", () => {
  assert.equal(modelName(MODELS, "claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(modelName(MODELS, "claude-opus-5-5"), "Opus 5.5");
});

test("the default entry names no model: the entry of the model it resolves to does", () => {
  assert.equal(modelName(MODELS, "claude-sonnet-5-5"), "Sonnet 5.5");
});

test("a model the list does not hold, or no list at all, shows its id", () => {
  assert.equal(modelName(MODELS, "claude-unlisted-9"), "claude-unlisted-9");
  assert.equal(modelName([], "claude-haiku-4-5-20251001"), "claude-haiku-4-5-20251001");
});

test("a setting is named by the entry it is the value of, else by the model whose id it is", () => {
  assert.equal(settingName(MODELS, "opus"), "Opus 5.5");
  assert.equal(settingName(MODELS, "claude-opus-4-8"), "Opus 4.8");
  assert.equal(settingName(MODELS, "claude-opus-5-5"), "Opus 5.5");
});

test("a setting the list does not hold shows as it is set", () => {
  // `fable` is an alias the advisor takes; the recorded list holds Fable by its id alone.
  assert.equal(settingName(MODELS, "fable"), "fable");
  assert.equal(settingName([], "opus"), "opus");
});
