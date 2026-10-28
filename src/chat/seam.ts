/**
 * The chat seam: what the core writes in a chat and a provider draws, and what a provider tells
 * the core of what the owner did. No type of a chat library appears here.
 *
 * Outbound, the core calls a provider: the reply model (`ReplySink`, `TaskUpdate`, the footer's
 * fields), what a session does to its thread outside a reply (`ThreadChat`), what is said in a
 * channel outside any thread (`ChannelChat`), and the provider itself (`ChatProvider`: its name,
 * what it supports, its start and stop). Inbound, a provider calls the core (`ChatInbound`): a
 * message, the answer to a request, a pick from a list. The core decides what is asked, which
 * choices exist and what follows; a provider decides how each is drawn, and checks that it was
 * the owner before anything reaches the core.
 *
 * The one value declared here is `ChatError`, which names a failed call for the core's log.
 */
import type {
  ListedSession,
  ModelInfo,
  PermissionRequest,
  PromptContent,
  Question,
  QuestionRequest,
  UsageLimit,
} from "../agent/seam.ts";

export type { UsageLimit } from "../agent/seam.ts";

/**
 * A thread, by the two names its chat gives it. Only the provider that made them can read
 * them: the core stores them, compares them and hands them back.
 */
export interface ThreadRef {
  readonly channel: string;
  readonly thread: string;
}

export type TaskStatus = "pending" | "in_progress" | "complete" | "error";

/** The terminal's own view of a finished call. */
export interface Preview {
  /** `Update(notes.txt)` */
  readonly title: string;
  /** `Added 1 line, removed 1 line` */
  readonly summary: string;
  /** Numbered lines, as the terminal prints them. */
  readonly body: string;
  /** `diff` for a diff, which a provider may colour. */
  readonly language: "" | "diff";
  /** The body is lines of words, shown as written and in no code block. */
  readonly plain: boolean;
  /**
   * The preview is a record that stands for the call: its title is the first line of the body, in
   * one block, and the call has no card. Always with `plain`: the body is lines of words. Only a
   * call that ends well and says so (an answered question) carries one; any other state of the
   * call keeps its card.
   */
  readonly record: boolean;
}

/** One line of a reply: a tool call, or a subagent's or a background command's task. */
export interface TaskUpdate {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly details: string | null;
  readonly output: string | null;
  /** The tool's name, which chooses its preview. */
  readonly name: string;
  /** A subagent's or a background command's line. */
  readonly task: boolean;
  /**
   * A card of words to read (a subagent's message), not a call: its `output` is its body, which
   * a chat shows whatever the status, as it keeps a call's result to itself.
   */
  readonly message: boolean;
  /** Calls made inside it (a subagent's), counted in its title. */
  readonly calls: number;
  readonly preview: Preview | null;
  /**
   * Null on every line the core hands to a sink. A provider that shows a run of calls as
   * counts passes its lines through the core's `Fold`, which sets this on the lines it makes:
   * what replaces the line once the reply's body has ended; empty removes it. A run's line that
   * lists commands (`details`) keeps null: it stays, to be opened on them.
   */
  readonly folded: string | null;
  /**
   * When a call the terminal times began (a shell command), in seconds on the clock the chat is
   * built with as `ChatContext.steady`; null for every other call and for a task's line. A chat
   * that shows how long the call has run reads it against that clock, and may ignore it.
   */
  readonly startedAt: number | null;
}

