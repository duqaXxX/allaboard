/**
 * The processes that hold a session open, from Claude Code's own list: `claude agents --json`
 * prints "active sessions (interactive and background) as a JSON array" (CLI reference,
 * code.claude.com/docs/en/cli-reference, read 2026-10-27), each with `pid`, `sessionId` and
 * `status` (`idle` or `busy`). A session the daemon started is in it too, as `interactive`
 * like a terminal's (measured 2026-10-27, Claude Code 2.1.310 and 2.1.311: 38 of 38 samples
 * right, the SDK's process and the terminal's, idle, busy and gone). What tells the daemon's own
 * from a terminal is the parent process: the SDK starts Claude Code as a child of the daemon.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isRecord } from "../../values.ts";
import type { SessionHolder } from "../seam.ts";

// The list answers in about 0.1 s (measured 2026-10-27); an answer this late is no answer.
export const HOLDERS_TIMEOUT_MS = 5000;

/** Runs `command` with `args` and resolves its standard output; rejects when it fails. */
export type RunOutput = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<string>;

export const runOutput: RunOutput = (command, args, env) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { env, timeout: HOLDERS_TIMEOUT_MS, encoding: "utf8" },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

/** The entries of `claude agents --json` for `session`: pid and whether it runs a turn. */
export function listed(output: string, session: string): { pid: number; busy: boolean }[] {
  const entries: unknown = JSON.parse(output);
  if (!Array.isArray(entries)) throw new TypeError("not a list");
  return entries.flatMap((entry) =>
    isRecord(entry) && entry.sessionId === session && typeof entry.pid === "number"
      ? [{ pid: entry.pid, busy: entry.status === "busy" }]
      : [],
  );
}

/** A process as `ps` shows it: its parent, and when it started (null when `ps` gave none). */
export interface Process {
  readonly ppid: number;
  readonly started: string | null;
}

/**
 * Each pid of `ps -o pid= -o ppid= -o lstart=` output to its parent and start time. `lstart` is
 * five words (`Sun Nov  1 16:09:50 2026` under the C locale, measured on macOS 2026-11-01), kept
 * as one string with its spaces collapsed.
 */
export function parents(output: string): Map<number, Process> {
  const map = new Map<number, Process>();
  for (const line of output.split("\n")) {
    const [pid, ppid, ...start] = line.trim().split(/\s+/);
    if (Number.isInteger(Number(pid)) && Number.isInteger(Number(ppid)) && pid && ppid) {
      map.set(Number(pid), {
        ppid: Number(ppid),
        started: start.length > 0 ? start.join(" ") : null,
      });
    }
  }
  return map;
}

/**
 * The id of a holder: its pid and start time, since a pid alone is handed to another process once
 * the first is gone and the id is stored. With no start time the id carries a random part, so it
 * matches nothing stored and the owner is asked again (the safe side).
 */
export function holderId(pid: number, started: string | null | undefined): string {
  return `${pid}@${started ?? `unknown-${randomUUID()}`}`;
}

export interface HoldersOptions {
  /** The executable that answers `agents --json`. */
  readonly command: string;
  /** The environment it runs with: the login's `CLAUDE_CONFIG_DIR` decides whose list it is. */
  readonly env: NodeJS.ProcessEnv;
  /** The daemon's own process id: a holder whose parent it is was started by the daemon. */
  readonly self: number;
  readonly run?: RunOutput;
}

/**
 * The processes that hold `session` open; null when either list could not be read (no
 * `ps` on the machine, a CLI that answers otherwise), so the caller says nothing it cannot know.
 */
export async function sessionHolders(
  session: string,
  options: HoldersOptions,
): Promise<SessionHolder[] | null> {
  const run = options.run ?? runOutput;
  try {
    const found = listed(await run(options.command, ["agents", "--json"], options.env), session);
    if (found.length === 0) return [];
    const pids = found.map((entry) => String(entry.pid)).join(",");
    // `LC_ALL=C` and `TZ=UTC` keep `lstart` the same words, and the same hour, in every login.
    const family = parents(
      await run("ps", ["-o", "pid=", "-o", "ppid=", "-o", "lstart=", "-p", pids], {
        ...options.env,
        LC_ALL: "C",
        TZ: "UTC",
      }),
    );
    // A pid with no row is gone since the list was read: `ps -p` prints the live rows, and exits 1
    // only when none is left, which reads as null.
    return found.flatMap((entry) => {
      const process = family.get(entry.pid);
      if (process === undefined) return [];
      return [
        {
          id: holderId(entry.pid, process.started),
          own: process.ppid === options.self,
          busy: entry.busy,
        },
      ];
    });
  } catch {
    return null;
  }
}
