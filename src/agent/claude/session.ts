/**
 * One Claude Code session over a single `query()` with streaming input.
 *
 * The SDK's `query()` starts one Claude Code process. Prompts reach it through an async iterable
 * the session keeps open, so a prompt can be sent at any moment, in the middle of a turn too
 * (`replay-user-messages` makes Claude Code say which prompts it took). Everything the process
 * says comes back as the records of the query's stream, which a `Translator` turns into the
 * seam's events, and as the calls of the permission callback and of the two hooks the daemon
 * registers. A task of its own (`#pump`) reads that stream.
 */

import { randomUUID } from "node:crypto";
import {
  type EffortLevel,
  type HookCallback,
  type Options,
  type RewindFilesResult,
  type SDKUserMessage,
  type PermissionMode as SdkPermissionMode,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import { getLogger } from "../../log.ts";
import { errorName, isRecord } from "../../values.ts";
import {
  type AgentInfo,
  type AgentSession,
  type ClosedReport,
  type ContextUsage,
  type DaemonActions,
  type FilesRestore,
  type ForkSource,
  type LoadedContext,
  type PermissionMode,
  type Prompt,
  type RequestHandler,
  ResumeRefused,
  RewindRefused,
  type SessionEvent,
  type StartOptions,
} from "../seam.ts";
import { advisorModel, type ResolveSettings, type SettingsSource } from "./advisor.ts";
import { CAPABILITIES } from "./capabilities.ts";
import { DAEMON_SERVER, daemonServer } from "./daemon-tools.ts";
import { GOAL_CLEAR, transcriptEvents } from "./goals.ts";
import { postModelSwitchHookEvents, postToolUseHookEvents, stopHookEvents } from "./hooks.ts";
import { agentInfo, contextUsage as contextUsageOf, loadedContext } from "./info.ts";
import { userMessage } from "./prompt.ts";
import { permissionResult, questionResult, toRequest } from "./requests.ts";
import { filesRestore } from "./rewind.ts";
import { OWN_ENTRYPOINT, type Transcript } from "./transcript.ts";
import { Translator } from "./translate.ts";

export const logger = getLogger("allaboard.agent.claude.session");

// The reason given when the stream ends without an exception.
const PROCESS_EXITED = "the Claude Code process exited";
// How the SDK says the process ended, and the name each way is given. It throws a
// plain `Error` for these, with no class and no code to tell them by, and its troubleshooting
// page says to match on the message (code.claude.com/docs/en/agent-sdk/troubleshooting, read
// 2026-10-11): a nonzero exit, a signal, and an error result the CLI reported before it exited.
// Only the start of the message is read; what follows is the CLI's own words.
const LOST_PROCESS: readonly (readonly [start: string, name: string])[] = [
  ["Claude Code process exited with code ", "ProcessExited"],
  ["Claude Code process terminated by signal ", "ProcessKilled"],
  ["Claude Code returned an error result: ", "ErrorResult"],
];

/**
 * The name of a failure of the SDK: `errorName`, except for an error that names itself no more
 * than `Error` and whose message starts as one of `LOST_PROCESS`.
 */
function lostName(error: unknown): string {
  const name = errorName(error);
  if (name !== "Error" || !(error instanceof Error)) return name;
  return LOST_PROCESS.find(([start]) => error.message.startsWith(start))?.[1] ?? name;
}

/** A Claude Code process that ended, named for how it did; the SDK's own error is its cause. */
export class ProcessLostError extends Error {
  constructor(name: string, cause: unknown) {
    super("the Claude Code process ended", { cause });
    this.name = name;
  }
}

/** `error` as it leaves this class: under its name when it says the process ended, else itself. */
function underItsName(error: unknown): unknown {
  const name = lostName(error);
  return name === errorName(error) ? error : new ProcessLostError(name, error);
}
// What a call is told when nobody could be asked about it. This layer does not import
// `src/core/`, so the core's own text for it (`APPROVAL_UNPOSTED`) is not reused, and it knows
// no chat, so it names none.
const REQUEST_UNSHOWN =
  "allaboard could not show this request to the owner, so nobody approved it.";

/** The members of the SDK's `Query` this class calls: a test passes a fake that has these. */
export interface QueryHandle extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
  stopTask(taskId: string): Promise<void>;
  setPermissionMode(mode: SdkPermissionMode): Promise<void>;
  applyFlagSettings(settings: { effortLevel: EffortLevel | null }): Promise<void>;
  initializationResult(): Promise<unknown>;
  getContextUsage(): Promise<unknown>;
  rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<RewindFilesResult>;
  close(): void;
}