/** The footer as fields. A provider formats them in its own markup. */
export interface FooterFields {
  readonly bypass: boolean;
  /** The session is in plan mode: shown in place of bypass, the mode actually in force. */
  readonly planning: boolean;
  readonly model: string | null;
  /** The model that advises the session's, by its name; null when none is set. */
  readonly advisor: string | null;
  /** A fixed level, or the agent's word for its default. */
  readonly effort: string | null;
  /**
   * The level the last turn ran at, set only when `effort` is the agent's word for its default:
   * a provider draws it beside that word. Null when no turn has reported one.
   */
  readonly effortObserved: string | null;
  /** The folder the thread was opened in. */
  readonly folder: string | null;
  readonly branch: string | null;
  /** Lines inserted and deleted since the last commit. */
  readonly changes: readonly [inserted: number, deleted: number] | null;
  readonly sessionTokens: number | null;
  readonly contextPercent: number | null;
  readonly sessionLimit: UsageLimit | null;
  readonly weekLimit: UsageLimit | null;
  /** What names the account the agent is logged in to (an email); null when not known. */
  readonly account: string | null;
  /** The account's plan, which `!status` shows beside it; null when not known. */
  readonly accountPlan: string | null;
  /**
   * The work the footer closes, from the prompt that began it to the moment the session ended
   * everything, background reports included; `doneAt` is epoch milliseconds. Null when not known
   * (`!status`); every footer a session draws has it.
   */
  readonly work: { readonly durationMs: number; readonly doneAt: number } | null;
}

/**
 * One reply in a thread, as the core writes it. A write that has begun always runs to its end:
 * a `signal` only releases the caller, who stops waiting for it.
 */
export interface ReplySink {
  /**
   * `aside` marks a line about the work and not of the answer (a task's end): a chat may draw
   * it smaller, as it draws the count of a run of calls.
   */
  text(
    markdown: string,
    options?: { readonly notice?: boolean; readonly ending?: boolean; readonly aside?: boolean },
  ): Promise<void>;
  task(update: TaskUpdate): Promise<void>;
  /**
   * The turn's own part has ended; `closing` are the lines still open, closed. The reply stays
   * open: `rest` or `closeOut` follows.
   */
  finish(closing: readonly TaskUpdate[], signal?: AbortSignal): Promise<void>;
  /** Ends the reply. False when the end did not land. */
  closeOut(signal?: AbortSignal): Promise<boolean>;
  waitLanded(signal?: AbortSignal): Promise<boolean>;
  settle(signal?: AbortSignal): Promise<boolean>;
}

/**
 * What differs between chats and the core adapts to. A capability is here because the core
 * reads it: without one the feature it names is not offered, and the core never calls what
 * serves it. Every chat receives a message, writes a reply it can edit, and puts a request or
 * a form to the owner: those need none.
 */
export interface ChatCapabilities {
  /** A reply's text is shown as it is written; without it the core hands over each text whole. */
  readonly nativeStreaming: boolean;
  /**
   * `ThreadChat.showStatus`, `clearStatus`, `settleStatus` and `acknowledge`, and
   * `ChatProvider.statusMark`.
   */
  readonly reactions: boolean;
  /** `ThreadChat.showActivity`. */
  readonly activityLine: boolean;
  /** `ChatProvider.openFile`. */
  readonly fileUpload: boolean;
  /** `ChatProvider.tagThread`. */
  readonly threadTags: boolean;
  /** `ChatProvider.titleThread`. */
  readonly threadTitles: boolean;
  /** `ChatProvider.deleteThread`. */
  readonly threadDelete: boolean;
  /** `ChatProvider.suggestCommands`. */
  readonly commandSuggestions: boolean;
  /** `ThreadChat.showLoop` and `endLoop`: without it a scheduled run is an ordinary reply. */
  readonly loopCard: boolean;
}

/**
 * A call the chat refused or could not take. `name` is the provider's code for the failure
 * (`channel_not_found`), or the error's own name: all a log line may say of it, never content.
 */
export class ChatError extends Error {
  /** The chat will refuse the same call again, whenever it is made: retrying cannot help. */
  readonly permanent: boolean;

  constructor(code: string, options?: ErrorOptions & { readonly permanent?: boolean }) {
    super(code, options);
    this.name = code;
    this.permanent = options?.permanent === true;
  }
}

/** A message of the chat, by the id its provider gives it. The core stores it and hands it back. */
export type MessageId = string;

