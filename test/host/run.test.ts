/**
 * The two ways the host layer runs a system command, on the real machine with Node itself as the
 * command: no shell between, the output captured, and a command that cannot start reported as
 * status null with the reason.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runAsync, runCommand } from "../../src/host/run.ts";

const SCRIPT = "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)";

test("runAsync reports the status and both streams of a command that ends", async () => {
  assert.deepEqual(await runAsync(process.execPath, ["-e", SCRIPT]), {
    status: 3,
    stdout: "out",
    stderr: "err",
  });
});

test("runAsync passes the arguments as they are: no shell reads them", async () => {
  const argument = "a b; echo $HOME `x` *";
  const result = await runAsync(process.execPath, [
    "-e",
    "process.stdout.write(process.argv[1])",
    argument,
  ]);
  assert.equal(result.stdout, argument);
});

test("runAsync reports a command that cannot start as status null with the reason", async () => {
  const result = await runAsync("/nonexistent/allaboard-test-command", []);
  assert.equal(result.status, null);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /ENOENT/);
});

test("runAsync does not block the event loop while the command runs", async () => {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 10);
  await runAsync(process.execPath, ["-e", "setTimeout(() => {}, 200)"]);
  clearInterval(timer);
  assert.ok(ticks >= 3, `the loop ran ${ticks} times while the command waited`);
});

// npm on SIGTERM finishes its current step, puts the old folder back and ends with 1 (measured
// 2026-10-17, npm 11.17.0): the stand-in does the same in 150 ms and leaves a file once it
// listens, so the test aborts only after the handler exists.
const ROLLS_BACK = `
  const { writeFileSync } = require("node:fs");
  process.on("SIGTERM", () => {
    setTimeout(() => { process.stdout.write("rolled back"); process.exit(1); }, 150);
  });
  writeFileSync(process.argv[1], "");
  setTimeout(() => {}, 30000);
`;

// Windows has no POSIX signals: `ChildProcess.kill` there ignores the signal it is given and ends
// the process at once (Node's child_process reference), so no command can answer SIGTERM.
const NO_SIGNALS = process.platform === "win32" && "Windows ends a process without a signal";

test("runAsync sends SIGTERM when the signal aborts, and returns once the command has ended", {
  skip: NO_SIGNALS,
}, async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "awd-run-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const listening = join(folder, "listening");
  const abort = new AbortController();
  const running = runAsync(process.execPath, ["-e", ROLLS_BACK, listening], abort.signal);
  while (!existsSync(listening)) await new Promise((resolve) => setTimeout(resolve, 5));
  let returned = false;
  void running.then(() => {
    returned = true;
  });
  abort.abort();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(returned, false, "it returned before the command ended");
  // The command's own answer to the signal, not a status made up for the abort.
  assert.deepEqual(await running, { status: 1, stdout: "rolled back", stderr: "" });
});

test("runAsync with a signal that has aborted already ends the command at once", async () => {
  const result = await runAsync(
    process.execPath,
    ["-e", "setTimeout(() => {}, 30000)"],
    AbortSignal.abort(),
  );
  assert.equal(result.status, null);
});

// A kill on a child that never started has no pid to aim at, and on Node 26.5.1 it signalled the
// caller's whole process group. The reproduction runs in a process of its own group, so a
// regression ends that process and nothing else.
const ABORTED_AND_MISSING = `
  import { runAsync } from ${JSON.stringify(new URL("../../src/host/run.ts", import.meta.url).href)};
  const result = await runAsync("/nonexistent/allaboard-test-command", [], AbortSignal.abort());
  process.stdout.write(JSON.stringify(result));
`;

test("runAsync with a signal aborted already and a command that cannot start signals nobody", async () => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", ABORTED_AND_MISSING], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => child.on("close", (code, signal) => resolve({ code, signal })),
  );
  assert.deepEqual(ended, { code: 0, signal: null });
  const result = JSON.parse(stdout) as { status: number | null; stderr: string };
  assert.equal(result.status, null);
  assert.notEqual(result.stderr, "");
});

test("runCommand reports the same shapes, synchronously", () => {
  assert.deepEqual(runCommand(process.execPath, ["-e", SCRIPT]), {
    status: 3,
    stdout: "out",
    stderr: "err",
  });
  assert.equal(runCommand("/nonexistent/allaboard-test-command", []).status, null);
});
