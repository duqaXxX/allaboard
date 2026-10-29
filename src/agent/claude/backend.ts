/**
 * The Claude back end: what the core asks of an agent, answered over the Agent SDK and over
 * Claude Code's own records on disk. The only module a caller builds; the trust gate for a
 * session's start is the core's (`folderTrusted` is its question to ask), not this class's.
 */
import { homedir } from "node:os";
import {
  forkSession as sdkForkSession,
  getSessionInfo as sdkGetSessionInfo,
  getSessionMessages as sdkGetSessionMessages,
  tagSession as sdkTagSession,
} from "@anthropic-ai/claude-agent-sdk";
import type { Clock } from "../../clock.ts";
import { shellQuote } from "../../text.ts";
import type {
  AgentBackend,
  AgentSession,
  AgentWords,
  ForeignTurns,
  ListedSession,
  Repository,
  RequestHandler,
  RewindPoint,
  SavedMessage,
  SessionHolder,
  ShellMode,
  StartOptions,
  UsageLimits,
} from "../seam.ts";
import { RewindRefused } from "../seam.ts";
import type { ResolveSettings, SettingsSource } from "./advisor.ts";
import { CAPABILITIES } from "./capabilities.ts";
import { chromeEnabled } from "./chrome.ts";
import { GOAL_CLEAR } from "./goals.ts";
import { type RunOutput, sessionHolders } from "./holders.ts";
import { aliveSessions, byLastActivity, directorySessions, projectsDir } from "./listing.ts";
import { type RewindStart, rewindPoints, rewindStart } from "./rewind.ts";
import { ClaudeSession, type QueryFunction, THREAD_SETTINGS_SOURCES } from "./session.ts";
import { shellMode } from "./shell.ts";
import { TOOLS } from "./tools.ts";
import { Transcript } from "./transcript.ts";
import { trustedRepository, untrustedRepository, workspaceTrusted } from "./trust.ts";
import { type GetSessionMessages, turnsAfter } from "./turns.ts";
import { type BareStart, UsageProbe } from "./usage-probe.ts";

export const NAME = "Claude Code";

/**
 * The shell line that continues a session in a terminal, on the same session id;
 * `environment` is what precedes `claude`.
 */
function terminalWith(environment: string): string {
  return `cd {directory} && ${environment}claude --resume {session}`;
}

/**
 * The same line for a session whose process was closed during a turn: with
 * `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` Claude Code continues "if the previous session ended
 * mid-turn" (environment variables reference, read 2026-10-27), and the terminal does so by
 * itself, running again the call that was cut (measured 2026-10-27, Claude Code 2.1.311; without
 * the variable it waits for a prompt).
 */
function continueWith(environment: string): string {
  return `cd {directory} && ${environment}CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1 claude --resume {session}`;
}

/**
 * The shell line that opens Claude Code in a folder, whose trust dialog records the folder for
 * the login `environment` names (`CLAUDE_CONFIG_DIR`): another login's record does not count.
 */
function trustWith(environment: string): string {
  return `cd {directory} && ${environment}claude`;
}

// The commands `docs/limits.md` lists as not offered, which a session of the SDK refuses with
// `/<name> isn't available in this environment.` (measured on Claude Code 2.1.292 on 2026-10-09
// and 2.1.303 on 2026-10-20; claim P23 sends each to every release). `test/docs.test.ts` holds
// the two lists to the same names (`/plan` is not among them: `!plan` is a word of the daemon's own). What follows a name is what the page says to do instead.
const SETTINGS_APPLY = "The settings you made in the terminal apply: change them there.";
const BOUND_FOLDER = "A thread works in the folder its channel was bound to.";
const NOT_OFFERED: Readonly<Record<string, string | null>> = Object.freeze({
  branch: null,
  subtask: null,
  btw: null,
  background: null,
  bg: null,
  cd: BOUND_FOLDER,
  "add-dir": BOUND_FOLDER,
  export: "Copy the reply from its thread.",
  copy: "Copy the reply from its thread.",
  permissions: SETTINGS_APPLY,
  memory: SETTINGS_APPLY,
  hooks: SETTINGS_APPLY,
  skills: SETTINGS_APPLY,
  tasks: SETTINGS_APPLY,
  sandbox: SETTINGS_APPLY,
  voice: "Send an audio clip instead.",
});