/** The SDK's `query` as this class uses it. */
export type QueryFunction = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => QueryHandle;

/** A session was used after it ended: closed, or its process lost. */
export class SessionClosedError extends Error {
  override readonly name = "SessionClosedError";

  constructor() {
    super("the Claude Code session is closed");
  }
}

/**
 * The settings layers of a thread's session: the owner's own settings apply, as in a terminal.
 * A probe starts a session with another set (`ClaudeStartOptions`).
 */
export const THREAD_SETTINGS_SOURCES: readonly SettingsSource[] = Object.freeze([
  "user",
  "project",
  "local",
]);

/**
 * What a session is started with: the seam's options, the settings layers it reads, and whether
 * Claude Code gets `--chrome`.
 */
export interface SessionConfig extends StartOptions {
  readonly settingsSources: readonly SettingsSource[];
  readonly chrome: boolean;
  /**
   * A session the daemon starts for itself (the usage probe), not for a thread: it is not given
   * the permission to bypass that a thread's `!bypass on` needs, and it keeps the SDK's own
   * defaults.
   */
  readonly bare?: boolean;
  /** What the model may ask the daemon to do; each present member becomes a tool of its own server. */
  readonly actions?: DaemonActions;
  /**
   * With `resume`: the entry the conversation is kept up to (`resumeSessionAt`), everything after
   * it dropped; the backend resolves it from `rewindTo`.
   */
  readonly resumeSessionAt?: string;
  /** With `resumeSessionAt`: the turn it drops, which the CLI checks (`resumeDropsTurn`). */
  readonly resumeDropsTurn?: string;
  /** With `resumeSessionAt`: the conversation's last entry when the cut was made (`rewindToken`). */
  readonly resumeTail?: string;
  /**
   * The owner's own variables for Claude Code, as the daemon's file gives them: they reach the
   * process of a thread's session over everything else in its environment.
   */
  readonly variables?: Readonly<Record<string, string>>;
  /**
   * The session's transcript, read for what only it holds (a goal's changes, the stop hooks'
   * account, the messages saved); absent for a session the daemon starts for itself.
   */
  readonly transcript?: Transcript;
}

/**
 * An unbounded queue read as an async iterable by one consumer. `end` lets what was pushed be
 * read first, then finishes; a `return` from the consumer (a `break`) leaves the queue as it is.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #ended = false;
  #wake: (() => void) | null = null;

  push(item: T): void {
    if (this.#ended) return;
    this.#items.push(item);
    this.#signal();
  }

  end(): void {
    this.#ended = true;
    this.#signal();
  }

  #signal(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        while (this.#items.length === 0 && !this.#ended) {
          await new Promise<void>((resolve) => {
            this.#wake = resolve;
          });
        }
        const item = this.#items.shift();
        if (item === undefined) return { done: true, value: undefined };
        return { done: false, value: item };
      },
      return: async (): Promise<IteratorResult<T>> => ({ done: true, value: undefined }),
    };
  }
}

// The modes Claude Code takes (`PermissionMode` of the SDK). More than the three roles
// `CAPABILITIES` declares: the core hands back the mode a session started in, which the owner's
// own settings choose (`acceptEdits`, `plan`, `dontAsk`), when a bypass is switched off.
const PERMISSION_MODES: ReadonlySet<string> = new Set([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
]);

// Claude Code's own system prompt, which a terminal session works under. With no `systemPrompt`
// the SDK sends a minimal one, "that covers tool calling but omits the rest of the `claude_code`
// preset's content" (Modifying system prompts, read 2026-10-13): 679 characters against about
// 10,000, measured the same day on the first request of both (Claude Code 2.1.296).
// Claude Code records the prompt on a session's first request and reuses it until a compaction.
const SYSTEM_PROMPT = { type: "preset", preset: "claude_code" } as const;

// Previews on a question's options, which the terminal draws beside each option. With no
// `toolConfig` "Claude does not emit previews" (TypeScript reference, `ToolConfig`, read
// 2026-10-20): the tool's description then has no "Preview feature:" section, measured the same
// day on the first request (Claude Code 2.1.304). Markdown is the terminal's format,
// which the chat draws as preformatted text.
const TOOL_CONFIG = { askUserQuestion: { previewFormat: "markdown" } } as const;

// What an interactive session has by default and a session of the SDK does not (sub-agents and
// environment variables pages, read 2026-10-13). Fork mode: every subagent runs in the
// background and the Agent tool loses `run_in_background`; off, Claude picks foreground or
// background, and picked each once in two identical runs. The refill of a session's web
// searches: 100 an hour in the terminal, none otherwise.
const TERMINAL_DEFAULTS: Readonly<Record<string, string>> = {
  CLAUDE_CODE_FORK_SUBAGENT: "1",
  CLAUDE_CODE_WEB_SEARCH_REFILLS_PER_HOUR: "100",
};

// What the daemon asks a session to say on its stream (environment variables page, read
// 2026-10-14): `session_state_changed` records, which carry whether Claude Code is running,
// idle or waiting for an answer. Off by default, in the terminal too.
const SESSION_SIGNALS: Readonly<Record<string, string>> = {
  CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
};

// What the daemon's reading of the transcript stands on (`transcript.ts`); the session's alone, so
// a `claude` the owner runs with `!!` is his own, as in a terminal.
// - The name Claude Code writes on each line, which tells the session's own lines from a
//   terminal's: the SDK's default, which it applies only when the environment it is given has
//   none (`sdk.mjs` 0.3.312), and the daemon's own may carry an editor's.
// - The transcript on disk before each `result`: Claude Code writes it through a queue it drains
//   every 100 ms, and flushes that queue before it yields a turn's result only with
//   `CLAUDE_CODE_EAGER_FLUSH` (Claude Code 2.1.312's own source; no page documents it). Without
//   it a goal's or the stop hooks' lines could reach the next turn; 13 results of 13 had them on
//   disk anyway (measured 2026-10-29).
const TRANSCRIPT_ENVIRONMENT: Readonly<Record<string, string>> = {
  CLAUDE_CODE_ENTRYPOINT: OWN_ENTRYPOINT,
  CLAUDE_CODE_EAGER_FLUSH: "1",
};

/**
 * The environment a thread's session runs in: the terminal's defaults, under the daemon's own
 * environment and the owner's variables, and the signals the daemon reads from the stream on top.
 */
