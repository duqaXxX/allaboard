/**
 * The plain agent: a second, smaller back end of the agent seam, for the tests. It imports the
 * seam and nothing else of the daemon, so a test run with it shows what the core does with an
 * agent that is not Claude.
 *
 * It declares two effort levels that cannot change on a live session, one permission mode,
 * questions, two commands of its own and session listing. It lacks subagents, background tasks,
 * compaction, usage limits, a model list, a prompt during a turn and folder trust. A session is
 * named (`session_started`) with its first prompt, as Claude's is: until then it has no id the
 * core could resume; `namedAtStart` names it at the start instead, as an agent that allots an id
 * before any prompt does.
 *
 * A test scripts what each prompt does with `agent.next(...steps)`: one turn per call, played by
 * the next prompt of any session, in order (a prompt past the script gets `say("ok")`). A prompt
 * that starts with `/` and names one of the agent's commands runs the command and takes no turn
 * of the script.
 *
 *   const store = new PlainStore(); // the agent's record of sessions; a test that keeps it and
 *   const agent = new PlainAgent({ store }); // hands it to a new agent has restarted the daemon
 *   agent.next(say("Reading it."), call("Shell", { command: "ls" }, { permission: true }));
 *   agent.next(question("Which one?", ["red", "blue"]), say("Done."));
 *   agent.next(say("Working"), hold());   // waits for `interrupt()` or `session.release()`
 *   agent.next(fail("The request failed."));
 *   agent.next(say("Half"), die());       // the process is gone: `process_lost`
 *   agent.failNextStart(new Error("x"));  // the next `start` rejects with it
 *   agent.sessions;                       // every session started, with `prompts`, `answers`
 */
import type {
  AgentBackend,
  AgentContext,
  AgentEntry,
  AgentInfo,
  AgentSession,
  AgentWords,
  Capabilities,
  CommandInfo,
  ContextUsage,
  FileChange,
  FilesRestore,
  ForeignTurns,
  GoalChange,
  ListedSession,
  LoadedContext,
  ModelInfo,
  PermissionAnswer,
  PermissionMode,
  PermissionRequest,
  Prompt,
  Question,
  QuestionAnswer,
  QuestionRequest,
  Repository,
  RequestHandler,
  RewindPoint,
  SavedMessage,
  ScheduledJob,
  SessionEvent,
  SessionHolder,
  ShellMode,
  ShellRun,
  StartOptions,
  ToolVocabulary,
} from "../../src/agent/seam.ts";
import { NO_TOOL_WORDS, ResumeRefused, RewindRefused } from "../../src/agent/seam.ts";

export const PLAIN_NAME = "Plain";

/**
 * The plain agent's own tool vocabulary, in names no real agent uses: a `run` and a `look` tool
 * the terminal would fold in words, a `change` tool whose edits it previews as `Modify`, an `ask`
 * tool that puts questions, a `delegate` tool that starts a task and a `propose` tool whose approval
 * asks for a plan, written under `steps`.
 */
export const PLAIN_TOOLS: ToolVocabulary = Object.freeze({
  ...NO_TOOL_WORDS,
  words: Object.freeze<ToolVocabulary["words"]>({
    run: ["Executed {n} job", "Executed {n} jobs"],
    look: ["Looked at {n} file", "Looked at {n} files"],
  }),
  askers: Object.freeze(["ask"]),
  launchers: Object.freeze(["delegate"]),
  previews: Object.freeze({ change: "Modify" }),
  failsCounted: Object.freeze(["run"]),
  described: Object.freeze({ run: "summary" }),
  commanded: Object.freeze({ run: "line" }),
  plan: Object.freeze({
    tool: "propose",
    keys: Object.freeze(["steps", "scratch"]),
    text: "steps",
  }),
});

export const PLAIN_WORDS: AgentWords = Object.freeze({
  author: "Plain",
  command: "plain",
  examples: "`!echo hello`, `!count one two`",
  // Not the `/` of the one real agent: a core that assumed it would send `/echo` and read nothing.
  commandPrefix: ":",
  newSession: ["restart"],
  login: "signin",
  logout: "signout",
  terminal: "cd {directory} && plain --resume {session}",
  terminalContinue: "cd {directory} && plain --resume {session} --go-on",
  trust: null,
  // `count` is offered too: the session's own list wins over this one.
  notOffered: Object.freeze({
    undo: "Ask the plain agent to put it back.",
    panel: null,
    count: null,
  }),
  goalClear: null,
});

/** The one permission mode of the plain agent. */
export const PLAIN_MODE = "standard";