/** What the root of a thread shows of its session. */
export type SessionStatus = "working" | "waiting" | "done" | "error";

/**
 * What the root shows: the session's status, or `restarting` in place of `working` while a stop
 * waits for the thread. Shown only, never stored: a close replaces it with how the session ended.
 */
export type RootStatus = SessionStatus | "restarting";

/** How `ThreadChat.showStatus` changes the root's status. */
export interface StatusOptions {
  readonly signal?: AbortSignal;
  /**
   * The change ends the session's work, and the owner's own act did not make it: the owner is
   * told of it, where the chat can tell him of one message among the others.
   */
  readonly notify?: boolean;
}

/** What still runs in a thread: a title and one line per task. */
export interface RunningList {
  readonly title: string;
  readonly lines: readonly RunningLine[];
}

/** One task of the list: its words, and where it is when it is an agent that has made a call. */
export interface RunningLine {
  readonly text: string;
  /** Null for any other task, and for an agent before its first call. */
  readonly agent: RunningAgent | null;
}

/** An agent of the list: when it started, how many calls it has made, and the call it is at. */
export interface RunningAgent {
  /** When the agent started, in seconds on the clock the chat is built with as `ChatContext.steady`. */
  readonly since: number;
  /** How many calls the agent has made, the one it is at included. */
  readonly calls: number;
  /** The call it is at, or made last, in the words the thread uses for a call. */
  readonly step: string;
}

/** What the loop card of a thread shows: the latest scheduled run. */
export interface LoopCard {
  /** One plain line that says which run this is (`Scheduled run · every minute · run 3`). */
  readonly label: string;
  /** When the run ended, epoch milliseconds: the chat writes it after the label, in its own clock format. */
  readonly at: number;
  /** The run's final words, Markdown; empty when the run said nothing. */
  readonly text: string;
  /** The footer an ordinary reply shows, with the data of this run; null when it would say nothing. */
  readonly footer: FooterFields | null;
}

/**
 * One reply as a session holds it: the reply model, and its place in the thread.
 */
export interface Reply extends ReplySink {
  /**
   * The reply waits for work its turn started: from now on it changes by rewriting its message,
   * so that the list of what still runs can be drawn under its last message. Its stream stops with
   * no footer. Takes effect with the next write.
   */
  rest(): void;
  /** Whether nothing of the owner's and no other reply sits below this reply in the thread. */
  readonly last: boolean;
  /** Whether another reply has a message below this one: it then ends where it is, by edit. */
  readonly overtaken: boolean;
  /**
   * The session has ended everything it was doing: `footer` is drawn under this reply's last
   * message, by an edit, which notifies nobody, and stays there. Written at once; true when it
   * landed, false when it did not or when the reply's end never landed (no footer for it then).
   */
  showFooter(footer: FooterFields, signal?: AbortSignal): Promise<boolean>;
}

/**
 * Called when the message a crash would leave unfinished changes: `(old, fresh)` is one reply's
 * own transition, add `fresh` or drop `old`. Synchronous; a throw is the provider's to log.
 */
export type OpenMessageChange = (old: MessageId | null, fresh: MessageId | null) => void;

/**
 * One thread, as its session uses it. A call that has begun always runs to its end: a `signal`
 * only releases the caller. Unless it says otherwise a member never rejects: the provider logs
 * a failure (ids and codes only) and goes on, since the chat must never stop a turn.
 */
