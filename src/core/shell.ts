/**
 * A shell command the owner sends with `!!`, run as the terminal's `!` runs one: with Bash, in
 * the session's folder, nothing on its input. Its output is cut for the session as Claude Code
 * cuts a failed Bash call's (tools reference, "Output limits", read 2026-10-24): a head and a tail.
 */
import { spawn } from "node:child_process";
import type { Socket } from "node:net";
import type { ShellRun } from "../agent/seam.ts";
import type { Clock } from "../clock.ts";
import * as texts from "./texts.ts";

// The characters of each stream the session reads; past them, the head and the tail are kept.
export const OUTPUT_LIMIT = 30_000;
// How long a command has to end after SIGTERM before it is killed.
const KILL_GRACE_SECONDS = 2;
// How long the output may still arrive once Bash has exited. A process the command left in the
// background keeps the pipes open, and the run does not wait for it: from then on what it
// prints is read and dropped, so it never writes to a closed pipe and dies of it.
const DRAIN_MS = 200;

export interface ShellOptions {
  readonly folder: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
  readonly clock: Clock;
  /** The owner's `!stop`: the command ends as `stopped`. */
  readonly signal?: AbortSignal;
}

/**
 * One stream as it arrives, kept to its first and last `limit / 2` characters, so a command that
 * prints without end holds no more than `limit` of it in memory.
 */
export class Kept {
  readonly #half: number;
  #head = "";
  #tail = "";
  #total = 0;
  #breaks = 0;

  constructor(limit = OUTPUT_LIMIT) {
    this.#half = Math.floor(limit / 2);
  }

  add(chunk: string): void {
    this.#total += chunk.length;
    for (const char of chunk) if (char === "\n") this.#breaks += 1;
    const room = this.#half - this.#head.length;
    let rest = chunk;
    if (room > 0) {
      this.#head += rest.slice(0, room);
      rest = rest.slice(room);
    }
    if (rest !== "") this.#tail = (this.#tail + rest).slice(-this.#half);
  }

  /** The line breaks printed, all of them counted. */
  get breaks(): number {
    return this.#breaks;
  }

  /** What was printed, whole, or its head and tail around a line that says how much was left out. */
  text(): string {
    const left = this.#total - this.#head.length - this.#tail.length;
    if (left <= 0) return this.#head + this.#tail;
    return `${this.#head}\n… ${left} characters left out …\n${this.#tail}`;
  }
}

/**
 * Runs `command` and resolves once Bash has exited, never rejects. A command that outlives its
 * time limit or is stopped gets SIGTERM, then SIGKILL, sent to its whole process group, so what
 * it started ends with it; what it printed until then is kept. A process the command itself put
 * in the background is left running once Bash exits.
 */
