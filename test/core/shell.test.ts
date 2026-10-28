import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { monotonicClock } from "../../src/clock.ts";
import {
  Kept,
  OUTPUT_LIMIT,
  runShell,
  SHOWN_CHARACTERS,
  SHOWN_LINES,
  shellHead,
} from "../../src/core/shell.ts";

// A real Bash: the process group, the kill and the streams are what is under test.
const POSIX_ONLY = { skip: process.platform === "win32" && "a real Bash and its process group" };

function folder(t: { after: (fn: () => void) => void }): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "shell-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const options = (dir: string, more: Partial<Parameters<typeof runShell>[1]> = {}) => ({
  folder: dir,
  environment: { PATH: process.env.PATH, ALLABOARD_TEST_VALUE: "from-the-session" },
  timeoutMs: 10_000,
  clock: monotonicClock,
  ...more,
});

test("a command runs in the folder with the environment it is given", POSIX_ONLY, async (t) => {
  const dir = folder(t);
  const run = await runShell('pwd; echo "$ALLABOARD_TEST_VALUE"; echo oops >&2', options(dir));
  assert.equal(run.stdout, `${dir}\nfrom-the-session\n`);
  assert.equal(run.stderr, "oops\n");
  assert.equal(run.exitCode, 0);
  assert.equal(run.end, "exited");
  assert.equal(run.command, 'pwd; echo "$ALLABOARD_TEST_VALUE"; echo oops >&2');
});

test("a command that fails keeps its exit code", POSIX_ONLY, async (t) => {
  const run = await runShell("exit 3", options(folder(t)));
  assert.equal(run.exitCode, 3);
  assert.equal(run.end, "exited");
});

test("a command past its time limit ends with what it printed", POSIX_ONLY, async (t) => {
  const run = await runShell("echo before; sleep 30", options(folder(t), { timeoutMs: 300 }));
  assert.equal(run.end, "timedOut");
  assert.equal(run.exitCode, null);
  assert.equal(run.stdout, "before\n");
  assert.ok(run.seconds < 5, `${run.seconds}`);
});

test("a stop ends the command and what it started", POSIX_ONLY, async (t) => {
  const dir = folder(t);
  const stop = new AbortController();
  // The child of the shell writes a file if it outlives the stop.
  const running = runShell(`sleep 1 && touch "${dir}/survived" & wait`, {
    ...options(dir),
    signal: stop.signal,
  });
  setTimeout(() => stop.abort(), 100);
  const run = await running;
  assert.equal(run.end, "stopped");
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(join(dir, "survived")), false);
});

test("a command stopped before it starts never runs", async (t) => {
  const stop = new AbortController();
  stop.abort();
  const run = await runShell("echo ran", { ...options(folder(t)), signal: stop.signal });
  assert.deepEqual([run.end, run.stdout], ["stopped", ""]);
});

test("a folder that is gone is told, not thrown", POSIX_ONLY, async (t) => {
  const run = await runShell("echo ran", options(join(folder(t), "missing")));
  assert.equal(run.end, "notStarted");
  assert.notEqual(run.stderr, "");
});

test("a long output keeps its head and its tail, however it arrives", () => {
  const half = OUTPUT_LIMIT / 2;
  const kept = new Kept();
  kept.add("a".repeat(half - 5));
  for (let i = 0; i < 1000; i += 1) kept.add("x".repeat(100));
  kept.add("b".repeat(10));
  const left = half - 5 + 100_010 - 2 * half;
  assert.equal(
    kept.text(),
    `${"a".repeat(half - 5)}xxxxx\n… ${left} characters left out …\n${"x".repeat(half - 10)}${"b".repeat(10)}`,
  );
  const short = new Kept();
  short.add("short");
  assert.equal(short.text(), "short");
});