export interface ThreadChat {
  /**
   * What still runs in the thread, drawn above the footer under its last reply at rest; null
   * removes it. Takes effect at once and is written with that reply's next write.
   */
  showRunning(list: RunningList | null): void;
  /**
   * A new reply in the thread. It writes nothing until it is given something to show.
   * `onOpenMessage` is told which of its messages a crash would leave unfinished.
   */
  openReply(onOpenMessage: OpenMessageChange): Reply;
  /**
   * Shows the session's status on the thread's root. Changes are made in the order asked; with
   * a `signal`, rejects with its reason when it aborts, and the change may be left half made.
   * False when the chat did not make the change and the root does not show `status`.
   */
  showStatus(status: RootStatus, options?: StatusOptions): Promise<boolean>;
  /** Leaves the root with no status of this session. */
  clearStatus(): Promise<void>;
  /** Brings the root to the status asked for last: for whoever aborted a change on its way. */
  settleStatus(): Promise<void>;
  /**
   * What the thread says is going on under its last message, from now on; empty for nothing.
   * `afterName` says the same after the app's name, for a client that draws it that way.
   * Never waits on the chat.
   */
  showActivity(text: string, afterName: string): void;
  /** Whether the chat refuses this app an activity line for good: the session then posts. */
  readonly activityRefused: boolean;
  /** Something of the app's was posted in the thread outside this object. */
  written(): void;
  /**
   * A line of the daemon's own, small and grey, as a message of its own. `text` is plain: the
   * provider shows it as written, whatever marks it holds.
   */
  notice(text: string): Promise<void>;
  /**
   * Puts a request to the owner: a tool's permission, the agent's questions, the same-folder
   * hold, a session's setup or the confirmation of a shell command. `requestId` is what the owner's answer comes back with
   * (`ChatInbound.answer`); `title` is the request in one line. Resolves with the message that
   * shows it; rejects with `ChatError` when it could not be shown. A permission and a question
   * wait on the owner wherever he is, and he is told of each, where the chat can tell him of one
   * message among the others; the others answer what he has just written in the thread.
   */
  ask(requestId: string, request: OwnerRequest, title: string): Promise<MessageId>;
  /**
   * Removes a request that was decided or is stale; one already gone counts as removed. False
   * when the chat did not remove it and it still shows.
   */
  withdraw(request: MessageId): Promise<boolean>;
  /**
   * Rewrites an answered question into the record of its answers, with nothing left to press.
   * Rejects with `ChatError` when the chat refuses the rewrite.
   */
  keepAnswers(
    request: MessageId,
    questions: readonly Question[],
    answers: Readonly<Record<string, string | readonly string[]>>,
  ): Promise<void>;
  /**
   * Rewrites a message of the daemon's into a notice that says `text`, with nothing left to
   * press: the record of an answered setup, or the line a crash repair leaves for a request that
   * waited with no reply. `text` is written for a notice (`Markup`). Rejects
   * with `ChatError` when the chat refuses.
   */
  rewrite(message: MessageId, text: string): Promise<void>;
  /**
   * A line that answers what the owner just did in the thread, for the owner alone where the
   * chat can; with `stays` a message of the thread, which is still there later. `text` is
   * written for a notice (`Markup`). Never rejects: nobody is left to tell.
   */
  tell(text: string, options?: { readonly stays?: boolean }): Promise<void>;
  /**
   * A reference the owner reads, at full size, in Markdown; a long one continues in further
   * messages. With `ownerOnly`, for the owner alone where the chat can. Rejects with
   * `ChatError` when it could not be written.
   */
  say(markdown: string, options?: { readonly ownerOnly?: boolean }): Promise<void>;
  /** Marks a message of the owner's as a word that took effect. Never rejects. */
  acknowledge(message: MessageId): Promise<void>;
  /**
   * A link to the thread labelled `label`, written for `markup`; null when the chat gives
   * none. Never rejects.
   */
  link(label: string, markup: Markup): Promise<string | null>;
  /**
   * A reply a stop left unfinished, of a daemon that is gone: ended where it stands, with
   * `note` as its last line. Never rejects; a message already gone counts as ended. False when
   * the chat did not write the line and the reply is still there without it.
   */
  endReply(reply: MessageId, note: string): Promise<boolean>;
  /**
   * Shows `card` as the thread's loop card: the first call posts a message, every later one
   * rewrites that same message, which notifies nobody. Needs `ChatCapabilities.loopCard`. Calls
   * take effect in the order made. Never rejects.
   */
  showLoop(card: LoopCard): Promise<void>;
  /**
   * Whether the loop card is the newest message of the thread the chat knows of: nothing of the
   * owner's and nothing else of the app's below it. False while no card is shown.
   */
  readonly loopCardLast: boolean;
  /**
   * The loop is over: `line` is posted as a new message of the thread, the one push of the loop,
   * and the card is let go, so a later `showLoop` posts a card anew. Never rejects.
   */
  endLoop(line: string): Promise<void>;
  /** The session closed: the activity line is cleared, and nothing is left running. */
  close(): Promise<void>;
}