export const PLAIN_CAPABILITIES: Capabilities = Object.freeze({
  effortLevels: Object.freeze(["brief", "full"]),
  effortDefault: "standard",
  liveEffort: false,
  permissionModes: Object.freeze({ default: PLAIN_MODE, auto: null, bypass: null, plan: null }),
  subagents: false,
  backgroundTasks: false,
  foldedNotifications: false,
  compaction: false,
  declaredState: false,
  questions: true,
  usageLimits: false,
  models: false,
  commands: true,
  promptDuringTurn: false,
  sessionListing: true,
  folderTrust: false,
  sessionTags: false,
  sessionTitles: false,
  sessionForks: true,
  fileRestore: false,
  conversationRewind: false,
  goals: false,
  scheduledJobs: false,
  shellCommands: false,
  sessionHolders: false,
  foreignTurns: false,
  advisor: false,
  loadedContext: false,
});

/** The two commands of the agent, run by a prompt `:echo text` and `:count text`. */
export const PLAIN_COMMANDS: readonly CommandInfo[] = Object.freeze([
  { name: "echo", description: "Say the text back", argumentHint: "<text>", aliases: ["say"] },
  { name: "count", description: "Count the words", argumentHint: "<text>", aliases: [] },
]);

const VERSION = "plain-1.0";

// The steps of a turn.

export interface CallOptions {
  /** The call's output; `done` when absent. */
  readonly output?: string;
  /** The call fails when it runs (an allowed call, or one that asks nothing). */
  readonly isError?: boolean;
  /** The call asks the owner first (`RequestHandler.permission`); a denial ends it as an error. */
  readonly permission?: boolean;
  /** The agent gives the request up while the handler waits (aborts the signal it passed). */
  readonly giveUp?: boolean;
  /** What the call did to a file, as the end of a call reports it; none when absent. */
  readonly fileChange?: FileChange;
}

export type PlainStep =
  | { readonly say: string }
  | { readonly whole: string }
  | {
      readonly call: string;
      readonly input: Readonly<Record<string, unknown>>;
      readonly options: CallOptions;
    }
  | { readonly question: readonly Question[]; readonly giveUp: boolean }
  | { readonly fail: string }
  | { readonly effort: string | null }
  | { readonly model: string }
  | { readonly goal: GoalChange }
  | { readonly saved: SavedMessage }
  | { readonly jobs: readonly ScheduledJob[] }
  | { readonly hold: true }
  | { readonly die: true };

/** A text written piece by piece, as deltas of one message. */
export function say(text: string): PlainStep {
  return { say: text };
}

/** A text that arrives whole, as the output of a command does. */
export function whole(text: string): PlainStep {
  return { whole: text };
}

/** A tool call, started and ended; with `permission` it asks the owner between the two. */
export function call(
  toolName: string,
  input: Readonly<Record<string, unknown>> = {},
  options: CallOptions = {},
): PlainStep {
  return { call: toolName, input, options };
}

/** A question to the owner, with the labels of its options. */
export function question(
  text: string,
  labels: readonly string[],
  options: {
    readonly header?: string;
    readonly multiSelect?: boolean;
    /** The agent gives the question up while the handler waits. */
    readonly giveUp?: boolean;
  } = {},
): PlainStep {
  return {
    giveUp: options.giveUp ?? false,
    question: [
      {
        header: options.header ?? "",
        text,
        multiSelect: options.multiSelect ?? false,
        options: labels.map((label) => ({ label, description: null, preview: null })),
      },
    ],
  };
}

/** The agent answers with a message about a failed request of its own; the turn ends as `error`. */
export function fail(text: string): PlainStep {
  return { fail: text };
}

/** A command of the owner's changed the effort (null: it names none), as a turn's first step. */
export function effort(level: string | null): PlainStep {
  return { effort: level };
}

/** A command of the owner's switched the model to `id`, as a turn's first step. */
export function modelSwitched(id: string): PlainStep {
  return { model: id };
}

/**
 * What became of the session's goal, as an agent that declares `goals` says it: the plain agent
 * itself declares none, so only a test's variant that does may play it.
 */
export function goalChanged(goal: GoalChange): PlainStep {
  return { goal };
}

/** The session says it saved a message (`message_saved`), as a session with `foreignTurns` does. */
export function saved(id: string, at: number): PlainStep {
  return { saved: { id, at } };
}

/**
 * The jobs the agent says it has scheduled, as an agent that declares `scheduledJobs` says them:
 * the plain agent itself declares none, so only a test's variant that does may play it.
 */
export function scheduledJobs(jobs: readonly ScheduledJob[]): PlainStep {
  return { jobs };
}

/** The turn waits here until `interrupt()` (it ends as `interrupted`) or `release()`. */
export function hold(): PlainStep {
  return { hold: true };
}

/** The process dies: `process_lost` is the session's last event. */
export function die(): PlainStep {
  return { die: true };
}

// The agent's record of sessions.

interface Stored {
  readonly id: string;
  readonly folder: string;
  title: string;
  lastModified: number;
  /** The prompts the owner sent, with the files of the folder as they were when each was sent. */
  prompts: { readonly point: RewindPoint; readonly files: ReadonlyMap<string, string> }[];
}

