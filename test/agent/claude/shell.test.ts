import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TIMEOUT_MS, shellMode, shellPrompt } from "../../../src/agent/claude/shell.ts";
import type { ShellRun } from "../../../src/agent/seam.ts";

const RUN: ShellRun = {
  command: "ls -la",
  stdout: "a.txt\nb.txt\n",
  stderr: "",
  exitCode: 0,
  signal: null,
  lines: 1,
  end: "exited",
  seconds: 0.2,
};

test("a run is the two blocks the terminal adds for a bash-mode command", () => {
  // The shape of terminal transcripts of Claude Code 2.1.296 to 2.1.306 (read 2026-10-24): the
  // input, then stdout and stderr in one block, stdout with no trailing line break.
  assert.deepEqual(shellPrompt(RUN), [
    { type: "text", text: "<bash-input>ls -la</bash-input>" },
    { type: "text", text: "<bash-stdout>a.txt\nb.txt</bash-stdout><bash-stderr></bash-stderr>" },
  ]);
});

test("stderr is kept as printed, and a run past its limit says so in it", () => {
  const failed = shellPrompt({ ...RUN, stdout: "", stderr: "no such file\n", exitCode: 1 });
  assert.equal(
    (failed[1] as { text: string }).text,
    "<bash-stdout></bash-stdout><bash-stderr>no such file\n</bash-stderr>",
  );
  const late = shellPrompt({ ...RUN, stderr: "", end: "timedOut", exitCode: null, seconds: 120.4 });
  assert.equal(
    (late[1] as { text: string }).text,
    "<bash-stdout>a.txt\nb.txt</bash-stdout><bash-stderr>Command timed out after 120 s</bash-stderr>",
  );
});

test("the timeout is the owner's BASH_DEFAULT_TIMEOUT_MS, else Claude Code's default", () => {
  assert.equal(shellMode({ BASH_DEFAULT_TIMEOUT_MS: "14400000" }).timeoutMs, 14_400_000);
  assert.equal(shellMode({}).timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(shellMode({ BASH_DEFAULT_TIMEOUT_MS: "soon" }).timeoutMs, DEFAULT_TIMEOUT_MS);
});

test("a command runs in the environment a thread's session gets", () => {
  const environment = shellMode({ CLAUDE_CONFIG_DIR: "/somewhere" }).environment;
  assert.equal(environment.CLAUDE_CONFIG_DIR, "/somewhere");
  assert.equal(environment.CLAUDE_CODE_FORK_SUBAGENT, "1");
  assert.equal(environment.PATH, process.env.PATH);
});