export const WORDS: AgentWords = Object.freeze({
  author: "Claude",
  command: "claude",
  examples: "`!compact`, `!model opus`",
  commandPrefix: "/",
  // `/clear` starts a new session under any of its names (aliases `/reset` and `/new`: commands
  // reference, code.claude.com/docs/en/commands, read 2026-10-02, and the list SDK 0.2.163
  // reports); `/login` and `/logout` act on the host's own login.
  newSession: ["clear", "reset", "new"],
  login: "login",
  logout: "logout",
  terminal: terminalWith(""),
  terminalContinue: continueWith(""),
  trust: trustWith(""),
  notOffered: NOT_OFFERED,
  goalClear: GOAL_CLEAR,
});

/**
 * `WORDS` for a back end whose sessions use the login in `configDir`: the line that continues a
 * session in a terminal names that folder, since a terminal reads `~/.claude` without it. The
 * folder is quoted for a shell as `{directory}` is; a brace in it is kept out of reach of the
 * template's fields, `'"{"'` being the same word to a shell.
 */
function wordsFor(configDir: string | undefined): AgentWords {
  if (configDir === undefined) return WORDS;
  const folder = shellQuote(configDir).replaceAll("{", `'"{"'`);
  const environment = `CLAUDE_CONFIG_DIR=${folder} `;
  return Object.freeze({
    ...WORDS,
    terminal: terminalWith(environment),
    terminalContinue: continueWith(environment),
    trust: trustWith(environment),
  });
}

export interface ClaudeBackendOptions {
  /** The SDK's `query`; a test passes a fake. */
  readonly query?: QueryFunction;
  /** The owner's home, where Claude Code keeps its record of trust and of Chrome. */
  readonly home?: string;
  /**
   * The folder of a login with its own (`CLAUDE_CONFIG_DIR`), absolute: the records and the
   * transcripts are read there. Absent, the daemon's environment's, else the owner's home. The
   * SDK's listing reads the environment alone, so a caller that gives a folder here has it there
   * too (the module writes it).
   */
  readonly configDir?: string;
  /** How the usage probe starts its session: `startBare`, unless a test gives another. */
  readonly bareStart?: BareStart;
  /** Every wait of the usage probe; the system clock when absent. */
  readonly clock?: Clock;
  /** The owner's own variables for Claude Code, which a thread's session is started with. */
  readonly variables?: Readonly<Record<string, string>>;
  /** Runs `claude agents --json` and `ps` for `sessionHolders`; a test passes a fake. */
  readonly runOutput?: RunOutput;
  /** The SDK's `getSessionMessages`; a test passes a fake. */
  readonly getSessionMessages?: GetSessionMessages;
  /** The SDK's `resolveSettings`, which reads the advisor; a test passes a fake. */
  readonly resolveSettings?: ResolveSettings;
}

/**
 * `StartOptions` and the settings layers to read, which only a probe sets: a thread's session
 * reads all three, so the owner's own settings apply (`THREAD_SETTINGS_SOURCES`).
 */
export interface ClaudeStartOptions extends StartOptions {
  readonly settingsSources?: readonly SettingsSource[];
}

export class ClaudeBackend implements AgentBackend {
  readonly name = NAME;
  readonly words: AgentWords;
  readonly tools = TOOLS;
  readonly capabilities = CAPABILITIES;
  readonly #query: QueryFunction | undefined;
  readonly #home: string;
  readonly #variables: Readonly<Record<string, string>>;
  readonly #configDir: string | undefined;
  readonly #projects: string;
  readonly #probe: UsageProbe;
  readonly #runOutput: RunOutput | undefined;
  readonly #getSessionMessages: GetSessionMessages | undefined;
  readonly #resolveSettings: ResolveSettings | undefined;
  readonly shell: ShellMode;