/**
 * What the agent keeps of its sessions, as a transcript folder would. A test keeps the store and
 * gives it to the next `PlainAgent` to restart the daemon.
 */
export class PlainStore {
  readonly #sessions = new Map<string, Stored>();
  readonly #now: () => number;
  /** The files each folder holds, by path: a test writes them, a restore puts them back. */
  readonly #files = new Map<string, Map<string, string>>();
  #counter = 0;
  #last = 0;

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  /** Writes a file of `folder` the way the agent's own edit would: a test stands in for the agent. */
  writeFile(folder: string, path: string, content: string): void {
    const files = this.#files.get(folder) ?? new Map<string, string>();
    this.#files.set(folder, files);
    files.set(path, content);
  }

  /** The content of a file of `folder`, null when there is none. */
  file(folder: string, path: string): string | null {
    return this.#files.get(folder)?.get(path) ?? null;
  }

  /** Records a prompt of the session, with the files as they are now. */
  addPrompt(folder: string, id: string, point: RewindPoint): void {
    const stored = this.#sessions.get(id);
    if (stored === undefined || stored.folder !== folder) return;
    stored.prompts.push({ point, files: new Map(this.#files.get(folder) ?? []) });
  }

  /** The id of the session's last prompt, "" for a session with none: the token of its conversation. */
  tail(folder: string, id: string): string {
    return this.prompts(folder, id).at(-1)?.id ?? "";
  }

  /** The prompts of the session, oldest first; none for a session it does not have. */
  prompts(folder: string, id: string): RewindPoint[] {
    const stored = this.#sessions.get(id);
    return stored?.folder === folder ? stored.prompts.map((entry) => entry.point) : [];
  }

  /** Drops the prompt `promptId` and every later one from the session; false for none such. */
  cut(folder: string, id: string, promptId: string): boolean {
    const stored = this.#sessions.get(id);
    const at = stored?.prompts.findIndex((entry) => entry.point.id === promptId) ?? -1;
    if (stored === undefined || stored.folder !== folder || at === -1) return false;
    stored.prompts.splice(at);
    return true;
  }

  /**
   * The files of `folder` as they were at the prompt, back or forward: with `preview` only what
   * it would change. A line counts as changed by its text; the counts are those of the restore.
   */
  restore(folder: string, id: string, promptId: string, preview: boolean): FilesRestore {
    const stored = this.#sessions.get(id);
    const entry =
      stored?.folder === folder ? stored.prompts.find((e) => e.point.id === promptId) : undefined;
    if (entry === undefined) {
      return {
        possible: false,
        reason: "no checkpoint for that prompt",
        files: [],
        insertions: 0,
        deletions: 0,
        skipped: 0,
      };
    }
    const now = this.#files.get(folder) ?? new Map<string, string>();
    const paths = [...new Set([...now.keys(), ...entry.files.keys()])].sort();
    const files: string[] = [];
    let insertions = 0;
    let deletions = 0;
    for (const path of paths) {
      const was = entry.files.get(path) ?? null;
      const is = now.get(path) ?? null;
      if (was === is) continue;
      files.push(path);
      const lines = (text: string | null) => (text === null || text === "" ? [] : text.split("\n"));
      insertions += lines(was).filter((line) => !lines(is).includes(line)).length;
      deletions += lines(is).filter((line) => !lines(was).includes(line)).length;
      if (!preview) {
        if (was === null) now.delete(path);
        else now.set(path, was);
      }
    }
    return { possible: true, reason: null, files, insertions, deletions, skipped: 0 };
  }

  newId(): string {
    this.#counter += 1;
    return `plain-session-${this.#counter}`;
  }

  has(folder: string, id: string): boolean {
    return this.#sessions.get(id)?.folder === folder;
  }

  /** Records that the session ran: a time later than every earlier one unless `at` says. */
  remember(folder: string, id: string, title: string, at?: number): void {
    this.#last = Math.max(this.#now(), this.#last + 1);
    const stored = this.#sessions.get(id);
    if (stored === undefined) {
      this.#sessions.set(id, { id, folder, title, lastModified: at ?? this.#last, prompts: [] });
    } else {
      stored.lastModified = at ?? this.#last;
      if (stored.title === "") stored.title = title;
    }
  }

  /**
   * A copy of the session `id` of `folder` under a new id, named `title` or the original's name
   * with ` (fork)`, as a transcript folder would hold it. Throws for a session it does not have.
   */
  fork(folder: string, id: string, title: string | null): string {
    const stored = this.#sessions.get(id);
    if (stored === undefined || stored.folder !== folder) throw new Error(`no session ${id}`);
    const copy = this.newId();
    this.remember(folder, copy, title ?? `${stored.title} (fork)`);
    // The copy's checkpoints are not the original's, as the Claude agent's (measured 2026-10-28).
    return copy;
  }

  /** The sessions of `folder`, newest first. */
  list(folder: string): ListedSession[] {
    return [...this.#sessions.values()]
      .filter((stored) => stored.folder === folder)
      .sort((a, b) => b.lastModified - a.lastModified)
      .map((stored) => ({
        id: stored.id,
        title: stored.title,
        customTitle: null,
        branch: null,
        size: null,
        lastModified: stored.lastModified,
      }));
  }
}

// A single-reader queue of events.

class EventQueue implements AsyncIterable<SessionEvent> {
  readonly #items: SessionEvent[] = [];
  #ended = false;
  #wake: (() => void) | null = null;

  push(event: SessionEvent): void {
    if (this.#ended) return;
    this.#items.push(event);
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

  [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
    return {
      next: async (): Promise<IteratorResult<SessionEvent>> => {
        while (this.#items.length === 0 && !this.#ended) {
          await new Promise<void>((resolve) => {
            this.#wake = resolve;
          });
        }
        const event = this.#items.shift();
        if (event === undefined) return { done: true, value: undefined };
        return { done: false, value: event };
      },
    };
  }
}

/** Sending to a session that has ended: closed, or its process lost. */
export class PlainSessionClosed extends Error {
  override readonly name = "PlainSessionClosed";

  constructor() {
    super("the plain session is closed");
  }
}

const NOT_SHOWN = "The request could not be shown to the owner.";

/** What the owner was asked and answered, in order. */
export type PlainAnswered =
  | { readonly request: PermissionRequest; readonly answer: PermissionAnswer }
  | { readonly request: QuestionRequest; readonly answer: QuestionAnswer };

/** Settles with `value`, or with the abort when the signal fires first. */
function orAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

const ABORTED = Symbol("aborted");

/** Words of a text with their trailing space, so that they join back to the text. */
function pieces(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

function textOf(prompt: Prompt): string {
  const { content } = prompt;
  if (typeof content === "string") return content;
  return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

class Turn {
  messages = 0;
  calls = 0;
  finalText: string | null = null;
  ending: "done" | "interrupted" | "error" = "done";
}

export interface PlainSessionContext {
  readonly id: string;
  readonly options: StartOptions;
  readonly requests: RequestHandler;
  readonly store: PlainStore;
  /** The steps of the next turn of the script. */
  readonly takeTurn: () => readonly PlainStep[];
  /** The models the agent lists, in its order; none when it lists no model. */
  readonly models: readonly ModelInfo[];
  /** The session is named (`session_started`) when it starts, not with its first prompt. */
  readonly namedAtStart: boolean;
  /** The agent keeps the prompts and checkpoints of its sessions (`fileRestore`, `conversationRewind`). */
  readonly rewinds: boolean;
  /** The conversation cannot be cut before a session's first prompt. */
  readonly firstUncuttable: boolean;
}

export class PlainSession implements AgentSession {
  readonly events: AsyncIterable<SessionEvent>;
  readonly id: string;
  readonly options: StartOptions;
  /** With `rewindTo`: the conversation's token when the cut was made. */
  readonly rewindToken?: string;
  /** Every prompt sent, in order. */
  readonly prompts: Prompt[] = [];
  /** Every request put to the owner with the answer it got. */
  readonly answers: PlainAnswered[] = [];
  closed = false;
  lost = false;
  readonly #queue = new EventQueue();
  readonly #context: PlainSessionContext;
  #chain: Promise<void> = Promise.resolve();
  #turn: AbortController | null = null;
  #released: (() => void) | null = null;
  #sequence = 0;
  #cut = false;

  constructor(context: PlainSessionContext) {
    this.#context = context;
    this.id = context.id;
    this.options = context.options;
    if (context.options.rewindTo !== undefined) {
      this.rewindToken = context.store.tail(context.options.folder, context.id);
    }
    this.events = this.#queue;
    if (context.namedAtStart) this.#name();
  }

  #name(): void {
    // A session named at its start has a record from then on, titled by its first prompt.
    if (this.#context.namedAtStart) {
      this.#context.store.remember(this.options.folder, this.id, "");
    }
    this.#queue.push({ type: "session_started", sessionId: this.id, agentVersion: VERSION });
  }

  async send(prompt: Prompt): Promise<void> {
    if (this.closed || this.lost) throw new PlainSessionClosed();
    // Named with the first prompt, as Claude's init record comes with it: the core takes a stored
    // session id for a session that ran, and resumes it when a setup needs a fresh client.
    if (this.prompts.length === 0 && !this.#context.namedAtStart) this.#name();
    this.prompts.push(prompt);
    const text = textOf(prompt);
    this.#context.store.remember(this.options.folder, this.id, text);
    if (this.#context.rewinds && this.#command(text) === null) {
      const { store } = this.#context;
      const { folder, rewindTo } = this.options;
      // A cut holds only once a prompt is written after it, as the Claude agent's does.
      if (rewindTo !== undefined && !this.#cut) {
        this.#cut = true;
        store.cut(folder, this.id, rewindTo);
      }
      const first = store.prompts(folder, this.id).length === 0;
      store.addPrompt(folder, this.id, {
        id: prompt.id,
        text,
        conversation: !(first && this.#context.firstUncuttable),
      });
    }
    this.#chain = this.#chain.then(() => this.#play(text));
  }

  /** Lets a turn waiting at `hold()` go on. */
  release(): void {
    this.#released?.();
  }

  /** The process dies, with no word from the core. */
  kill(): void {
    if (this.closed || this.lost) return;
    this.lost = true;
    this.#turn?.abort();
    this.#queue.push({ type: "process_lost", reason: "the plain process exited" });
    this.#queue.end();
  }

  async interrupt(): Promise<void> {
    this.#turn?.abort();
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (mode !== PLAIN_MODE) throw new RangeError(`unknown permission mode: ${mode}`);
  }

  async setModel(model: string | null): Promise<void> {
    if (model !== null && !this.#context.models.some((entry) => entry.value === model)) {
      throw new Error("the plain agent has no such model to choose");
    }
  }

  async contextUsage(): Promise<ContextUsage> {
    return { model: null, percentage: null };
  }

  loaded?: () => Promise<LoadedContext>;

  /** Present with `fileRestore`. */
  restoreFiles?: (promptId: string, preview: boolean) => Promise<FilesRestore>;

  async info(): Promise<AgentInfo> {
    return {
      models: this.#context.models,
      commands: PLAIN_COMMANDS,
      permissionMode: PLAIN_MODE,
      account: null,
    };
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.#turn?.abort();
      this.#queue.end();
    }
    await this.#chain;
  }

  #nextId(prefix: string): string {
    this.#sequence += 1;
    return `${prefix}-${this.id}-${this.#sequence}`;
  }

  #push(event: SessionEvent): void {
    if (!this.lost) this.#queue.push(event);
  }

  async #play(text: string): Promise<void> {
    if (this.closed || this.lost) return;
    const command = this.#command(text);
    const turn = new Turn();
    if (command !== null) {
      this.#push({ type: "text", text: command });
      turn.finalText = command;
    } else {
      this.#turn = new AbortController();
      await this.#steps(this.#context.takeTurn(), turn, this.#turn.signal);
      if (this.#turn.signal.aborted && !this.closed && !this.lost) turn.ending = "interrupted";
      this.#turn = null;
    }
    if (this.closed || this.lost) return;
    const level = this.options.effort;
    this.#push({
      type: "effort_observed",
      level: level !== null && PLAIN_CAPABILITIES.effortLevels.includes(level) ? level : null,
    });
    this.#push({
      type: "turn_ended",
      sessionId: this.id,
      startedBy: "owner",
      finalText: turn.finalText,
      ending: turn.ending,
      // Each call goes back to the model once; a turn that did nothing never went to it.
      steps: turn.messages + turn.calls === 0 ? 0 : turn.calls + 1,
      tokens: {},
    });
  }

  /** The output of a command the prompt names, or null for a prompt that is a turn. */
  #command(text: string): string | null {
    const match = /^:(\S+)\s*(.*)$/s.exec(text.trim());
    if (match === null) return null;
    const name = match[1] ?? "";
    const argument = (match[2] ?? "").trim();
    const known = PLAIN_COMMANDS.find(
      (entry) => entry.name === name || entry.aliases.includes(name),
    );
    if (known === undefined) return `Unknown command: :${name}`;
    if (known.name === "count") return `${argument.split(/\s+/).filter(Boolean).length} words`;
    return argument === "" ? "(nothing to say)" : argument;
  }

  async #steps(steps: readonly PlainStep[], turn: Turn, signal: AbortSignal): Promise<void> {
    for (const step of steps) {
      if (signal.aborted || this.closed || this.lost) return;
      if ("say" in step) {
        this.#say(step.say, turn);
      } else if ("whole" in step) {
        const trimmed = step.whole.trim();
        if (trimmed !== "") {
          this.#push({ type: "text", text: trimmed });
          turn.finalText = trimmed;
          turn.messages += 1;
        }
      } else if ("call" in step) {
        await this.#call(step.call, step.input, step.options, turn, signal);
      } else if ("question" in step) {
        await this.#ask(step.question, step.giveUp, turn, signal);
      } else if ("fail" in step) {
        this.#push({
          type: "agent_error",
          kind: "other",
          category: "plain_failure",
          text: step.fail,
          parentCallId: null,
        });
        turn.ending = "error";
        return;
      } else if ("effort" in step) {
        this.#push({ type: "effort_changed", level: step.effort });
      } else if ("model" in step) {
        this.#push({ type: "model_changed", model: step.model });
      } else if ("goal" in step) {
        this.#push({ type: "goal_changed", goal: step.goal });
      } else if ("saved" in step) {
        this.#push({ type: "message_saved", message: step.saved });
      } else if ("jobs" in step) {
        this.#push({ type: "scheduled_jobs", jobs: step.jobs });
      } else if ("hold" in step) {
        await orAborted(
          new Promise<void>((resolve) => {
            this.#released = resolve;
          }),
          signal,
        );
        this.#released = null;
      } else {
        this.kill();
        return;
      }
    }
  }

  #say(text: string, turn: Turn): void {
    this.#push({ type: "message_started", parentCallId: null });
    this.#push({ type: "text_started" });
    for (const piece of pieces(text)) {
      this.#push({ type: "text_delta", text: piece });
    }
    this.#push({ type: "message_ended", parentCallId: null });
    const trimmed = text.trim();
    turn.messages += 1;
    if (trimmed !== "") turn.finalText = trimmed;
  }

  async #call(
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    options: CallOptions,
    turn: Turn,
    signal: AbortSignal,
  ): Promise<void> {
    const callId = this.#nextId("call");
    turn.calls += 1;
    this.#push({ type: "call_started", callId, toolName, input, parentCallId: null });
    let allowed = true;
    let message = "";
    if (options.permission === true) {
      const request: PermissionRequest = {
        type: "permission",
        callId,
        toolName,
        input,
        title: null,
        description: null,
      };
      const answer = await this.#request(
        (given) => this.#context.requests.permission(request, given),
        { allow: false, message: NOT_SHOWN },
        options.giveUp === true,
        signal,
      );
      if (answer === ABORTED) return;
      this.answers.push({ request, answer });
      if (!answer.allow) {
        allowed = false;
        message = answer.message;
      }
    }
    this.#push({
      type: "call_ended",
      callId,
      isError: !allowed || options.isError === true,
      output: allowed ? (options.output ?? "done") : message,
      fileChange: options.fileChange ?? null,
      model: null,
      parentCallId: null,
    });
  }

  async #ask(
    questions: readonly Question[],
    giveUp: boolean,
    turn: Turn,
    signal: AbortSignal,
  ): Promise<void> {
    const callId = this.#nextId("call");
    turn.calls += 1;
    this.#push({
      type: "call_started",
      callId,
      toolName: "Ask",
      input: { questions },
      parentCallId: null,
    });
    const request: QuestionRequest = {
      type: "question",
      callId,
      toolName: "Ask",
      title: null,
      questions,
    };
    const answer = await this.#request(
      (given) => this.#context.requests.question(request, given),
      { answered: false, message: NOT_SHOWN },
      giveUp,
      signal,
    );
    if (answer === ABORTED) return;
    this.answers.push({ request, answer });
    this.#push({
      type: "call_ended",
      callId,
      isError: !answer.answered,
      output: answer.answered ? JSON.stringify(answer.answers) : answer.message,
      fileChange: null,
      model: null,
      parentCallId: null,
    });
  }

  /**
   * Asks the handler with a signal of the request's own; a handler that throws is a refusal, an
   * interrupt or a close ends the wait. `giveUp` aborts the request's signal once the handler
   * holds it, and the turn goes on with whatever the handler answers.
   */
  async #request<T>(
    ask: (given: AbortSignal) => Promise<T>,
    refused: T,
    giveUp: boolean,
    signal: AbortSignal,
  ): Promise<T | typeof ABORTED> {
    const request = new AbortController();
    let pending: Promise<T>;
    try {
      pending = ask(request.signal);
    } catch {
      return refused;
    }
    if (giveUp) request.abort();
    try {
      return await orAborted(pending, signal);
    } catch {
      return refused;
    }
  }
}

