/** The Claude back end as the registry holds it: the entry `claude`. */
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import type { Check, ModuleSetup } from "../../module-setup.ts";
import { AgentConfigError, type AgentEntry } from "../seam.ts";
import { ClaudeBackend, type ClaudeBackendOptions } from "./backend.ts";

// Claude Code's own variables the owner may set in the daemon's file; each reaches a thread's
// session as written, and Claude Code judges its value. `BASH_DEFAULT_TIMEOUT_MS`, in
// milliseconds, is how long a command may run: above 30 minutes it also replaces the limit a
// session of the SDK puts on a command in the background, which a terminal session does not
// have (tools reference, "Time limit for background commands", read 2026-10-13).
// `CLAUDE_CONFIG_DIR` is the folder of a login of its own, for an instance that drives a second
// Claude Code account (environment variables page, "useful for running multiple accounts side by
// side", read 2026-10-17); it is handled below, since the daemon reads the folder too.
export const VARIABLES: readonly string[] = ["BASH_DEFAULT_TIMEOUT_MS", "CLAUDE_CONFIG_DIR"];

const MS_PER_HOUR = 3_600_000;
const DEFAULT_TIMEOUT_HOURS = 4;
// The largest delay a Node timer takes (2^31 - 1 ms); Claude Code's own limit on the variable.
const MAX_TIMER_MS = 2_147_483_647;
// The shortest timeout the wizard takes: 1 minute, stated as 0.02 hours (72000 ms).
const MIN_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_HOURS = 0.02;
// One decimal below the cap (596.5 hours is 2147400000 ms), so the stated bound is accepted.
const MAX_TIMEOUT_HOURS = 596.5;

/**
 * The declared variables the owner's file sets, each read by its name: the daemon hands a module
 * its variables readable by lookup and shown by nothing, so a spread of them copies none.
 */
function set(variables: Readonly<Record<string, string>>): Record<string, string> {
  const found: Record<string, string> = {};
  for (const name of VARIABLES) {
    const value = variables[name];
    if (value !== undefined) found[name] = value;
  }
  return found;
}

/**
 * The folder the owner's file names, else the one the daemon's environment holds (an empty one is
 * none), `~` read as the home and `${HOME}` already expanded by the daemon; undefined when neither
 * names one. Refused unless absolute: a relative path would read from the working directory, the
 * terminal's folder in one run and `/` under launchd. The value is passed on as written once the
 * tilde is read: Claude Code keys the Keychain entry of a login by the folder's string, so a
 * trailing slash is another entry. (The core's `expandUser` is not importable from an agent
 * module, so the tilde is read here.)
 */
function configDirOf(written: string | undefined, home: string): string | undefined {
  const inherited = written === undefined ? process.env.CLAUDE_CONFIG_DIR || undefined : undefined;
  const value = written ?? inherited;
  if (value === undefined) return undefined;
  // Concatenated, not joined: `join` would rewrite `~/./work` or a doubled slash, and the Keychain
  // entry follows the string.
  const expanded = value === "~" || value.startsWith("~/") ? home + value.slice(1) : value;
  if (!isAbsolute(expanded)) {
    const where =
      inherited === undefined ? "" : ", set in the daemon's environment and not in .env,";
    throw new AgentConfigError(
      `CLAUDE_CONFIG_DIR${where} must be an absolute path, or one starting with ~/; it is "${value}"`,
    );
  }
  return expanded;
}

/**
 * The two questions of `allaboard setup`: the timeout, which Enter sets to 4 hours, and the folder, which Enter skips. The folder is not
 * required to exist: a second login creates it. The same rule the daemon applies at build.
 */
export function claudeSetup(home: string): ModuleSetup {
  return {
    intro: [],
    questions: [
      {
        variable: "BASH_DEFAULT_TIMEOUT_MS",
        message: `Bash command timeout in hours (BASH_DEFAULT_TIMEOUT_MS, Enter for ${DEFAULT_TIMEOUT_HOURS}):`,
        secret: false,
        optional: false,
        default: String(DEFAULT_TIMEOUT_HOURS),
        check: async (answer): Promise<Check> => {
          const hours = /^\d+(\.\d+)?$/.test(answer) ? Number(answer) : Number.NaN;
          const ms = Math.round(hours * MS_PER_HOUR);
          return ms >= MIN_TIMEOUT_MS && ms <= MAX_TIMER_MS
            ? { value: String(ms), note: `${ms} ms` }
            : {
                refusal: `A timeout is a number of hours from ${MIN_TIMEOUT_HOURS} to ${MAX_TIMEOUT_HOURS}, such as 0.5 or 4.`,
              };
        },
      },
      {
        variable: "CLAUDE_CONFIG_DIR",
        message:
          "Claude Code configuration folder (CLAUDE_CONFIG_DIR, optional, Enter for ~/.claude):",
        secret: false,
        optional: true,
        check: async (answer): Promise<Check> => {
          try {
            configDirOf(answer, home);
            return {};
          } catch (error) {
            if (error instanceof AgentConfigError) return { refusal: error.message };
            throw error;
          }
        },
      },
    ],
  };
}

/**
 * The entry that builds the Claude back end. `options` are what a test replaces: the SDK's
 * query, the owner's home, the usage probe's start.
 */
export function claudeAgent(options: ClaudeBackendOptions = {}): AgentEntry {
  return {
    required: [],
    optional: VARIABLES,
    executable: "claude",
    setup: () => claudeSetup(options.home ?? homedir()),
    build: (context) => {
      const variables = set(context.variables);
      const configDir = configDirOf(variables.CLAUDE_CONFIG_DIR, options.home ?? homedir());
      if (configDir !== undefined) {
        variables.CLAUDE_CONFIG_DIR = configDir;
        // The SDK's `listSessions`, which the back end calls in the daemon's own process, has no
        // option for the folder (`ListSessionsOptions`, sdk.d.ts 0.3.301) and reads
        // `process.env.CLAUDE_CONFIG_DIR` (bundled sdk.mjs, not documented): without this, it
        // would look in the default login's folder, and `!resume` and the Home tab's session
        // list would come up empty. (The cleanup reads the back end's own projects folder and
        // is not affected.) It is written once, at build. The usage probe's bare session passes
        // no `env`, so the SDK gives it this environment, and the limits it reads are those of
        // this login.
        process.env.CLAUDE_CONFIG_DIR = configDir;
      }
      return new ClaudeBackend({
        clock: context.clock,
        variables,
        ...(configDir !== undefined && { configDir }),
        ...options,
      });
    },
  };
}