  constructor(options: ClaudeBackendOptions = {}) {
    this.#query = options.query;
    this.#home = options.home ?? homedir();
    this.#variables = options.variables ?? {};
    // An empty variable is no folder, as Claude Code reads it.
    this.#configDir = options.configDir ?? (process.env.CLAUDE_CONFIG_DIR || undefined);
    this.#projects = projectsDir(this.#configDir, this.#home);
    this.words = wordsFor(this.#configDir);
    this.shell = shellMode(this.#variables);
    this.#runOutput = options.runOutput;
    this.#getSessionMessages = options.getSessionMessages;
    this.#resolveSettings = options.resolveSettings;
    const bare = options.bareStart ?? ((folder, requests) => this.startBare(folder, requests));
    this.#probe = new UsageProbe(this.#home, bare, { clock: options.clock });
  }

  /**
   * Starts Claude Code and returns once it answered. Rejects with `ResumeRefused` when it
   * refuses to resume `options.resume`, and with the failure itself when it cannot start.
   * Whether the owner trusted the folder is the caller's to check first (`folderTrusted`).
   */
  async start(options: ClaudeStartOptions, requests: RequestHandler): Promise<ClaudeSession> {
    // Read at every start, so a change in `/chrome` holds from a session's next start.
    const chrome = await chromeEnabled(this.#home, this.#configDir);
    const rewind = await this.#rewindStart(options);
    // Before the process starts: what the transcript holds by then was not written by it.
    const transcript = await Transcript.open(this.#projects, options.folder, options.resume);
    const session = new ClaudeSession(
      {
        ...options,
        transcript,
        ...(rewind !== null && {
          resumeSessionAt: rewind.at,
          resumeTail: rewind.tail,
          ...(rewind.drops !== undefined && { resumeDropsTurn: rewind.drops }),
        }),
        settingsSources: options.settingsSources ?? THREAD_SETTINGS_SOURCES,
        chrome,
        variables: this.#variables,
      },
      requests,
      this.#query,
      this.#resolveSettings,
    );
    await session.ready();
    return session;
  }

  /**
   * Where a start with `rewindTo` resumes: null for a start without it. Rejects with
   * `RewindRefused` for a prompt the conversation does not hold or that is its first, which has
   * no earlier entry to resume at.
   */
  async #rewindStart(
    options: StartOptions,
  ): Promise<(RewindStart & { readonly tail: string }) | null> {
    if (options.rewindTo === undefined || options.resume === null) return null;
    const read = this.#getSessionMessages ?? sdkGetSessionMessages;
    // The system entries (compact boundaries, notices) are chain entries too: the kept turn's
    // last entry may be one. Entries `getSessionMessages` does not list at all (attachments, the
    // markers of an interrupted turn) stay out of sight; see `rewindStart`.
    const messages = await read(options.resume, {
      dir: options.folder,
      includeSystemMessages: true,
    });
    // The conversation's last entry stands for it: a cut that waits for a prompt is asked for
    // again with it, and refused once something was written after it.
    const tail = messages.at(-1)?.uuid ?? "";
    if (options.rewindToken !== undefined && options.rewindToken !== tail) {
      throw new RewindRefused();
    }
    const start = rewindStart(messages, options.rewindTo);
    if (start === null) throw new RewindRefused();
    return { ...start, tail };
  }

  /**
   * The prompts of a session of `folder`, oldest first, from its conversation as the SDK reads it
   * (`rewindPoints`).
   */
  async prompts(folder: string, session: string): Promise<readonly RewindPoint[]> {
    const read = this.#getSessionMessages ?? sdkGetSessionMessages;
    return rewindPoints(await read(session, { dir: folder }));
  }

  /**
   * Starts a session for the daemon's own use, the usage probe's: the folder and no setting
   * source, without the permission to bypass and without the Chrome flag, which only a thread's
   * session is given. Fails as `start` does.
   */
  async startBare(folder: string, requests: RequestHandler): Promise<AgentSession> {
    const session = new ClaudeSession(
      {
        folder,
        resume: null,
        settingsSources: [],
        model: null,
        effort: null,
        chrome: false,
        bare: true,
      },
      requests,
      this.#query,
    );
    await session.ready();
    return session;
  }

  /** The sessions of `folder` alone, newest first by their files' times. */
  listSessions(folder: string): Promise<readonly ListedSession[]> {
    return directorySessions(folder);
  }

  /**
   * `sessions` of `folder` by their last message, newest first, as the terminal's picker shows
   * them. Dating reads files, so a caller that shows only some of a folder's sessions passes
   * those alone.
   */
  datedSessions(folder: string, sessions: readonly ListedSession[]): Promise<ListedSession[]> {
    return byLastActivity(folder, sessions, { projects: this.#projects });
  }

  /** The session ids alive in `folder`, or null when it cannot tell (the pruning keeps them). */
  aliveSessions(folder: string): Promise<ReadonlySet<string> | null> {
    return aliveSessions(folder, this.#projects);
  }

  folderTrusted(folder: string): Promise<boolean> {
    return workspaceTrusted(folder, this.#home, this.#configDir);
  }

  trustedRepository(folder: string): Promise<Repository | null> {
    return trustedRepository(folder, this.#home, this.#configDir);
  }

  untrustedRepository(folder: string): Promise<Repository | null> {
    return untrustedRepository(folder, this.#home, this.#configDir);
  }

  /** The limits `/usage` reports now, read by a session of the back end's own. */
  usageLimits(): Promise<UsageLimits> {
    return this.#probe.read();
  }

  /**
   * Sets or clears (`tag` null) the tag of a session of `folder`, in its transcript: the SDK
   * appends a `tag` entry, an empty one to clear, and the last entry wins. Like the SDK's
   * listing it finds the transcript through `CLAUDE_CONFIG_DIR` in the daemon's environment,
   * which `module.claudeAgent` writes from the same folder it gives this back end as `configDir`
   * (an instance with a login of its own); with none set, the SDK uses the default login's.
   * Measured on 2026-10-19 (SDK 0.3.302, CLI 2.1.302): setting, clearing and changing the tag
   * of a session whose query is alive holds through later turns and the close; the tag reaches
   * none of the 8 request bodies captured, so the model never sees it; the terminal's
   * `/resume` picker prints it as `#name`.
   */
  tagSession(folder: string, session: string, tag: string | null): Promise<void> {
    return sdkTagSession(session, tag, { dir: folder });
  }

  /**
   * Copies a session of `folder` into a new transcript with fresh message ids, as the terminal's
   * `/fork` does, through `CLAUDE_CONFIG_DIR` as `tagSession` does. Measured on 2026-10-28 (SDK
   * 0.3.312, CLI 2.1.312): the original is left as it was; the copy is listed beside it, named
   * `<title> (fork)` without a `title`; a resume of the copy runs the model the original last
   * ran, a switch included, and reads the original's prompt cache; its system prompt is the
   * original's, with no instruction to work in a worktree of its own, which the terminal's
   * `/fork` gives.
   */
  async forkSession(folder: string, session: string, title: string | null): Promise<string> {
    const forked = await sdkForkSession(session, {
      dir: folder,
      ...(title === null ? {} : { title }),
    });
    return forked.sessionId;
  }

  /**
   * The title Claude Code shows for a session of `folder`: `customTitle`, which holds the one
   * Claude Code generated and the owner's `/rename` alike (the declaration says "/rename only";
   * measured on 2026-10-20, SDK 0.3.302, CLI 2.1.302: a generated title is there at the `result`
   * of the turn that wrote it, usually the first, sometimes the third or later). `summary` is not
   * read: it falls back to the first prompt while there is no title. Reads the session's file
   * through `getSessionInfo` alone, since it runs after every turn.
   */
  async sessionTitle(folder: string, session: string): Promise<string | null> {
    const info = await sdkGetSessionInfo(session, { dir: folder });
    return info?.customTitle?.trim() || null;
  }

  /**
   * The processes that hold `session` open, from Claude Code's list of active sessions, read
   * for this back end's login: the terminal's `claude` on the host, which the service's `PATH`
   * finds, with `CLAUDE_CONFIG_DIR` when the login has a folder of its own.
   */
  sessionHolders(session: string): Promise<SessionHolder[] | null> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.#configDir !== undefined) env.CLAUDE_CONFIG_DIR = this.#configDir;
    return sessionHolders(session, {
      command: WORDS.command,
      env,
      self: process.pid,
      ...(this.#runOutput !== undefined && { run: this.#runOutput }),
    });
  }

  /** What another process wrote to a session of `folder` after `after` (`turns.turnsAfter`). */
  turnsAfter(folder: string, session: string, after: SavedMessage): Promise<ForeignTurns> {
    return turnsAfter(folder, session, after, {
      projects: this.#projects,
      ...(this.#getSessionMessages !== undefined && {
        getSessionMessages: this.#getSessionMessages,
      }),
    });
  }

  /** Stops the usage probe: its session is closed and no read starts another. */
  close(): Promise<void> {
    return this.#probe.stop();
  }
}