/**
 * The two ways the daemon writes its own words: a `notice` is a small line (`ThreadChat.tell`
 * and `rewrite`, `ChannelChat.notice` and `rewrite`), a `reference` is Markdown at full size
 * (`say`). A chat may mark each up differently, so a name that goes into either is escaped for
 * it (`ChatProvider.escape`), a channel is written for it (`ChatProvider.channelName`) and a link
 * is written for it (`ThreadChat.link`). `words` is a third kind that only `ChatProvider.escape`
 * takes: text the owner wrote, drawn inside a reference shown to the owner alone, as written: its
 * formatting, mentions and code live. A chat escapes only what would mis-render there.
 * `written` is Markdown the owner or the agent wrote, drawn inside a reference others may be
 * told of (a terminal's turn in its thread): its formatting and code live, its mentions
 * notifying nobody.
 */
export type Markup = "notice" | "reference" | "words" | "written";

/** What the controls of a session's setup hold: a model and an effort by value, and bypass. */
export interface SetupSelection {
  readonly model: string;
  readonly effort: string;
  readonly bypass: boolean;
}

/** The same-folder hold: another session works in the folder this message would wake one in. */
export interface HoldRequest {
  readonly type: "hold";
  readonly requestId: string;
  /** The thread of the session at work. */
  readonly other: ThreadRef;
  /** A link to it for a notice (`ThreadChat.link`), or the words that stand for one. */
  readonly link: string;
}

/** A session's setup, asked before its first prompt. */
export interface SetupRequest {
  readonly type: "setup";
  readonly requestId: string;
  /** The models offered, each with the effort levels it takes; empty when the agent lists none. */
  readonly models: readonly ModelInfo[];
  /** The effort levels offered when no model is; empty when the agent has none to choose. */
  readonly efforts: readonly string[];
  /** Whether running with no permission request is offered. */
  readonly bypassOffered: boolean;
  /** What the controls show at first. */
  readonly selection: SetupSelection;
}

/** A shell command the owner sent (`!!`), run in `folder` once confirmed. */
export interface ShellRequest {
  readonly type: "shell";
  readonly requestId: string;
  /** As typed, line breaks kept. */
  readonly command: string;
  /** The session's folder, as `!status` names it. */
  readonly folder: string;
}

/**
 * The session is open in a terminal on the host. `open`: the terminal is idle, and the owner's
 * message is sent here only if confirmed, since that terminal will not see it. `busy`: the
 * terminal runs a turn, and the message waits for its end (a cancel only). `move`: `!terminal`
 * would stop what still runs here (`running`, in the core's words), confirmed or cancelled.
 */
export interface TerminalRequest {
  readonly type: "terminal";
  readonly requestId: string;
  readonly state: "open" | "busy" | "move";
  /** What `!terminal` would stop, for `move`; null otherwise. */
  readonly running: string | null;
  /** The command that reopens the session in the terminal, for `open`; null otherwise. */
  readonly command: string | null;
}

/** What `ThreadChat.ask` puts to the owner. */
export type OwnerRequest =
  | PermissionRequest
  | QuestionRequest
  | HoldRequest
  | SetupRequest
  | ShellRequest
  | TerminalRequest;

