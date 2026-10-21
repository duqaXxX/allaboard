/** Runs a system command for the host layer, with no shell between, and waits for it. */
import { spawn, spawnSync } from "node:child_process";
import type { Run } from "./service/seam.ts";

/** How a command ended: its exit status (null when it could not start or was killed) and output. */
export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * `Run` that does not block the event loop, for commands that take seconds: npm's. When `signal`
 * aborts the command is sent SIGTERM, and the result comes once it has ended (what it did with
 * the signal is in the result: an npm rolling an install back ends with 1). Windows has no POSIX
 * signals: there the command is ended at once, and npm rolls nothing back.
 */
export type RunAsync = (
  command: string,
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<CommandResult>;

/** `Run` on the real machine: a command that cannot start reports status null and why. */
export const runCommand: Run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error !== undefined) {
    return { status: null, stdout: "", stderr: result.error.message };
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

function abortReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason.message : "aborted before the command started";
}

/** `RunAsync` on the real machine: same reporting as `runCommand`, the event loop free meanwhile. */
export const runAsync: RunAsync = (command, args, signal) =>
  new Promise((resolve) => {
    // A signal that has aborted already starts nothing: there is no command to end.
    if (signal?.aborted) {
      resolve({ status: null, stdout: "", stderr: abortReason(signal) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", terminate);
      resolve(result);
    };
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    // Not `spawn`'s own `signal` option: it reports the abort as an 'error' at once, before the
    // command has ended, and the caller waits for the end.
    // A child that did not start has no pid, and a kill with none aimed at the caller's whole
    // process group on Node 26.5.1.
    function terminate(): void {
      if (child.pid !== undefined) child.kill("SIGTERM");
    }
    signal?.addEventListener("abort", terminate, { once: true });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    // 'error' without 'close': the command could not start (a missing file, no permission).
    child.on("error", (error) => done({ status: null, stdout: "", stderr: error.message }));
    // 'close', not 'exit': the streams are drained by then. A signal leaves the status null.
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