export interface PlainAgentOptions {
  /** The agent's record of sessions; a new one when absent. */
  readonly store?: PlainStore;
  /** The script: one array of steps per turn. A test that shares it across agents shares the rest of it. */
  readonly turns?: PlainStep[][];
  /**
   * The agent reads the owner's shell commands (`shellCommands`), each as one text naming the
   * command, its end and its output; `timeoutMs` is how long one may run (10 s when absent).
   */
  readonly shell?: { readonly timeoutMs?: number };
  /**
   * The agent lists the processes that hold a session (`sessionHolders`, from `holders`) and
   * reads the turns another one wrote (`foreignTurns`, from `foreign`), both set by the test.
   */
  readonly terminal?: true;
  /** What each live session has loaded (`loadedContext`), as `!memory` and `!skills` list it. */
  readonly loaded?: LoadedContext;
  /** The agent lists these models (`models`, even an empty list), which a session takes with `setModel`. */
  readonly models?: readonly ModelInfo[];
  /** The agent has no terminal to continue a session in (`AgentWords.terminal` is null). */
  readonly noTerminal?: true;
  /** Each session is named when it starts, not with its first prompt. */
  readonly namedAtStart?: true;
  /**
   * The agent keeps a record of trust (`folderTrust`): every folder may hold a session, and the
   * repository of a folder is what `repository` answers while `trusted` says the folder is
   * trusted. Its line to ask for trust is `trust {directory}`.
   */
  /**
   * The agent keeps a prompt list and checkpoints (`prompts`): `files` adds `fileRestore`
   * (`restoreFiles` over the files a test writes to the store), `conversation` adds
   * `conversationRewind` (`rewindTo` cuts the store's record of the session once a prompt is
   * sent after it), and `refuse` makes every start with `rewindTo` reject with `RewindRefused`.
   */
  readonly rewind?: {
    readonly files?: true;
    readonly conversation?: true;
    readonly refuse?: true;
    /** `RewindPoint.conversation` is false for a session's first prompt, as the Claude agent's is. */
    readonly firstUncuttable?: true;
  };
  readonly trust?: {
    readonly repository: (folder: string) => Promise<Repository | null>;
    readonly trusted: (folder: string) => boolean;
  };
}