export function sessionEnvironment(
  variables: Readonly<Record<string, string>> = {},
): Record<string, string | undefined> {
  return { ...TERMINAL_DEFAULTS, ...process.env, ...variables, ...SESSION_SIGNALS };
}

/**
 * What the terminal's `/fork` starts its copy with (Claude Code 2.1.312's own source; no page
 * documents it): the copy's id, the moment of the fork and the original's id. With it, a resume of
 * the copy takes no background task of the original's for one of its own that died, and, where
 * sessions can message each other, tells the copy it was made from a session that still runs.
 * Measured on 2026-10-28 (SDK 0.3.312): without it the copy is told the original's background
 * command stopped; with it, that it has one still running, forked from a named live session.
 */
export function forkSource(copy: string, source: ForkSource): Record<string, string> {
  return { CLAUDE_CODE_RESUME_SOURCE_ALIVE: `${copy}|${source.at}|${source.session}` };
}

// A level outside what `CAPABILITIES` declares, or a mode Claude Code does not take, is refused
// (the seam's contract).
function effortOf(level: string): EffortLevel {
  if (!CAPABILITIES.effortLevels.includes(level)) {
    throw new RangeError(`unknown effort level: ${level}`);
  }
  return level as EffortLevel;
}

function modeOf(mode: PermissionMode): SdkPermissionMode {
  if (!PERMISSION_MODES.has(mode)) throw new RangeError(`unknown permission mode: ${mode}`);
  return mode as SdkPermissionMode;
}

/**
 * The model command's turn, read and hidden. The command is pushed under a uuid of its own, which
 * Claude Code replays on the user record and names in `command_lifecycle` (recorded 2026-10-16,
 * Claude Code 2.1.301, `test/fixtures/sdk/model-command.json`): every record from the push to the
 * `completed` of that uuid is the command's, and none of them reaches the core. The caller's wait
 * ends at the command's `result`, or at that `completed` when no result came.
 */
interface CommandTurn {
  readonly id: string;
  /** The wait is over; what is left is the hidden tail up to `completed`. */
  settled: boolean;
  /** Whether a `result` settles the wait; the rename's only end is its own `completed`. */
  readonly byResult: boolean;
  /** Resolves once the wait is over, whichever way; never rejects. */
  readonly over: Promise<void>;
  readonly settle: (error?: unknown) => void;
}

// How long a close that awaits the exit lets the CLI go on by itself: the slowest of three
// measured exits of an idle session was 841 ms (2026-11-07, SDK 0.3.319), so 2.4 times that.
const EXIT_GRACE_MS = 2000;

const NO_REPORT: ClosedReport = { unsaved: null };