/** The owner's answer to a request, by the request's type. */
export type OwnerAnswer =
  | { readonly type: "permission"; readonly allow: boolean }
  /**
   * The answer to each question by its text, or null for a skip, and the notes added to the
   * option picked in a question, by its text (only the non-empty ones, each for a question that
   * has an answer).
   */
  | {
      readonly type: "question";
      readonly answers: Readonly<Record<string, string | readonly string[]>> | null;
      readonly notes: Readonly<Record<string, string>>;
    }
  /** Whether the held message is sent. */
  | { readonly type: "hold"; readonly send: boolean }
  /** The controls as the owner left them; the core checks them against what it offered. */
  | { readonly type: "setup"; readonly selection: SetupSelection }
  /** Whether the shell command runs. */
  | { readonly type: "shell"; readonly run: boolean }
  /** Whether to go on (send here, or move to the terminal); false cancels. */
  | { readonly type: "terminal"; readonly go: boolean };

/** A list a word posts in a channel, each row with a control of its own. */
export type OwnerList =
  /** `folders` under `root` a session can start in; `bound` is the channel's own, if any. */
  | {
      readonly type: "folders";
      readonly root: string;
      readonly folders: readonly string[];
      readonly bound: string | null;
    }
  /**
   * The sessions of `folder` a thread can resume, and how many more a thread already holds.
   * `thread` is where the one picked will live.
   */
  | {
      readonly type: "sessions";
      readonly folder: string;
      readonly sessions: readonly ListedSession[];
      readonly held: number;
      readonly thread: ThreadRef;
    }
  /**
   * The update of allaboard from `from`, the version that runs, to `to`, with the address of what
   * `to` changed and the other instances (null: the default one) that run the same copy and
   * restart with it. One control: install `to`.
   */
  | {
      readonly type: "update";
      readonly from: string;
      readonly to: string;
      readonly changelog: string;
      readonly sharing: readonly (string | null)[];
    };

/** What the owner picked from an `OwnerList`. `list` is the message that showed it. */
export type ListPick =
  | {
      readonly type: "folder";
      readonly channel: string;
      readonly path: string;
      readonly list: MessageId;
    }
  /** `thread` is the one the list named; null when the control carried none. */
  | {
      readonly type: "session";
      readonly channel: string;
      readonly sessionId: string;
      readonly thread: ThreadRef | null;
      readonly list: MessageId;
    }
  /**
   * The control that installs `version`, the one the control names. `list` is the message of the
   * offer it was pressed on, and `channel` its channel; both null when the control is the one on
   * the chat's own page, which has no message.
   */
  | {
      readonly type: "update";
      readonly channel: string | null;
      readonly version: string;
      readonly list: MessageId | null;
    };

/**
 * A channel outside any thread: where a word typed in the channel is answered. A member
 * rejects with `ChatError` when the chat refused, unless it says otherwise.
 */
export interface ChannelChat {
  /**
   * A line of the daemon's own, small and grey, as a message of the channel; a notice's markup.
   * Resolves with the message posted, which `rewrite` takes; null when the chat cannot say.
   */
  notice(text: string): Promise<MessageId | null>;
  /** A reference at full size, in Markdown; a long one continues in further messages. */
  say(markdown: string): Promise<void>;
  /** Posts a list, each row with its control; `title` is the list in one line. */
  offer(list: OwnerList, title: string): Promise<void>;
  /** Removes a list that did its job. False when the chat refused and it still shows. */
  withdraw(list: MessageId): Promise<boolean>;
  /** Rewrites a list into a notice that says `text`, in a notice's markup, with nothing left to press. */
  rewrite(list: MessageId, text: string): Promise<void>;
  /**
   * A line that answers what the owner just pressed in the channel, for the owner alone where the
   * chat can, else a notice of the channel; a notice's markup.
   */
  tell(text: string): Promise<void>;
}

/** What `ChatProvider.suggestCommands` shows. */
export interface CommandSuggestion {
  /** What the owner typed, exactly. */
  readonly typed: string;
  /** The message that typed it. */
  readonly message: MessageId;
  /** `!` alone: every command is listed. */
  readonly all: boolean;
  readonly candidates: readonly CommandCandidate[];
}