/** How the plain agent is told of a shell command: one text, which a test reads back. */
export function plainShellPrompt(run: ShellRun): string {
  return `ran ${run.command} (${run.end} ${run.exitCode}): ${run.stdout}${run.stderr}`;
}

export class PlainAgent implements AgentBackend {
  readonly name = PLAIN_NAME;
  readonly words: AgentWords;
  readonly tools = PLAIN_TOOLS;
  readonly capabilities: Capabilities;
  readonly shell?: ShellMode;
  readonly store: PlainStore;
  /** The script not yet played. */
  readonly turns: PlainStep[][];
  /** Every session started, in order. */
  readonly sessions: PlainSession[] = [];
  /** Every start asked of the agent, in order, a failed one too. */
  readonly starts: StartOptions[] = [];
  readonly #startFailures: Error[] = [];
  closed = false;
  /** What `sessionHolders` answers, per session id; none listed when absent. */
  readonly holders = new Map<string, readonly SessionHolder[] | null>();
  /** What `turnsAfter` answers, per session id; nothing changed when absent. */
  readonly foreign = new Map<string, ForeignTurns>();
  /** Every `turnsAfter` asked, as `session after-id`. */
  readonly foreignAsked: string[] = [];
  folderTrusted?: (folder: string) => Promise<boolean>;
  trustedRepository?: (folder: string) => Promise<Repository | null>;
  untrustedRepository?: (folder: string) => Promise<Repository | null>;
  sessionHolders?: (session: string) => Promise<readonly SessionHolder[] | null>;
  turnsAfter?: (folder: string, session: string, after: SavedMessage) => Promise<ForeignTurns>;
  prompts?: (folder: string, session: string) => Promise<readonly RewindPoint[]>;
  /** What each live session answers to `loaded`, with `loadedContext`. */
  readonly loaded: LoadedContext | null;
  readonly models: readonly ModelInfo[];
  readonly #namedAtStart: boolean;
  readonly #rewind: PlainAgentOptions["rewind"];

