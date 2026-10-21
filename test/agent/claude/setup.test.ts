/** The two optional questions the Claude module gives `allaboard setup`, and their checks. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeAgent, claudeSetup } from "../../../src/agent/claude/module.ts";
import type { SetupQuestion } from "../../../src/module-setup.ts";

const HOME = "/srv/alice";

function questionOf(variable: string): SetupQuestion {
  const found = claudeSetup(HOME).questions.find((q) => q.variable === variable);
  return found as SetupQuestion;
}

test("the module offers two questions, in this order: the timeout has a default, the folder is optional", () => {
  const { questions } = claudeAgent({ home: HOME }).setup?.() ?? { questions: [] };
  assert.deepEqual(
    questions.map((q) => [q.variable, q.optional, q.secret, q.default]),
    [
      ["BASH_DEFAULT_TIMEOUT_MS", false, false, "4"],
      ["CLAUDE_CONFIG_DIR", true, false, undefined],
    ],
  );
  assert.match(
    questions[0]?.message ?? "",
    /^Bash command timeout in hours \(BASH_DEFAULT_TIMEOUT_MS, Enter for 4\):$/,
  );
  assert.match(questions[1]?.message ?? "", /Enter for ~\/\.claude\):$/);
});

test("the timeout is asked in hours and written in whole milliseconds", async () => {
  const { check } = questionOf("BASH_DEFAULT_TIMEOUT_MS");
  const cases: [string, string][] = [
    ["4", "14400000"],
    ["1.5", "5400000"],
    ["0.5", "1800000"],
    ["596", "2145600000"],
    ["0.02", "72000"],
    ["596.5", "2147400000"],
  ];
  for (const [typed, written] of cases) {
    assert.deepEqual(await check(typed), { value: written, note: `${written} ms` }, typed);
  }
});

test("a timeout below 1 minute, below zero, not a number or above Node's largest timer is refused", async () => {
  const { check } = questionOf("BASH_DEFAULT_TIMEOUT_MS");
  for (const bad of [
    "0",
    "0.0",
    "-1",
    "abc",
    "1e3",
    "1,5",
    ".5",
    "4h",
    "600",
    "0.0000001",
    "0.01",
    "596.6",
  ]) {
    const checked = await check(bad);
    assert.ok("refusal" in checked, bad);
    if ("refusal" in checked) assert.match(checked.refusal, /hours from 0\.02 to 596\.5/);
  }
});

test("the folder is absolute or starts with ~/, and need not exist", async () => {
  const { check } = questionOf("CLAUDE_CONFIG_DIR");
  for (const good of ["/srv/alice/second-login", "~/.claude-work", "~"]) {
    assert.deepEqual(await check(good), {}, good);
  }
  for (const bad of ["relative/dir", "./here", "~alice/x"]) {
    const checked = await check(bad);
    assert.ok("refusal" in checked, bad);
    if ("refusal" in checked)
      assert.match(checked.refusal, /absolute path, or one starting with ~\//);
  }
});
