/**
 * The flows as they call one another, and as `Inbound` hands a provider's calls to them. Each
 * is built by the factory of its own file (`asking`, `lists`, `messages`) over `FlowDeps`.
 */
import type {
  InboundMessage,
  ListPick,
  MessageId,
  OwnerAnswer,
  ThreadRef,
} from "../../chat/seam.ts";
import type { ThreadSession } from "../sessions/session.ts";

/** A session's setup, asked before its first prompt. */
export interface SetupFlow {
  /**
   * Asks for the model, the effort and bypass and applies the answer to the live session. The
   * session to send the message on, which can be another object than `session` when that one
   * closed meanwhile; null when the message is not sent, and the owner was told.
   */
  beforeSending(ref: ThreadRef, session: ThreadSession): Promise<ThreadSession | null>;
}

/** The same-folder hold. */
export interface HoldFlow {
  /**
   * Asks whether to send a message that would wake `session` while `other` works in the same
   * folder. True to send it; false when it is not sent, and the owner was told.
   */
  beforeSending(ref: ThreadRef, session: ThreadSession, other: ThreadSession): Promise<boolean>;
}

/** A session open in a terminal on the host. */
export interface TerminalFlow {
  /**
   * Before a message reaches `session`: waits out a turn a terminal runs, asks once per terminal
   * left open whether to send here, and shows the turns written there since. True to send; false
   * when it is not sent, and the owner was told.
   */
  beforeSending(ref: ThreadRef, session: ThreadSession): Promise<boolean>;
  /**
   * `!terminal`: moves `session` to a terminal, confirmed first when it would stop background
   * work, and tells the owner the line to run there.
   */
  move(ref: ThreadRef, session: ThreadSession): Promise<void>;
}

/** The owner's answer to a request: a permission, a question, the hold, the setup. */
export interface AnswersFlow {
  /** As `ChatInbound.answer`. */
  answer(
    ref: ThreadRef,
    requestId: string,
    answer: OwnerAnswer,
    message: MessageId | null,
  ): Promise<boolean>;
}

/** `!resume`. */
export interface ResumeFlow {
  /**
   * `!resume` typed in a channel; `ref` is the thread of the owner's word. With no `target` it
   * offers the folder's sessions; with one it resumes the session it names into that thread.
   */
  word(ref: ThreadRef, target: string): Promise<void>;
}

/** `!fork`. */
export interface ForkFlow {
  /**
   * `!fork` typed in the thread of `session` as the owner's `message`: once no turn runs there,
   * copies the session into a new thread of the channel, which inherits its effort and bypass and
   * starts on `prompt` (empty: it waits for the owner's first message), and tells this thread.
   */
  word(ref: ThreadRef, message: MessageId, session: ThreadSession, prompt: string): Promise<void>;
}

/** `!diff`. */
export interface DiffFlow {
  /**
   * `!diff` typed in the thread of `session`: lists the files of its repository that differ from
   * HEAD, with a control per file and a selector of views, or tells the owner why it cannot.
   */
  word(ref: ThreadRef, session: ThreadSession): Promise<void>;
  /**
   * The owner used a control of that list: a file shares its diff into the thread, a view draws
   * the list again. A list made for another session, or a file no longer changed, is told.
   */
  picked(pick: Extract<ListPick, { type: "diff-file" | "diff-view" }>): Promise<void>;
}

/** `!bind`. */
export interface BindFlow {
  /** `!bind <folder>` typed in a channel. */
  to(channel: string, path: string): Promise<void>;
  /** `!bind` alone: the folders a session can start in, offered as a list. */
  list(channel: string): Promise<void>;
}

/** `!allaboard`, the update from the chat, and the line told once per version. */
export interface AllaboardFlow {
  /** `!allaboard`: the version that runs and the latest, as a reference. */
  show(): Promise<string>;
  /** `!allaboard update` typed in a channel: the offer of the latest version, or why there is none. */
  update(channel: string): Promise<void>;
  /** `!allaboard restart` typed in a channel. */
  restart(channel: string): Promise<void>;
  /** The owner pressed the control that installs a version, on an offer or on the chat's own page. */
  picked(pick: Extract<ListPick, { type: "update" }>): Promise<void>;
  /**
   * An owner's message arrived: when a newer version is known and he was not told of it, tells
   * him for his eyes alone, once per version. Decides and records before its first await; never
   * rejects.
   */
  notice(message: InboundMessage): Promise<void>;
}

/** A pick from a list of folders or of sessions; the update's and the diff's are their flows'. */
export interface PicksFlow {
  /** As `ChatInbound.picked`. */
  picked(pick: Extract<ListPick, { type: "folder" | "session" }>): Promise<void>;
}

/** A message the owner wrote. */
export interface MessagesFlow {
  /** As `ChatInbound.message`. */
  message(message: InboundMessage): Promise<void>;
}

/** What the message flow calls of the others. */
export interface OtherFlows {
  readonly setup: SetupFlow;
  readonly hold: HoldFlow;
  readonly terminal: TerminalFlow;
  readonly resume: ResumeFlow;
  readonly bind: BindFlow;
  readonly diff: DiffFlow;
  /** Absent in a daemon built without a way to update itself: `!allaboard` is then not offered. */
  readonly allaboard?: AllaboardFlow;
}