  constructor(options: PlainAgentOptions = {}) {
    const words =
      options.noTerminal === true
        ? Object.freeze({ ...PLAIN_WORDS, terminal: null, terminalContinue: null })
        : PLAIN_WORDS;
    this.words =
      options.trust === undefined ? words : Object.freeze({ ...words, trust: "trust {directory}" });
    this.store = options.store ?? new PlainStore();
    this.turns = options.turns ?? [];
    this.capabilities = PLAIN_CAPABILITIES;
    this.loaded = options.loaded ?? null;
    this.models = options.models ?? [];
    this.#namedAtStart = options.namedAtStart === true;
    this.#rewind = options.rewind;
    if (options.rewind !== undefined) {
      this.capabilities = Object.freeze({
        ...this.capabilities,
        fileRestore: options.rewind.files === true,
        conversationRewind: options.rewind.conversation === true,
      });
      this.prompts = async (folder, session) => this.store.prompts(folder, session);
    }
    if (options.models !== undefined) {
      this.capabilities = Object.freeze({ ...this.capabilities, models: true });
    }
    if (this.loaded !== null) {
      this.capabilities = Object.freeze({ ...this.capabilities, loadedContext: true });
    }
    if (options.trust !== undefined) {
      const { repository, trusted } = options.trust;
      this.capabilities = Object.freeze({ ...this.capabilities, folderTrust: true });
      this.folderTrusted = async () => true;
      this.trustedRepository = async (folder) => (trusted(folder) ? repository(folder) : null);
      this.untrustedRepository = async (folder) => (trusted(folder) ? null : repository(folder));
    }
    if (options.shell !== undefined) {
      this.capabilities = Object.freeze({ ...this.capabilities, shellCommands: true });
      this.shell = {
        timeoutMs: options.shell.timeoutMs ?? 10_000,
        environment: { PATH: process.env.PATH },
        prompt: plainShellPrompt,
      };
    }
    if (options.terminal) {
      this.capabilities = Object.freeze({
        ...this.capabilities,
        sessionHolders: true,
        foreignTurns: true,
      });
      this.sessionHolders = async (session) =>
        this.holders.has(session) ? (this.holders.get(session) ?? null) : [];
      this.turnsAfter = async (_folder, session, after) => {
        this.foreignAsked.push(`${session} ${after.id}`);
        const found = this.foreign.get(session) ?? { changed: false, turns: [], last: null };
        this.foreign.delete(session);
        return found;
      };
    }
  }

