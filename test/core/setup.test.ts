import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelInfo } from "../../src/agent/seam.ts";
import {
  choiceOf,
  DEFAULT,
  DEFAULT_CHOICE,
  effortLevels,
  summaryOf,
} from "../../src/core/setup.ts";
import { PLAIN_MODELS } from "../support/plain-agent.ts";

// The plain agent's list: the default entry first, a model with both efforts, one with none.
const MODELS: readonly ModelInfo[] = PLAIN_MODELS;

const untouched = { model: DEFAULT, effort: DEFAULT, bypass: false };

test("the default entry of the list stands for the default choice, and a model without effort lists none", () => {
  const small = MODELS.find((m) => m.value === "small");
  assert.deepEqual([small?.supportsEffort, small?.supportedEffortLevels], [false, []]);
  assert.equal(MODELS.filter((m) => m.isDefault).length, 1);
  assert.deepEqual(effortLevels(MODELS, DEFAULT), ["brief", "full"]);
});

test("a model offers its levels in the agent s order", () => {
  assert.deepEqual(effortLevels(MODELS, "big"), ["brief", "full"]);
});

test("a model without effort, or one not listed, offers no level", () => {
  assert.deepEqual(effortLevels(MODELS, "small"), []);
  assert.deepEqual(effortLevels(MODELS, "gpt-x"), []);
});

test("an untouched selection reads as all defaults", () => {
  assert.deepEqual(choiceOf(MODELS, untouched), DEFAULT_CHOICE);
  assert.deepEqual(choiceOf([], untouched), DEFAULT_CHOICE);
});

test("each part of a selection is kept when the models list it", () => {
  const selection = { model: "big", effort: "full", bypass: true };
  assert.deepEqual(choiceOf(MODELS, selection), selection);
});

test("an effort the model does not support reads as default", () => {
  const choice = choiceOf(MODELS, { model: "small", effort: "full", bypass: false });
  assert.deepEqual(choice, { model: "small", effort: DEFAULT, bypass: false });
});

test("a model the agent did not list reads as default, with its effort", () => {
  const choice = choiceOf(MODELS, { model: "gpt-x", effort: "full", bypass: true });
  // The default model is listed by the recording, so its levels apply once the model is reset.
  assert.deepEqual(choice, { model: DEFAULT, effort: "full", bypass: true });
  assert.deepEqual(choiceOf([], { model: "gpt-x", effort: "full", bypass: false }), DEFAULT_CHOICE);
});

test("the summary names the model by its display name", () => {
  assert.deepEqual(summaryOf(MODELS, { model: "big", effort: "full", bypass: true }), {
    model: "Big 2",
    effort: "full",
    bypass: true,
  });
});

test("the summary keeps the value of a model the agent did not list", () => {
  assert.deepEqual(summaryOf(MODELS, { model: "gpt-x", effort: DEFAULT, bypass: false }), {
    model: "gpt-x",
    effort: null,
    bypass: false,
  });
});

test("the default choice is the entry the list marks, whatever its value", () => {
  const entry = (value: string, isDefault: boolean, levels: readonly string[]): ModelInfo => ({
    value,
    isDefault,
    resolvedModel: null,
    displayName: `Name of ${value}`,
    description: null,
    supportsEffort: levels.length > 0,
    supportedEffortLevels: levels,
  });
  const list = [entry("big", false, []), entry("standard", true, ["low", "full"])];
  assert.deepEqual(effortLevels(list, DEFAULT), ["low", "full"]);
  assert.equal(summaryOf(list, { ...DEFAULT_CHOICE }).model, "Name of standard");
  assert.deepEqual(choiceOf(list, untouched), DEFAULT_CHOICE);
});
