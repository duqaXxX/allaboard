import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelInfo } from "../../src/agent/seam.ts";
import { modelName, settingName } from "../../src/core/models.ts";
import { PLAIN_MODELS } from "../support/plain-agent.ts";

// The plain agent's list: "standard" is the default entry and resolves to "big-2", like "big".
const MODELS = PLAIN_MODELS;

test("a model is named by its display name in the agent's list, found by its full id", () => {
  assert.equal(modelName(MODELS, "small-1"), "Small 1");
  assert.equal(modelName(MODELS, "big-2"), "Big 2");
});

test("the default entry names no model: the entry of the model it resolves to does", () => {
  assert.equal(modelName(MODELS, "big-2"), "Big 2");
  assert.notEqual(modelName(MODELS, "big-2"), "Standard (recommended)");
});

test("a model the list does not hold, or no list at all, shows its id", () => {
  assert.equal(modelName(MODELS, "unlisted-9"), "unlisted-9");
  assert.equal(modelName([], "small-1"), "small-1");
});

test("a setting is named by the entry it is the value of, else by the model whose id it is", () => {
  assert.equal(settingName(MODELS, "big"), "Big 2");
  assert.equal(settingName(MODELS, "small-1"), "Small 1");
  assert.equal(settingName(MODELS, "big-2"), "Big 2");
});

test("a setting the list does not hold shows as it is set", () => {
  assert.equal(settingName(MODELS, "alias"), "alias");
  assert.equal(settingName([], "big"), "big");
});

test("the default entry is the one the list marks, whatever its value", () => {
  const entry = (value: string, isDefault: boolean): ModelInfo => ({
    value,
    isDefault,
    resolvedModel: "big-1",
    displayName: value,
    description: null,
    supportsEffort: false,
    supportedEffortLevels: [],
  });
  const list = [entry("standard", true), entry("big", false)];
  assert.equal(modelName(list, "big-1"), "big");
  assert.equal(settingName(list, "standard"), "standard");
  assert.equal(settingName(list, "big"), "big");
});