/** One command a suggestion offers. */
export interface CommandCandidate {
  readonly name: string;
  /** `!name hint`, plain text. */
  readonly usage: string;
  /** One short line, plain text. */
  readonly description: string;
  /** Whether the daemon answers it itself or the session runs it. */
  readonly group: "daemon" | "agent";
  /** What choosing it puts in the field: its name and the arguments as typed. */
  readonly text: string;
}

/** One message of the owner's, after the provider's own checks. */
export interface InboundMessage {
  /** The thread it was written in; for a message of the channel itself, the thread it opens. */
  readonly ref: ThreadRef;
  readonly id: MessageId;
  /** Written in the channel, not inside a thread. */
  readonly topLevel: boolean;
  /** The text as the owner typed it. */
  readonly text: string;
  /** The same with the chat's formatting marks removed: where a word of the daemon is read. */
  readonly plain: string;
  /** It carries files, or was spoken: never read as a word or a command. */
  readonly literal: boolean;
  /**
   * The prompt it makes, files included, read when its turn among the thread's messages comes.
   * Null when a file could not be taken: the provider told the owner, and nothing is sent.
   */
  content(): Promise<PromptContent | null>;
}

/**
 * What a provider tells the core. Each call is made for the owner alone: a provider checks who
 * acted, on every path of its own, before it calls. No member rejects for a failure the owner
 * should read: the core tells them in the chat.
 */
export interface ChatInbound {
  message(message: InboundMessage): Promise<void>;
  /**
   * The owner answered the request `requestId`, shown by `message` in `ref`; `message` is null
   * when the answer came from a form that is no message of the thread. False when the request
   * is no longer waiting there: the core told the owner so.
   */
  answer(
    ref: ThreadRef,
    requestId: string,
    answer: OwnerAnswer,
    message: MessageId | null,
  ): Promise<boolean>;
  /** The owner used a control of a list a word posted. */
  picked(pick: ListPick): Promise<void>;
  /**
   * The owner wrote in a channel the provider found bound to no folder, before it had a message
   * to hand over; the core tells the owner how to bind.
   */
  unbound(channel: string): Promise<void>;
  /**
   * The first message of the thread `ref` is gone from the chat. The provider calls this only
   * for a thread the core keeps, in the owner's workspace, and when the deleted message was the
   * owner's (the chat's event names its author, not who deleted it); the core does not check
   * again. It forgets the thread and what it keeps of it, and leaves what the daemon wrote there.
   * A thread whose turn is running, or a stopping daemon, is left to the cleanup, and a thread a
   * delete of the daemon's holds is left to that delete.
   */
  rootGone(ref: ThreadRef): Promise<void>;
}

/**
 * Whether a chat still has a channel or a thread; `no answer` when it could not say, with no
 * reason to give.
 */
export type Presence = "gone" | "there" | "no answer";

/** The list of every session the chat shows on a page of its own. */
export interface SessionIndex {
  /** The sessions of `changed` are no longer as shown; with none given, any may be. Never waits. */
  refresh(changed?: Iterable<ThreadRef>): void;
}

/**
 * A chat, as the daemon drives it. `start`, `stop` and `close` are called once each, in that
 * order.
 */
