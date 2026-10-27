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

/** Each pid of `ps -o pid= -o ppid=` output to its parent's. */
export function parents(output: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const line of output.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) map.set(pid as number, ppid as number);
  }
  return map;
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
    const family = parents(await run("ps", ["-o", "pid=", "-o", "ppid=", "-p", pids], options.env));
    return found.map((entry) => ({
      id: String(entry.pid),
      own: family.get(entry.pid) === options.self,
      busy: entry.busy,
    }));
  } catch {
    return null;
  }
}