export function runShell(command: string, options: ShellOptions): Promise<ShellRun> {
  const { clock, signal } = options;
  const started = clock.time();
  const stdout = new Kept();
  const stderr = new Kept();
  const ran = (
    end: ShellRun["end"],
    exitCode: number | null,
    killedBy: string | null,
    error = "",
  ): ShellRun => ({
    command,
    stdout: stdout.text(),
    stderr: error || stderr.text(),
    lines: stdout.breaks + stderr.breaks,
    exitCode,
    signal: killedBy,
    end,
    seconds: clock.time() - started,
  });
  if (signal?.aborted) return Promise.resolve(ran("stopped", null, null));
  return new Promise((resolve) => {
    let ending: "timedOut" | "stopped" | null = null;
    const timer = new AbortController();
    // `detached`: the command leads a process group of its own, which the kill reaches whole.
    const child = spawn("bash", ["-c", command], {
      cwd: options.folder,
      env: options.environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const kill = (how: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, how);
      } catch {
        // The group has ended already.
      }
    };
    let exited = false;
    const end = (why: "timedOut" | "stopped"): void => {
      // Once Bash has exited the command has run: only its output is still on its way.
      if (ending !== null || exited) return;
      ending = why;
      kill("SIGTERM");
      clock.sleep(KILL_GRACE_SECONDS, timer.signal).then(
        () => kill("SIGKILL"),
        () => {},
      );
    };
    const stop = (): void => end("stopped");
    signal?.addEventListener("abort", stop, { once: true });
    clock.sleep(options.timeoutMs / 1000, timer.signal).then(
      () => end("timedOut"),
      () => {},
    );
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => stdout.add(chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => stderr.add(chunk));
    let settled = false;
    const done = (run: ShellRun): void => {
      if (settled) return;
      settled = true;
      timer.abort();
      signal?.removeEventListener("abort", stop);
      resolve(run);
    };
    // 'error' without 'exit': Bash could not start (the folder is gone, no Bash).
    child.on("error", (error) => done(ran("notStarted", null, null, error.message)));
    child.on("exit", (code, killedBy) => {
      exited = true;
      const finish = (): void => {
        for (const stream of [child.stdout, child.stderr]) {
          stream.removeAllListeners("data");
          stream.resume();
          // Nor does a process left behind keep the daemon from exiting.
          (stream as Socket).unref();
        }
        child.unref();
        done(ran(ending ?? "exited", ending === null ? code : null, ending ? null : killedBy));
      };
      // 'close' comes once the pipes are drained, unless a process left in the background still
      // holds them: then the output it has sent so far is what the run printed. A real timer,
      // not the clock: it waits for the pipes, not for time the owner set.
      const drained = setTimeout(finish, DRAIN_MS);
      child.once("close", () => {
        clearTimeout(drained);
        finish();
      });
    });
  });
}

// The lines and the characters of output a thread shows; the session reads more (`OUTPUT_LIMIT`).
export const SHOWN_LINES = 40;
export const SHOWN_CHARACTERS = 3_000;

function took(seconds: number): string {
  return seconds < 10 ? `${seconds.toFixed(1)} s` : `${Math.round(seconds)} s`;
}

/** How `run` ended, in one line of the daemon's. */
function ending(run: ShellRun): string {
  const seconds = took(run.seconds);
  switch (run.end) {
    case "exited":
      if (run.exitCode === null) {
        return texts.fill(texts.SHELL_SIGNALLED, { signal: run.signal ?? "", seconds });
      }
      return texts.fill(run.exitCode === 0 ? texts.SHELL_EXITED : texts.SHELL_FAILED, {
        code: run.exitCode,
        seconds,
      });
    case "timedOut":
      return texts.fill(texts.SHELL_TIMED_OUT, { seconds });
    case "stopped":
      return texts.fill(texts.SHELL_STOPPED, { seconds });
    case "notStarted":
      return texts.SHELL_NOT_STARTED;
  }
}

/**
 * What a thread shows of `run`, as markdown: how it ended, then the command and the end of its
 * output in a code block, at most `SHOWN_LINES` lines and `SHOWN_CHARACTERS` characters. The
 * fence is longer than any run of backticks inside, so nothing the command printed can close it,
 * and nothing in it is markup.
 */
export function shellHead(run: ShellRun): string {
  const printed = `${run.stdout}${run.stderr}`.replace(/\n+$/, "");
  const end = printed.length > SHOWN_CHARACTERS ? printed.slice(-SHOWN_CHARACTERS) : printed;
  const lines = end === "" ? [] : end.split("\n");
  // A line the character limit cut is left out whole, unless it is the only one.
  if (end !== printed && lines.length > 1) lines.shift();
  else if (end !== printed) lines[0] = `…${lines[0]}`;
  // Every line printed, those the session's cut left out too: the breaks, less the blank lines
  // at the end, which the code block leaves out.
  const trailing = (/\n*$/.exec(`${run.stdout}${run.stderr}`)?.[0] ?? "").length;
  const all = printed === "" ? 0 : run.lines - trailing + 1;
  const shown = lines.slice(-SHOWN_LINES);
  const left = all - shown.length;
  const block = [
    `$ ${run.command}`,
    ...(left > 0 ? [texts.fill(texts.SHELL_LINES_LEFT_OUT, { count: left })] : []),
    ...shown,
  ].join("\n");
  const longest = Math.max(0, ...[...block.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${ending(run)}\n${fence}\n${block}\n${fence}`;
}