export class ClaudeSession implements AgentSession {
  readonly events: AsyncIterable<SessionEvent>;
  readonly #config: SessionConfig;
  readonly #translator = new Translator();
  readonly #queue = new AsyncQueue<SessionEvent>();
  readonly #input = new AsyncQueue<SDKUserMessage>();
  readonly #query: QueryHandle;
  readonly #resolveSettings: ResolveSettings | undefined;
  readonly #finished: Promise<void>;
  #closing = false;
  #ended = false;
  #started = false;
  #command: CommandTurn | null = null;
  // An error result arrived before the process answered the start: a resume it refused.
  #startRefused = false;
  // The work on each record, in the order the records came: what the transcript holds before it,
  // then its own events (`#handle`). A hook joins the same line when it runs, so its events come
  // after every record that came before it: the SDK runs a hook from the loop that queues the
  // records (`readMessages`, `sdk.mjs` 0.3.312) and does not wait for the stream to be read.
  #work: Promise<void> = Promise.resolve();
  // The last read of the transcript failed: the next failure is not logged again.
  #transcriptFailed = false;
  // What a close that awaits the exit decides on, kept from the stream: the last state
  // `session_state_changed` named, whether any background task lives (`background_tasks_changed`
  // replaces its list), and the `session_writes_lost` record.
  #state: unknown = null;
  #liveTasks = false;
  #lost: Record<string, unknown> | null = null;
  // Set while a close waits for the exit: a record that says the CLI is working again ends the wait.
  #cutWait: (() => void) | null = null;
  readonly #exitGraceMs: number;
  // Aborted when the session ends: an action the model asked for stops before it does anything.
  readonly #actionsEnd = new AbortController();

  /** The token of the cut this session was started with, else absent. */
  get rewindToken(): string | undefined {
    return this.#config.resumeTail;
  }