  /** Scripts the next turn, after those already scripted. */
  next(...steps: PlainStep[]): this {
    this.turns.push(steps);
    return this;
  }

  /** The next `start` rejects with `error`, with no session left. */
  failNextStart(error: Error): void {
    this.#startFailures.push(error);
  }

  /** The sessions started and neither closed nor lost. */
  get running(): PlainSession[] {
    return this.sessions.filter((session) => !session.closed && !session.lost);
  }

  async start(options: StartOptions, requests: RequestHandler): Promise<AgentSession> {
    this.starts.push(options);
    const failure = this.#startFailures.shift();
    if (failure !== undefined) throw failure;
    if (options.resume !== null && !this.store.has(options.folder, options.resume)) {
      throw new ResumeRefused();
    }
    if (options.rewindTo !== undefined && this.#rewind?.refuse === true) throw new RewindRefused();
    // A cut asked for again over a conversation that has grown since is refused, as Claude's is.
    if (
      options.rewindToken !== undefined &&
      options.resume !== null &&
      this.store.tail(options.folder, options.resume) !== options.rewindToken
    ) {
      throw new RewindRefused();
    }
    const session = new PlainSession({
      id: options.resume ?? this.store.newId(),
      options,
      requests,
      store: this.store,
      takeTurn: () => this.turns.shift() ?? [say("ok")],
      models: this.models,
      namedAtStart: this.#namedAtStart,
      rewinds: this.#rewind !== undefined,
      firstUncuttable: this.#rewind?.firstUncuttable === true,
    });
    if (this.#rewind?.files === true) {
      session.restoreFiles = async (promptId, preview) =>
        this.store.restore(options.folder, session.id, promptId, preview);
    }
    const loaded = this.loaded;
    if (loaded !== null) session.loaded = async () => loaded;
    this.sessions.push(session);
    return session;
  }

  async listSessions(folder: string): Promise<readonly ListedSession[]> {
    return this.store.list(folder);
  }

  async forkSession(folder: string, session: string, title: string | null): Promise<string> {
    return this.store.fork(folder, session, title);
  }

  async datedSessions(
    _folder: string,
    sessions: readonly ListedSession[],
  ): Promise<ListedSession[]> {
    return [...sessions].sort((a, b) => b.lastModified - a.lastModified);
  }

  async aliveSessions(folder: string): Promise<ReadonlySet<string> | null> {
    return new Set(this.store.list(folder).map((session) => session.id));
  }

  // No `folderTrust`: the agent keeps no record of trust, so no folder is refused and the
  // daemon's git runs nowhere. No `stopTask` or `setEffort` either: it runs no task, and its
  // effort changes only at a start.

  async close(): Promise<void> {
    this.closed = true;
  }
}

export interface PlainEntry extends AgentEntry {
  /** Every agent the entry built, in order. */
  readonly built: PlainAgent[];
}

/** The entry that builds a plain agent over `options`, for a registry. */
export function plainAgent(options: PlainAgentOptions = {}): PlainEntry {
  const built: PlainAgent[] = [];
  return {
    required: [],
    optional: [],
    tools: PLAIN_TOOLS,
    toolNames: Object.freeze(["run", "look", "change", "ask", "delegate", "propose"]),
    limitsHeading: "Limits of the plain agent",
    words: { names: [], literals: [], patterns: [] },
    built,
    build: (_context: AgentContext) => {
      const agent = new PlainAgent(options);
      built.push(agent);
      return agent;
    },
  };
}

/** A model entry of the plain agent's list, with the efforts it takes. */
export function plainModel(
  value: string,
  options: { readonly isDefault?: boolean; readonly efforts?: readonly string[] } = {},
): ModelInfo {
  const efforts = options.efforts ?? [];
  return {
    value,
    isDefault: options.isDefault ?? false,
    resolvedModel: options.isDefault === true ? null : `${value}-1`,
    displayName: value.toUpperCase(),
    description: null,
    supportsEffort: efforts.length > 0,
    supportedEffortLevels: efforts,
  };
}

/**
 * A model list in the shape agents give one: the default entry first, a model that takes both
 * efforts, and one that takes none.
 */
export const PLAIN_MODELS: readonly ModelInfo[] = Object.freeze([
  {
    ...plainModel("standard", { isDefault: true, efforts: ["brief", "full"] }),
    displayName: "Standard (recommended)",
    description: "The model the agent picks when none is chosen",
    resolvedModel: "big-2",
  },
  {
    ...plainModel("big", { efforts: ["brief", "full"] }),
    displayName: "Big 2",
    resolvedModel: "big-2",
  },
  { ...plainModel("small"), displayName: "Small 1", resolvedModel: "small-1" },
]);
