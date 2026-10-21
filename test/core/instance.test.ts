/**
 * The instance: a name or none, the rule a name follows, and the folders that derive from it.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  configDirOf,
  DEFAULT_INSTANCE,
  INSTANCE_VARIABLE,
  parseInstanceName,
  scratchDirOf,
} from "../../src/core/instance.ts";

const HOME = join("/h", "alice");
const TMP = join("/t", "alice");

test("a name is lowercase letters, digits and hyphens, starting with a letter or digit", () => {
  for (const name of ["dev", "work", "a", "0", "2nd-login", "a-b-c", "x".repeat(32)]) {
    assert.deepEqual(parseInstanceName(name), { name }, name);
  }
});

test("a name that breaks the rule is refused with a sentence that states the rule", () => {
  for (const name of ["", "Work", "-dev", "dev_1", "dev.1", "a b", "é", "x".repeat(33), "../x"]) {
    const parsed = parseInstanceName(name);
    assert.ok("refusal" in parsed, JSON.stringify(name));
    assert.match(parsed.refusal, /1 to 32 characters/);
    assert.ok(parsed.refusal.includes(JSON.stringify(name)), parsed.refusal);
  }
});

test("the name default is refused: it would read as the default instance", () => {
  const parsed = parseInstanceName("default");
  assert.ok("refusal" in parsed);
  assert.match(parsed.refusal, /"default"/);
  assert.match(parsed.refusal, /the default instance/);
});

test("the name allaboard is refused: its log would be the default instance's", () => {
  const parsed = parseInstanceName("allaboard");
  assert.ok("refusal" in parsed);
  assert.match(parsed.refusal, /"allaboard"/);
  assert.match(parsed.refusal, /allaboard\.log/);
  assert.match(parsed.refusal, /default instance/);
  // Only the whole name: a longer one starts with it and has a log of its own.
  assert.deepEqual(parseInstanceName("allaboard-dev"), { name: "allaboard-dev" });
});

test("the default instance keeps today's folders", () => {
  assert.equal(configDirOf(DEFAULT_INSTANCE, HOME), join(HOME, ".config", "allaboard"));
  assert.equal(scratchDirOf(DEFAULT_INSTANCE, TMP), join(TMP, "allaboard"));
});

test("a named instance has folders of its own beside the default's", () => {
  const work = { name: "work" };
  assert.equal(configDirOf(work, HOME), join(HOME, ".config", "allaboard-work"));
  assert.equal(scratchDirOf(work, TMP), join(TMP, "allaboard-work"));
});

test("the variable that selects an instance is ALLABOARD_INSTANCE", () => {
  assert.equal(INSTANCE_VARIABLE, "ALLABOARD_INSTANCE");
});