test("a command that prints without end holds a bounded output", POSIX_ONLY, async (t) => {
  // About 60 MB in 300 ms: kept whole, this is what took the daemon's memory.
  const run = await runShell("yes 0123456789", options(folder(t), { timeoutMs: 300 }));
  assert.equal(run.end, "timedOut");
  assert.ok(run.stdout.length < OUTPUT_LIMIT + 100, `${run.stdout.length}`);
  assert.match(run.stdout, /characters left out/);
});

test(
  "a process the command leaves in the background does not hold the run",
  POSIX_ONLY,
  async (t) => {
    const run = await runShell("echo up; sleep 5 &", options(folder(t)));
    assert.deepEqual([run.end, run.exitCode, run.stdout], ["exited", 0, "up\n"]);
    assert.ok(run.seconds < 2, `${run.seconds}`);
  },
);

test(
  "the lines left out are counted on the whole output, not on what the session reads",
  POSIX_ONLY,
  async (t) => {
    const run = await runShell("seq 1 200000", options(folder(t)));
    assert.equal(run.lines, 200_000);
    assert.match(shellHead(run), new RegExp(`… ${200_000 - SHOWN_LINES} lines above not shown\n`));
  },
);

test("a process left in the background goes on printing after the run", POSIX_ONLY, async (t) => {
  const dir = folder(t);
  const run = await runShell(
    `(sleep 0.5; echo late; touch "${dir}/alive") & echo first`,
    options(dir),
  );
  assert.deepEqual([run.end, run.stdout], ["exited", "first\n"]);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(join(dir, "alive")), true);
});

test("a stop once Bash has exited leaves the run as it ended", POSIX_ONLY, async (t) => {
  const stop = new AbortController();
  const running = runShell("sleep 3 & echo done", { ...options(folder(t)), signal: stop.signal });
  setTimeout(() => stop.abort(), 100);
  const run = await running;
  assert.deepEqual([run.end, run.exitCode, run.stdout], ["exited", 0, "done\n"]);
});

test("a command a signal ended says which", POSIX_ONLY, async (t) => {
  const run = await runShell("kill -9 $$", options(folder(t)));
  assert.deepEqual([run.end, run.exitCode, run.signal], ["exited", null, "SIGKILL"]);
  assert.ok(shellHead(run).startsWith("✗ ended by SIGKILL · "));
});

const ENDED = {
  command: "git status --short",
  stdout: " M a.ts\n",
  stderr: "",
  exitCode: 0,
  signal: null,
  lines: 1,
  end: "exited" as const,
  seconds: 0.12,
};

test("the thread shows how a run ended, then the command and its output in a code block", () => {
  assert.equal(shellHead(ENDED), "✓ exit 0 · 0.1 s\n```\n$ git status --short\n M a.ts\n```");
  assert.equal(
    shellHead({ ...ENDED, stdout: "", stderr: "fatal: not a repository\n", exitCode: 128 }),
    "✗ exit 128 · 0.1 s\n```\n$ git status --short\nfatal: not a repository\n```",
  );
  assert.ok(
    shellHead({ ...ENDED, end: "stopped", exitCode: null, seconds: 12.6 }).startsWith(
      "Stopped after 13 s.",
    ),
  );
});

test("no output can close the code block it is shown in", () => {
  const head = shellHead({ ...ENDED, stdout: "```\n<!channel>\n````\n" });
  assert.ok(head.includes("\n`````\n$ git status"), head);
  assert.ok(head.endsWith("\n`````"));
});

test("a long line shows only its end", () => {
  const head = shellHead({ ...ENDED, stdout: "x".repeat(SHOWN_CHARACTERS * 3) });
  assert.ok(head.includes(`\n…${"x".repeat(SHOWN_CHARACTERS)}\n`));
  assert.ok(head.length < SHOWN_CHARACTERS + 200);
});

test("a long output shows its last lines and says how many are left out", () => {
  const stdout = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
  const head = shellHead({ ...ENDED, stdout, lines: 99 });
  assert.ok(head.includes(`… ${100 - SHOWN_LINES} lines above not shown\nline 61\n`), head);
  assert.ok(head.endsWith("line 100\n```"));
  assert.ok(!head.includes("line 60\n"));
});