export interface ChatProvider {
  /** The chat's name as the daemon's texts say it. */
  readonly name: string;
  /**
   * What the daemon connects to in the chat, as opaque keys: stable for one app in one workspace,
   * and known once the provider is built, before `start`. A daemon refuses to start while any of
   * them is held by another daemon, since two connections on one app would share its events.
   */
  readonly identities: readonly string[];
  readonly capabilities: ChatCapabilities;
  thread(ref: ThreadRef): ThreadChat;
  channel(channel: string): ChannelChat;
  /** `text` made safe to stand inside a line of `markup`, where it is shown as written. */
  escape(text: string, markup: Markup): string;
  /**
   * The channel as the chat writes it inside a line of `markup`, so that the owner can tell which
   * one it is. Never rejects.
   */
  channelName(channel: string, markup: Markup): string;
  /**
   * When the thread was opened, in seconds since the epoch, as its name alone tells; null when
   * the name tells nothing.
   */
  openedAt(ref: ThreadRef): number | null;
  /**
   * Whether the chat still has `channel`. A chat that could not say answers `no answer`, or
   * rejects with a `ChatError` whose name is the reason: the core logs it and forgets nothing.
   */
  channelState(channel: string): Promise<Presence>;
  /**
   * Whether the chat still has the thread's first message. Answers like `channelState`; `gone`
   * only when the chat is certain.
   */
  threadState(ref: ThreadRef): Promise<Presence>;
  /**
   * The mark a root carries for `status`, written for a reference, so that a line about a session
   * shows what its thread shows. Present with `reactions`.
   */
  statusMark?(status: SessionStatus): string;
  /** The chat's index of the sessions. A chat with none leaves it out, and nothing asks for one. */
  readonly index?: SessionIndex;
  /**
   * `!open` typed in a session's thread: offers the files of `folder`, or shares the one
   * `target` names, into the thread. Present with `fileUpload`.
   */
  openFile?(ref: ThreadRef, folder: string, target: string): Promise<void>;
  /**
   * `!tag` and `!untag` typed in a session's thread: shows `tag` on the thread where the owner
   * looks at the channel and keeps the thread at hand; null takes both away. Rejects with a
   * `ChatError` when the chat refused. Present with `threadTags`.
   */
  tagThread?(ref: ThreadRef, tag: string | null): Promise<void>;
  /**
   * Makes the thread's root show `title`, and the tag it carries, and nothing else: the owner's
   * own words leave it. With `keep`, the chat reads the root once and hands `keep` the words it
   * held, in the form the agent receives a message (the chat's own markup turned to the plain
   * text of a prompt, the tag left out), and edits only after `keep` has finished; when `keep`
   * throws, nothing is edited and the error is rethrown. Rejects with a `ChatError` when the chat
   * refused, `permanent` when it will refuse again. Present with `threadTitles`.
   */
  titleThread?(
    ref: ThreadRef,
    title: string,
    keep?: (text: string) => void | Promise<void>,
  ): Promise<void>;
  /**
   * `!delete-thread` typed in an idle session's thread: asks the owner alone to confirm, and on
   * their yes deletes the thread's messages and forgets the thread, as the chat's index deletes
   * one; a no leaves everything as it was. Resolves once the question is shown. Present with
   * `threadDelete`.
   */
  deleteThread?(ref: ThreadRef): Promise<void>;
  /**
   * A `!word` that is no command of the daemon's or the session's, typed in `ref`: shows the
   * owner alone, in the thread, a field holding exactly `typed` and the commands it could mean,
   * each a control that puts its `text` in the field. What the owner sends from the field is
   * handed to `ChatInbound.message` as a message of the thread with the id `message`, the typed
   * one, so that it is read as typed text: a known command runs. With `all`, `candidates` is
   * every command and not the nearest few. Resolves once the suggestion is shown. Present with
   * `commandSuggestions`; without it the word goes to the agent as before.
   */
  suggestCommands?(ref: ThreadRef, suggestion: CommandSuggestion): Promise<void>;
  /** Opens the connection: from here what the owner does reaches `inbound`. */
  start(inbound: ChatInbound): Promise<void>;
  /**
   * Closes the connection: nothing reaches the core any more, and a call already under way
   * does nothing from its next step on. What the daemon says outside a reply from here on may
   * be dropped; a reply still writes, since the sessions end theirs after this.
   */
  stop(): Promise<void>;
  /** After every session closed: what the chat shows of them is written one last time. */
  close(): Promise<void>;
}