  /** Spawns the Claude Code process: `ready` says when it answered. */
  constructor(
    config: SessionConfig,
    requests: RequestHandler,
    queryFunction: QueryFunction = sdkQuery,
    resolveSettings?: ResolveSettings,
    exitGraceMs: number = EXIT_GRACE_MS,
  ) {
    this.#exitGraceMs = exitGraceMs;
    this.#config = config;
    this.#resolveSettings = resolveSettings;
    this.events = this.#queue;
    this.#query = queryFunction({
      prompt: this.#input,
      options: this.#options(requests),
    });
    this.#finished = this.#pump();
  }

  #options(requests: RequestHandler): Options {
    const { folder, resume, model, effort, chrome, bare, variables, forkOf } = this.#config;
    const { resumeSessionAt, resumeDropsTurn } = this.#config;
    const server = bare ? undefined : daemonServer(this.#config.actions, this.#actionsEnd.signal);
    // Makes bypass possible, not active: `setPermissionMode` switches it on the live session.
    // `replay-user-messages` (CLI reference): Claude Code re-emits each prompt with the uuid the
    // daemon sent it under, which tells a prompt it took into a running turn from one that waits
    // for a turn of its own. The owner's "Enabled by default" reaches an interactive session
    // only: here `--chrome` is what connects Claude Code's Chrome integration.
    const extraArgs: Record<string, string | null> = { "replay-user-messages": null };
    if (chrome) extraArgs.chrome = null;
    return {
      cwd: folder,
      ...(resume !== null && { resume }),
      // The cut of a rewind: the session id is kept (no `forkSession`), and the cut holds only
      // once a prompt is written after it (measured 2026-10-29), which the core takes care of.
      ...(resume !== null && resumeSessionAt !== undefined && { resumeSessionAt }),
      ...(resume !== null && resumeDropsTurn !== undefined && { resumeDropsTurn }),
      // The effort `/effort` set does not survive a resume (measured 2026-09-28), so the daemon
      // keeps it per thread and passes it back here.
      ...(effort !== null && { effort: effortOf(effort) }),
      ...(model !== null && { model }),
      settingSources: [...this.#config.settingsSources],
      includePartialMessages: true,
      // The usage probe starts a session for each read and never resumes one: kept on disk, each
      // would leave a transcript in the owner's projects.
      ...(bare && { persistSession: false }),
      ...(server !== undefined && { mcpServers: { [DAEMON_SERVER]: server } }),
      ...(!bare && {
        // A checkpoint of the files at each prompt, which `!rewind` puts back (a session started
        // without it has none to restore). Every session of a thread is started with it.
        enableFileCheckpointing: true,
        // The agent's guess at the next prompt after each turn, which `!next` offers (#151). The
        // owner's `promptSuggestionEnabled: false` setting still switches it off.
        promptSuggestions: true,
        allowDangerouslySkipPermissions: true,
        systemPrompt: SYSTEM_PROMPT,
        toolConfig: TOOL_CONFIG,
        // `env` replaces the environment the process would inherit, so the daemon's own is
        // passed on: over the terminal's defaults, and under what the owner's file sets. What
        // the daemon reads from the stream is not the owner's to turn off.
        env: {
          ...sessionEnvironment(variables),
          ...TRANSCRIPT_ENVIRONMENT,
          ...(resume !== null && forkOf !== undefined && forkSource(resume, forkOf)),
        },
      }),
      extraArgs,
      canUseTool: async (toolName, input, context) => {
        // A callback that rejects is answered with a `control_response` of subtype `error`
        // (`handleControlRequest`, SDK 0.3.296), which is not a deny. A request nobody could be
        // asked about is refused here, and only the error's name is kept: its message may quote
        // the tool's input.
        try {
          const request = toRequest(toolName, input, context);
          if (request.type === "question") {
            return questionResult(await requests.question(request, context.signal), input);
          }
          return permissionResult(await requests.permission(request, context.signal), input);
        } catch (error) {
          logger.error(`could not ask the owner about a call: ${errorName(error)}`);
          return { behavior: "deny", message: REQUEST_UNSHOWN };
        }
      },
      // The Stop hook's input carries the effort level Claude Code runs at: the footer's only
      // source for it, since no message reports it. Every hook input carries the `cwd` the
      // session works in; PostToolUse reports it after each tool, so a turn stopped or failed
      // before its Stop still moves the footer's branch. PostModelSwitch names the model a
      // `/model` command switched to, before the command's result: the context usage still
      // names the old one after a command.
      hooks: {
        Stop: [{ hooks: [this.#hook(stopHookEvents)] }],
        PostToolUse: [{ hooks: [this.#hook(postToolUseHookEvents)] }],
        PostModelSwitch: [{ hooks: [this.#hook(postModelSwitchHookEvents)] }],
      },
      // The process's stderr may quote the conversation: only its size is kept.
      stderr: (line) => logger.debug(`claude stderr: ${line.length} chars`),
    };
  }

  /**
   * A hook's events, in line behind the records that came before it; the hook answers at once, so
   * Claude Code never waits on the daemon's reading. One of the hidden command's turn (Stop,
   * PostToolUse) is as much the command's as its records: nothing of it reaches the core.
   */
  #hook(events: (input: unknown) => SessionEvent[]): HookCallback {
    return async (input) => {
      const hidden = this.#command !== null;
      this.#inLine(() => {
        if (hidden) return;
        for (const event of events(input)) this.#queue.push(event);
      }, "a hook's input");
      return {};
    };
  }

  /**
   * Reads a record of the hidden model command: none reaches the core. The `result` settles the
   * wait. The command's own `completed` settles it too (a no-op after the result) and ends the
   * hiding; so does its own `cancelled`, the other terminal state `sdk.d.ts` documents (0.3.301,
   * the comment of `cancel_queued`: "a terminal 'cancelled' lifecycle"), which fails a caller that had no result.
   */
  #readCommand(command: CommandTurn, record: unknown): void {
    if (!isRecord(record)) return;
    if (record.type === "result" && command.byResult) command.settle();
    if (record.type !== "command_lifecycle" || record.command_uuid !== command.id) return;
    if (record.state === "completed") {
      command.settle();
      this.#command = null;
    } else if (record.state === "cancelled") {
      command.settle(new Error("the hidden command was cancelled"));
      this.#command = null;
    }
  }

  /**
   * Puts `work` in line after all the work before it. A failure of it is logged by `what` and
   * stops nothing behind it: the line never rejects, so the stream's end always gets through.
   */
  #inLine(work: () => Promise<void> | void, what: string): void {
    this.#work = this.#work.then(work).catch((error: unknown) => {
      logger.error(`could not read ${what}: ${errorName(error)}`);
    });
  }

  /**
   * Where the transcript reached when `record` came (`Transcript.mark`), for a record its read
   * goes with; undefined for one it does not (a partial stream event: what is written comes with
   * whole records). Taken as the record comes, before any later record is.
   */
  #markOf(record: unknown): number | null | undefined {
    const transcript = this.#config.transcript;
    if (transcript === undefined || !isRecord(record) || record.type === "stream_event") return;
    if (typeof record.session_id === "string") transcript.locate(record.session_id);
    return transcript.mark();
  }

  /**
   * The events of what the process wrote to its transcript up to `until` (`#markOf`), the lines
   * before the record it was taken for; never rejects.
   */
  async #readTranscript(until: number | null | undefined): Promise<SessionEvent[]> {
    const transcript = this.#config.transcript;
    if (transcript === undefined || until === undefined) return [];
    let events: SessionEvent[];
    try {
      events = transcriptEvents(await transcript.read(until));
    } catch (error) {
      // An unread transcript loses a goal's lines, not the session; it is read again at the next
      // record, and a failure that lasts is logged once.
      if (!this.#transcriptFailed)
        logger.error(`could not read the transcript: ${errorName(error)}`);
      this.#transcriptFailed = true;
      return [];
    }
    this.#transcriptFailed = false;
    return events;
  }

  /**
   * What the transcript held when `record` came (up to `until`), then `record`'s own events;
   * nothing of either for a record of the hidden command's turn.
   */
  async #handle(record: unknown, until: number | null | undefined, hidden: boolean): Promise<void> {
    const written = await this.#readTranscript(until);
    if (hidden) return;
    for (const event of written) this.#queue.push(event);
    // One record that fails to read must not end the session: its line logs it (`#inLine`).
    for (const event of this.#translator.translate(record)) this.#queue.push(event);
  }

  /**
   * The hidden command's end, for the lines its records' marks did not reach: when the mark of its
   * `completed` or `cancelled` (`until`) is null, or the file was found elsewhere since it was
   * taken (`pathAtMark`; a folder name Claude Code hashed otherwise gives marks of 0 against a path
   * that never exists), one more hidden read follows, with a mark taken in line. A mark that is
   * valid is kept: the caller is resolved at the `result`, so the next prompt may already be
   * running and a mark taken here could cover its lines. On the two paths that do take it, it can
   * cover next-turn lines already written, which are then dropped. Left as they were: a line flushed after
   * this read, and a `stat` that keeps failing past the end of the command, are read with a later
   * record.
   */
  async #dropCommandLines(
    until: number | null | undefined,
    pathAtMark: string | null,
  ): Promise<void> {
    const transcript = this.#config.transcript;
    if (transcript === undefined) return;
    const moved = transcript.path !== pathAtMark;
    if (until !== null && until !== undefined && !moved) return;
    await this.#readTranscript(null);
    await this.#readTranscript(transcript.mark());
  }

  /**
   * Keeps what a close decides on, and ends a wait for the exit at any record but those three:
   * a hook, a replay or a stream event may come before the `running` of a turn that opens.
   */
  #observe(record: unknown): void {
    // A suggestion opens no turn: it comes after the `result`, and the close may be waiting.
    if (isRecord(record) && record.type === "prompt_suggestion") return;
    if (!isRecord(record) || record.type !== "system") {
      this.#cutWait?.();
      return;
    }
    const { subtype } = record;
    if (subtype === "session_state_changed") this.#state = record.state;
    if (subtype === "session_writes_lost") this.#lost = record;
    if (subtype === "background_tasks_changed") {
      // Any task counts, an ambient one too: a notification of it opens a turn all the same.
      const { tasks } = record;
      this.#liveTasks = !Array.isArray(tasks) || tasks.length > 0;
    }
    const quiet =
      subtype === "background_tasks_changed" ||
      subtype === "session_writes_lost" ||
      (subtype === "session_state_changed" && record.state === "idle");
    if (!quiet) this.#cutWait?.();
  }

  /**
   * What the CLI sent as it exited, in the seam's words. A conversation counts only when the
   * record's own session is among those whose transcript lost lines (or none is named).
   */
  #report(): ClosedReport {
    const record = this.#lost;
    if (record === null) return NO_REPORT;
    const kinds = Array.isArray(record.lost) ? record.lost : [];
    const named = record.transcript_session_ids;
    const conversation =
      kinds.includes("transcript") && (!Array.isArray(named) || named.includes(record.session_id));
    const settings = kinds.includes("global_config");
    if (!conversation && !settings) return NO_REPORT;
    const cause =
      record.error_code === "ENOSPC"
        ? "disk_full"
        : record.error_code === "EDQUOT"
          ? "quota"
          : "other";
    return { unsaved: { conversation, settings, cause } };
  }

  /**
   * Waits for the stream to end on its own, for at most the grace; resolves early at a record
   * that cuts the wait.
   */
  #awaitExit(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#cutWait = null;
        resolve();
      };
      const timer = setTimeout(done, this.#exitGraceMs);
      this.#cutWait = done;
      void this.#finished.then(done);
    });
  }

  /** Reads the query's stream until it ends, whatever ends it; never rejects. */
  async #pump(): Promise<void> {
    let reason = PROCESS_EXITED;
    try {
      // Each record is taken as it comes and its work put in line: the loop never waits on a read,
      // so a hook the SDK runs later is always put in line after it. Whether a record is the
      // hidden command's is decided as it comes, when the command is.
      for await (const record of this.#query) {
        this.#observe(record);
        if (!this.#started && isRecord(record) && record.type === "result") {
          this.#startRefused = record.is_error === true;
        }
        const until = this.#markOf(record);
        const pathAtMark = this.#config.transcript?.path ?? null;
        const command = this.#command;
        if (command !== null) this.#readCommand(command, record);
        this.#inLine(() => this.#handle(record, until, command !== null), "a record");
        if (command !== null && this.#command === null) {
          this.#inLine(
            () => this.#dropCommandLines(until, pathAtMark),
            "the hidden command's last lines",
          );
        }
      }
    } catch (error) {
      reason = lostName(error);
    }
    this.#ended = true;
    this.#actionsEnd.abort();
    this.#command?.settle(new SessionClosedError());
    await this.#work;
    if (!this.#closing) {
      logger.error(`session stopped: ${reason}`);
      this.#queue.push({ type: "process_lost", reason });
    }
    this.#queue.end();
    // The process may still be running (a stream that failed): reap it.
    try {
      this.#query.close();
    } catch (error) {
      logger.error(`could not close the process: ${errorName(error)}`);
    }
  }

  /**
   * Resolves once Claude Code answered the start. Rejects with `ResumeRefused` when it refused to
   * resume the stored session, and with the failure itself otherwise; the session is closed then.
   */
  async ready(): Promise<void> {
    try {
      await this.#query.initializationResult();
      this.#started = true;
    } catch (error) {
      // The stream is read to its end first: the error result it carries tells a refused resume
      // from a process that failed to start.
      await this.close();
      if (this.#config.resume !== null && this.#startRefused) {
        // A rewind's start that the CLI refused (its guard, `Resume rejected by
        // --resume-drops-turn:`, or a point it does not know) leaves the session as it was: the
        // thread goes on, not the `ResumeRefused` of a transcript that is gone. Both arrive
        // through `initializationResult`, as an error result (recorded 2026-10-29).
        if (this.#config.resumeSessionAt !== undefined) throw new RewindRefused({ cause: error });
        throw new ResumeRefused({ cause: error });
      }
      throw underItsName(error);
    }
  }

  /**
   * Asks the query. The SDK rejects a request with the error that ended the process, when it
   * did: that one leaves under its name, as the stream's own end does.
   */
  async #ask<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      throw underItsName(error);
    }
  }

  async send(prompt: Prompt): Promise<void> {
    if (this.#closing || this.#ended) throw new SessionClosedError();
    // Before the push: the replay can come back before this call returns.
    this.#translator.promptSent(prompt.id);
    this.#input.push(userMessage(prompt));
  }

  async interrupt(): Promise<void> {
    // An interrupt while the model command runs rejects `setModel` and closes the session (the
    // seam's contract): what the command's turn would still write is never read for a state.
    const command = this.#command;
    if (command !== null && !command.settled) {
      command.settle(new Error("the hidden command was interrupted"));
      await this.close();
      return;
    }
    await this.#ask(() => this.#query.interrupt());
  }

  async stopTask(taskId: string): Promise<void> {
    await this.#ask(() => this.#query.stopTask(taskId));
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.#ask(() => this.#query.setPermissionMode(modeOf(mode)));
  }

  /**
   * Runs Claude Code's own `/model` on the idle session and resolves once its turn is over; the
   * turn is read here and no event of it reaches the core. The SDK's `setModel` is not used: it
   * leaves an override that a later `/model` to the default model's alias does not undo
   * (measured 2026-10-16, SDK 0.3.301). A model the initialization result does not
   * list is refused, since Claude Code answers an unknown one as a success.
   */
  async setModel(model: string | null): Promise<void> {
    if (this.#closing || this.#ended) throw new SessionClosedError();
    if (model !== null && !(await this.info()).models.some((entry) => entry.value === model)) {
      throw new RangeError(`unknown model: ${model}`);
    }
    // The session may have ended during the await above, and `#pump` found no command to end.
    if (this.#closing || this.#ended) throw new SessionClosedError();
    await this.#hidden(`/model ${model ?? "default"}`);
  }

  /** `/goal clear`, read and hidden like the model command: a turn of no model request. */
  async clearGoal(): Promise<void> {
    if (this.#closing || this.#ended) throw new SessionClosedError();
    // A rename may be running (a channel's stop reaches here meanwhile): wait for it, as a caller
    // may queue behind a hidden command, then look again, since the wait can outlast the session.
    while (this.#command !== null && !this.#command.settled) await this.#command.over;
    if (this.#closing || this.#ended) throw new SessionClosedError();
    await this.#hidden(`/${GOAL_CLEAR}`);
  }

  /**
   * Names the session with Claude Code's own `/rename`, the one that updates the title the live
   * process caches: a rename of the transcript file is re-appended over (measured 2026-11-07, SDK
   * 0.3.319). Settles at the command's own `completed` (or `cancelled`), which the daemon's
   * uuid-carrying input makes Claude Code emit; the turn is hidden like the model command's.
   */
  async rename(title: string): Promise<void> {
    if (this.#closing || this.#ended) throw new SessionClosedError();
    await this.#hidden(`/rename ${title}`, false);
  }

  /** Sends `content` as a command whose turn no event shows, and resolves at its result. */
  async #hidden(content: string, byResult = true): Promise<void> {
    // The guard and the marker follow each other with no await between them: two callers cannot
    // both pass. A second command is refused, not queued; a caller that may overlap another
    // (`clearGoal`) waits first. The hidden tail of one
    // that has settled does not count.
    if (this.#command !== null && !this.#command.settled) {
      throw new Error("a hidden command is already running");
    }
    const id = randomUUID();
    let end = (): void => {};
    const over = new Promise<void>((resolve) => {
      end = resolve;
    });
    const done = new Promise<void>((resolve, reject) => {
      const command: CommandTurn = {
        id,
        settled: false,
        byResult,
        over,
        settle: (error) => {
          if (command.settled) return;
          command.settled = true;
          end();
          if (error === undefined) resolve();
          else reject(error);
        },
      };
      this.#command = command;
    });
    this.#input.push(userMessage({ id, content }));
    await done;
  }

  /**
   * Live, with no reconnect (`applyFlagSettings`, SDK 0.3.296): 36 ms in the spike's measurement,
   * 28 ms in the back end's own live check, both on 2026-10-10.
   */
  async setEffort(level: string | null): Promise<void> {
    const effortLevel = level === null ? null : effortOf(level);
    await this.#ask(() => this.#query.applyFlagSettings({ effortLevel }));
  }

  /** The files as they were at the prompt, back or forward (the SDK's `rewindFiles`). */
  async restoreFiles(promptId: string, preview: boolean): Promise<FilesRestore> {
    return filesRestore(
      await this.#ask(() => this.#query.rewindFiles(promptId, { dryRun: preview })),
    );
  }

  async contextUsage(): Promise<ContextUsage> {
    return contextUsageOf(await this.#ask(() => this.#query.getContextUsage()));
  }

  /** Read from the settings files, with no request to the process: 8 to 14 ms (2026-10-28). */
  async advisor(): Promise<string | null> {
    const { folder, settingsSources, variables } = this.#config;
    return advisorModel(
      folder,
      settingsSources,
      sessionEnvironment(variables),
      this.#resolveSettings,
    );
  }

  async loaded(): Promise<LoadedContext> {
    return loadedContext(await this.#ask(() => this.#query.getContextUsage()));
  }

  /**
   * The initialization result holds the models, the commands with their aliases and the mode the
   * session started in (measured 2026-10-10 on SDK 0.3.296), and the account it is logged in to
   * (measured 2026-10-27 on SDK 0.3.310): nothing else is asked.
   */
  async info(): Promise<AgentInfo> {
    return agentInfo(await this.#ask(() => this.#query.initializationResult()));
  }

  /**
   * Ends the input, closes the query and resolves once its stream has ended, so that a new
   * session may resume the same id right after (the process needs real time to flush), with what
   * the CLI reported as it exited. With `awaitExit` the CLI is let exit on its own first (it
   * reports the writes it lost only then), but only when nothing would run after the close: it
   * answered its start, it is idle and no background task lives, since the CLI would
   * open a turn for a task's notification (measured 2026-11-07, SDK 0.3.319).
   */
  async close(options?: { readonly awaitExit?: boolean }): Promise<ClosedReport> {
    if (!this.#closing) {
      this.#closing = true;
      this.#actionsEnd.abort();
      const wait =
        options?.awaitExit === true &&
        !this.#ended &&
        this.#started &&
        this.#state === "idle" &&
        !this.#liveTasks;
      this.#input.end();
      if (wait) await this.#awaitExit();
      try {
        this.#query.close();
      } catch (error) {
        logger.error(`could not close the process: ${errorName(error)}`);
      }
    }
    await this.#finished;
    return this.#report();
  }
}
