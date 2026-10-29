/**
 * The memory chat's room: the channels, threads and messages it holds, and the people a test
 * plays in it. It is written against the chat seam alone: nothing here knows a chat library, the
 * core or the other modules.
 *
 * A person acts through `Room.as`. Every path of a person that could reach the daemon (a
 * message, an answer to a request, a pick from a list) checks on its own that the person is the
 * owner before it calls `ChatInbound`, as a provider must (invariant 1 of CLAUDE.md); and none
 * reaches it before `start` or after `stop`. What a person does is kept in the room whoever
 * does it, so a test reads it back.
 */
import {
  ChatError,
  type ChatInbound,
  type CommandSuggestion,
  type ListPick,
  type MessageId,
  type OwnerAnswer,
  type OwnerList,
  type OwnerRequest,
  type RewindAction,
  type RunningList,
  type ThreadList,
  type ThreadRef,
} from "../../../src/chat/seam.ts";
import type { ChatContext } from "../../../src/core/port.ts";

/** The tenant of a memory chat: the workspace the owner belongs to. */
export const HOME = "memory-home";
/** Another tenant of the same chat, where even the owner's user id is nobody the daemon serves. */
export const ELSEWHERE = "memory-elsewhere";

/** The owner of a memory chat unless a test names another. */
export const OWNER = "alice";
/** Somebody who is not the owner. */
export const SOMEONE = "bob";
/** The author of everything the daemon writes. */
export const DAEMON = "daemon";

export type MessageKind =
  | "message"
  | "reply"
  | "notice"
  | "reference"
  | "request"
  | "list"
  | "suggestion";

/** A message as the chat holds it. */
export interface StoredMessage {
  readonly id: MessageId;
  /** Its place in the chat: a larger number was written later (ids do not sort as strings). */
  readonly position: number;
  readonly channel: string;
  /** The thread it belongs to; null for a line the daemon wrote in a channel outside any. */
  readonly thread: string | null;
  /** Written in the channel's main view (a thread's root, or a line of the channel itself). */
  readonly topLevel: boolean;
  readonly author: string;
  kind: MessageKind;
  /** What it shows now. */
  text: string;
  /** It has a control to press. */
  pressable: boolean;
  /** A reply the daemon has not ended. */
  unfinished: boolean;
  deleted: boolean;
  /** Folded by a rewind: what the message showed before, now behind the title it shows. */
  inside: string | null;
}

/** A message as a test reads it: a copy, so what it holds does not change under the reader. */
export interface ShownMessage {
  readonly id: MessageId;
  readonly author: string;
  readonly kind: MessageKind;
  readonly text: string;
  readonly pressable: boolean;
  readonly unfinished: boolean;
  readonly topLevel: boolean;
  /** What a folded message holds behind its title (`text`); null for a message that is not folded. */
  readonly inside: string | null;
}

/** A request the owner can answer: the daemon asked it and nobody answered or withdrew it. */
export interface OpenRequest {
  readonly requestId: string;
  readonly message: MessageId;
  readonly ref: ThreadRef;
  readonly request: OwnerRequest;
  readonly title: string;
}

/** A list the owner can pick from. */
export interface OpenList {
  readonly message: MessageId;
  readonly channel: string;
  readonly list: OwnerList;
  readonly title: string;
}

/** A list posted in a thread, the owner can pick from. */
export interface OpenThreadList {
  readonly message: MessageId;
  readonly ref: ThreadRef;
  readonly list: ThreadList;
  readonly title: string;
}

/** A file shared into a thread. */
export interface SharedFile {
  readonly ref: ThreadRef;
  readonly name: string;
  readonly title: string;
  readonly content: string;
}

/** A suggestion of commands the owner can send a text from. */
export interface OpenSuggestion {
  readonly message: MessageId;
  readonly ref: ThreadRef;
  readonly suggestion: CommandSuggestion;
}

/** A message a person wrote: what a test needs to answer in its thread. */
export interface Sent {
  readonly id: MessageId;
  readonly ref: ThreadRef;
  readonly topLevel: boolean;
}

export interface SaysOptions {
  /** A thread the message is written in; absent, the message is top-level and opens its own. */
  readonly thread?: string;
  /** The message carries files or was spoken: the daemon never reads it as a word. */
  readonly literal?: boolean;
}

/** The people of the room. */
export interface Person {
  /**
   * Writes `text` in `channel`. The message is in the chat whoever writes it; it reaches the
   * daemon only from the owner, only while the provider runs.
   */
  says(channel: string, text: string, options?: SaysOptions): Promise<Sent>;
  /**
   * Answers the open request `requestId` with the answer its control would give (a permission's
   * allow or deny, a question form's answers, the hold's choice, the setup's selection). Throws
   * when no such request is open or the answer is of another type. Resolves with what
   * `ChatInbound.answer` answered, or null when nothing reached the daemon.
   */
  answers(requestId: string, answer: OwnerAnswer): Promise<boolean | null>;
  /**
   * Uses the control of one row of the open list `list`: a folder's path, or a session's id.
   * Throws when the list is not open or has no such row. Resolves with whether the pick reached
   * the daemon. A list of an update has one row: the version it installs.
   */
  picks(list: MessageId, row: string): Promise<boolean>;
  /**
   * Uses the control of a file's row in the open thread list `list`. Throws when the list is not
   * open or has no such row. Resolves with whether the pick reached the daemon.
   */
  picksFile(list: MessageId, path: string): Promise<boolean>;
  /**
   * Uses the selector of the open thread list `list` to show the view `view`. Throws when the list
   * is not open or has no such view. Resolves with whether the pick reached the daemon.
   */
  picksView(list: MessageId, view: string): Promise<boolean>;
  /**
   * Picks the prompt `promptId` in the open rewind list `list`. Throws when the list is not open
   * or has no such prompt. Resolves with whether the pick reached the daemon.
   */
  picksPoint(list: MessageId, promptId: string): Promise<boolean>;
  /**
   * Uses the control of `action` in the open rewind actions `list`. Throws when the list is not
   * open or offers no such control. Resolves with whether the pick reached the daemon.
   */
  picksAction(list: MessageId, action: RewindAction): Promise<boolean>;
  /**
   * Sends `text` from the field of the open suggestion `suggestion`, the way its Enter does: it
   * reaches the daemon as a message of the thread, with the id of the message that typed the
   * word. Throws when no such suggestion is open. Resolves with whether it reached the daemon.
   */
  types(suggestion: MessageId, text: string): Promise<boolean>;
  /**
   * Uses the control that installs `version` on the chat's own page, the one a chat with a page
   * of its own draws and this chat does not: it names no message. Resolves with whether the pick
   * reached the daemon.
   */
  picksOnPage(version: string): Promise<boolean>;
  /**
   * Deletes the message `said`: the first message of its thread when its id is the thread's, else
   * a reply. The message is gone for the chat whoever deletes it. As Slack's event does, the chat
   * tells the daemon (`ChatInbound.rootGone`) of a first message whose AUTHOR is the owner, not of
   * who deleted it, and only for a thread the daemon keeps (`keepThread`); a reply never.
   * Resolves with whether it reached the daemon.
   */
  deletes(said: { readonly id: MessageId; readonly ref: ThreadRef }): Promise<boolean>;
}

function key(channel: string, thread: string): string {
  return `${channel}\n${thread}`;
}

/** The thread a message is in, by the names the daemon sees; a line of the channel has none. */
export function refOf(message: StoredMessage): ThreadRef {
  return { channel: message.channel, thread: message.thread ?? "" };
}

function shown(message: StoredMessage): ShownMessage {
  const { id, author, kind, text, pressable, unfinished, topLevel, inside } = message;
  return { id, author, kind, text, pressable, unfinished, topLevel, inside };
}

/** A reply the room places the list of: the same rule as Slack's, over this room's counter. */
export interface Placed {
  /** The message it writes into; null while it has none. */
  readonly message: StoredMessage | null;
  /** It rests (`rest` was called after `finish`) or its end has landed: it can hold the list. */
  readonly resting: boolean;
  /** The list of what still runs it shows under its message from now on; only one reply has it. */
  assign(list: RunningList | null): void;
}

/** What a memory chat holds, and the test's side of it. */
export class Room {
  readonly owner: string;
  /**
   * Whether a message can be rewritten once its reply ended. A room that cannot draws no list of
   * what still runs and shows the session's footer as a message of its own, the push of which is
   * that chat's.
   */
  readonly edits: boolean;
  #clock: ChatContext["clock"] | null = null;
  #inbound: ChatInbound | null = null;
  #sequence = 0;
  readonly #channels = new Set<string>();
  readonly #threads = new Map<string, number>();
  readonly #kept = new Set<string>();
  readonly #messages: StoredMessage[] = [];
  readonly #requests = new Map<string, OpenRequest>();
  readonly #lists = new Map<MessageId, OpenList>();
  readonly #threadLists = new Map<MessageId, OpenThreadList>();
  readonly #shared: SharedFile[] = [];
  readonly #suggestions = new Map<MessageId, OpenSuggestion>();
  readonly #strays: string[] = [];
  readonly #placed = new Set<Placed>();
  readonly #running = new Map<string, RunningList>();
  #lookupFails = false;

  readonly #threadIds: "own" | "opening";

  /**
   * `threadIds` says how a thread is named: `own` (the default) gives it a name of its own, which
   * is not the id of the message that opened it; `opening` names it by that message's id, as a
   * chat whose threads are its messages does.
   */
  constructor(owner: string, threadIds: "own" | "opening" = "own", edits = true) {
    this.#threadIds = threadIds;
    this.edits = edits;
    this.owner = owner;
  }

  // ---- the test's side

  /** A channel of the chat; the id the daemon sees is the one returned. */
  openChannel(name: string): string {
    const channel = `chan-${name}`;
    this.#channels.add(channel);
    return channel;
  }

  /** The channel is gone: the chat answers `gone` about it and refuses what is written in it. */
  removeChannel(channel: string): void {
    this.#channels.delete(channel);
  }

  /** The daemon keeps `ref` (the core's state holds it): its deleted first message is told. */
  keepThread(ref: ThreadRef): void {
    this.#kept.add(key(ref.channel, ref.thread));
  }

  /** The thread's first message is gone: the chat answers `gone` about it. */
  removeThread(ref: ThreadRef): void {
    this.#threads.delete(key(ref.channel, ref.thread));
  }

  /** From now on the chat can not say whether a channel or a thread is there, or can again. */
  failChannelLookups(fails = true): void {
    this.#lookupFails = fails;
  }

  /**
   * A thread that was there before the daemon connected, opened by the owner's message in
   * `channel`: that message reaches no inbound.
   */
  openThread(channel: string, text = "an old thread"): ThreadRef {
    return refOf(this.write(channel, null, this.owner, text, "message"));
  }

  /** The person `user` plays: the owner, or anybody else. */
  as(user: string, tenant: string = HOME): Person {
    // Who the provider lets through: the owner of this chat, in this chat's own tenant.
    const owns = user === this.owner && tenant === HOME;
    return {
      says: (channel, text, options) => this.#says(user, owns, channel, text, options),
      answers: (requestId, answer) => this.#answers(owns, requestId, answer),
      picks: (list, row) => this.#picks(owns, list, row),
      picksFile: (list, path) => this.#picksFile(owns, list, path),
      picksView: (list, view) => this.#picksView(owns, list, view),
      picksPoint: (list, promptId) => this.#picksPoint(owns, list, promptId),
      picksAction: (list, action) => this.#picksAction(owns, list, action),
      types: (suggestion, text) => this.#types(owns, suggestion, text),
      picksOnPage: (version) => this.#picksOnPage(owns, version),
      deletes: (said) => this.#deletes(said, tenant === HOME),
    };
  }

  /**
   * The messages of a thread (its root first), or with no `thread` of the channel's main view
   * (the roots of its threads, and the lines the daemon wrote outside any), in order. A deleted
   * message is not there.
   */
  messages(channel: string, thread?: string): readonly ShownMessage[] {
    return this.#messages
      .filter(
        (m) =>
          !m.deleted &&
          m.channel === channel &&
          (thread === undefined ? m.topLevel : m.thread === thread),
      )
      .map(shown);
  }

  /** What `messages` shows, as text. */
  texts(channel: string, thread?: string): readonly string[] {
    return this.messages(channel, thread).map((m) => m.text);
  }

  /** The requests the owner can still answer, in the order they were asked. */
  requests(): readonly OpenRequest[] {
    return [...this.#requests.values()];
  }

  /** The lists the owner can still pick from. */
  lists(): readonly OpenList[] {
    return [...this.#lists.values()];
  }

  /** The thread lists the owner can still pick from. */
  threadLists(): readonly OpenThreadList[] {
    return [...this.#threadLists.values()];
  }

  /** The files shared into threads, in order. */
  shared(): readonly SharedFile[] {
    return [...this.#shared];
  }

  /** The suggestions of commands the owner can still send a text from. */
  suggestions(): readonly OpenSuggestion[] {
    return [...this.#suggestions.values()];
  }

  /**
   * Calls the daemon made for a capability this chat lacks (a reaction, a status, an activity
   * line), or asked for a thread the chat never issued: empty while the core honours the seam.
   */
  strayCalls(): readonly string[] {
    return this.#strays;
  }

  // ---- the provider's side

  /** Binds the clock a thread's opening is dated with. */
  bind(clock: ChatContext["clock"]): void {
    this.#clock = clock;
  }

  /** From here what the owner does reaches `inbound`. */
  attach(inbound: ChatInbound): void {
    this.#inbound = inbound;
  }

  /** Nothing the owner does reaches the daemon any more, if `inbound` is the one attached. */
  detach(inbound: ChatInbound): void {
    if (this.#inbound === inbound) this.#inbound = null;
  }

  stray(call: string): void {
    this.#strays.push(call);
  }

  knows(channel: string): boolean {
    return this.#channels.has(channel);
  }

  knowsThread(ref: ThreadRef): boolean {
    return this.#threads.has(key(ref.channel, ref.thread));
  }

  lookupFails(): boolean {
    return this.#lookupFails;
  }

  openedAt(ref: ThreadRef): number | null {
    return this.#threads.get(key(ref.channel, ref.thread)) ?? null;
  }

  /**
   * Where the other replies and the owner's messages of `message`'s thread sit, as positions:
   * what a reply needs to tell whether it is the last and whether it was overtaken.
   */
  around(message: StoredMessage): { others: number[]; marks: number[] } {
    const same = this.#messages.filter(
      (m) =>
        !m.deleted && m !== message && m.channel === message.channel && m.thread === message.thread,
    );
    return {
      others: same.filter((m) => m.kind === "reply").map((m) => m.position),
      marks: same
        .filter((m) => m.kind === "message" && m.author === this.owner)
        .map((m) => m.position),
    };
  }

  /** A reply whose list and footer the room places. */
  join(reply: Placed): void {
    this.#placed.add(reply);
  }

  /**
   * Hands every reply of the thread the list of what still runs when it holds it: this chat draws
   * it under the newest reply of the thread, once that one rests. A reply never moves, so only its
   * text changes.
   */
  place(ref: ThreadRef): void {
    for (const [reply, holds] of this.#tails(ref, null)) reply.assign(this.#listOf(ref, holds));
  }

  /** What still runs in the thread changed; null for nothing. */
  showRunning(ref: ThreadRef, list: RunningList | null): void {
    if (list === null) this.#running.delete(key(ref.channel, ref.thread));
    else this.#running.set(key(ref.channel, ref.thread), list);
    this.place(ref);
  }

  /** What `subject` would show if its end had landed now: what its end writes at once. */
  listIf(ref: ThreadRef, subject: Placed): RunningList | null {
    const holds = this.#tails(ref, subject).get(subject);
    return holds === undefined ? null : this.#listOf(ref, holds);
  }

  #listOf(ref: ThreadRef, holds: boolean): RunningList | null {
    return holds ? (this.#running.get(key(ref.channel, ref.thread)) ?? null) : null;
  }

  /** The replies of the thread, each with whether it is the newest and rests: it holds the list. */
  #tails(ref: ThreadRef, subject: Placed | null): Map<Placed, boolean> {
    const here: { reply: Placed; at: number; resting: boolean }[] = [];
    for (const reply of this.#placed) {
      const message = reply.message;
      if (message === null && reply !== subject) continue;
      if (message !== null && (message.deleted || refOf(message).thread !== ref.thread)) continue;
      if (message !== null && message.channel !== ref.channel) continue;
      here.push({
        reply,
        // A reply with no message yet is the newest: its end writes it below the others.
        at: message?.position ?? Number.POSITIVE_INFINITY,
        resting: reply.resting || reply === subject,
      });
    }
    const newest = Math.max(...here.map((entry) => entry.at));
    return new Map(here.map((entry) => [entry.reply, entry.resting && entry.at === newest]));
  }

  message(id: MessageId): StoredMessage | null {
    return this.#messages.find((m) => m.id === id && !m.deleted) ?? null;
  }

  /**
   * Writes a message. Without a `thread` it is top-level: by the owner or anybody it opens a
   * thread of its own, by the daemon it is a line of the channel unless `opens` says it starts a
   * thread. Throws `ChatError` for a channel the chat does not have.
   */
  write(
    channel: string,
    thread: string | null,
    author: string,
    text: string,
    kind: MessageKind,
    opens = author !== DAEMON,
  ): StoredMessage {
    if (!this.#channels.has(channel)) throw new ChatError("channel_not_found");
    this.#sequence += 1;
    const id = `msg-${this.#sequence}`;
    let name = thread;
    if (name === null && opens) {
      if (this.#clock === null) throw new Error("the memory chat is not built yet");
      name = this.#threadIds === "opening" ? id : `thread-${this.#sequence}`;
      this.#threads.set(key(channel, name), this.#clock.time());
    }
    const message: StoredMessage = {
      id,
      position: this.#sequence,
      channel,
      thread: name,
      topLevel: thread === null,
      author,
      kind,
      text,
      pressable: false,
      unfinished: false,
      deleted: false,
      inside: null,
    };
    this.#messages.push(message);
    return message;
  }

  /** Changes what a message shows. Throws `ChatError` once its channel is gone. */
  edit(message: StoredMessage, text: string): void {
    if (!this.#channels.has(message.channel)) throw new ChatError("channel_not_found");
    message.text = text;
  }

  /** A request is shown in a message; the owner can answer it until it is decided or withdrawn. */
  addRequest(request: OpenRequest): void {
    const message = this.message(request.message);
    if (message !== null) message.pressable = true;
    this.#requests.set(request.requestId, request);
  }

  addList(list: OpenList): void {
    const message = this.message(list.message);
    if (message !== null) message.pressable = true;
    this.#lists.set(list.message, list);
  }

  /** Records a list of a thread; `replacing` is the message of the list it takes the place of. */
  addThreadList(list: OpenThreadList, replacing?: MessageId): void {
    if (replacing !== undefined) this.#threadLists.delete(replacing);
    const message = this.message(list.message);
    if (message !== null) message.pressable = true;
    this.#threadLists.set(list.message, list);
  }

  addShared(file: SharedFile): void {
    this.#shared.push(file);
  }

  addSuggestion(suggestion: OpenSuggestion): void {
    const message = this.message(suggestion.message);
    if (message !== null) message.pressable = true;
    this.#suggestions.set(suggestion.message, suggestion);
  }

  /** Nothing is left to press on the message. */
  settled(id: MessageId): void {
    const message = this.message(id);
    if (message !== null) message.pressable = false;
    for (const [requestId, open] of this.#requests) {
      if (open.message === id) this.#requests.delete(requestId);
    }
    this.#lists.delete(id);
    this.#threadLists.delete(id);
    this.#suggestions.delete(id);
  }

  remove(id: MessageId): void {
    const message = this.message(id);
    if (message === null) return;
    this.settled(id);
    message.deleted = true;
  }

  // ---- the people

  async #says(
    user: string,
    owns: boolean,
    channel: string,
    text: string,
    options: SaysOptions = {},
  ): Promise<Sent> {
    const { thread = null, literal = false } = options;
    if (thread !== null && !this.#threads.has(key(channel, thread))) {
      throw new Error(`no thread ${thread} in ${channel}`);
    }
    const message = this.write(channel, thread, user, text, "message");
    const sent: Sent = { id: message.id, ref: refOf(message), topLevel: message.topLevel };
    if (owns) this.place(sent.ref);
    // The owner check is this path's own: a message of somebody else is in the chat and nowhere else.
    if (owns && this.#inbound !== null) {
      await this.#inbound.message({
        ref: sent.ref,
        id: sent.id,
        topLevel: sent.topLevel,
        text,
        plain: text,
        literal,
        content: async () => text,
      });
    }
    return sent;
  }

  async #answers(owns: boolean, requestId: string, answer: OwnerAnswer): Promise<boolean | null> {
    const open = this.#requests.get(requestId);
    if (open === undefined) throw new Error(`no open request ${requestId}`);
    if (open.request.type !== answer.type) {
      throw new Error(`a ${open.request.type} request takes no ${answer.type} answer`);
    }
    // The owner check is this path's own, for a click and for a form alike.
    if (!owns || this.#inbound === null) return null;
    return this.#inbound.answer(open.ref, requestId, answer, open.message);
  }

  async #picks(owns: boolean, id: MessageId, row: string): Promise<boolean> {
    const open = this.#lists.get(id);
    if (open === undefined) throw new Error(`no open list ${id}`);
    const pick = this.#pickOf(open, row);
    // The owner check is this path's own.
    if (!owns || this.#inbound === null) return false;
    await this.#inbound.picked(pick);
    return true;
  }

  async #picksPoint(owns: boolean, id: MessageId, promptId: string): Promise<boolean> {
    const open = this.#threadLists.get(id);
    if (open === undefined) throw new Error(`no open thread list ${id}`);
    if (open.list.type !== "rewind-points") throw new Error(`list ${id} is no rewind list`);
    if (!open.list.points.some((point) => point.id === promptId)) {
      throw new Error(`no prompt ${promptId} in the list`);
    }
    if (!owns || this.#inbound === null) return false;
    await this.#inbound.picked({
      type: "rewind-point",
      ref: open.ref,
      session: open.list.session,
      promptId,
      list: id,
    });
    return true;
  }

  async #picksAction(owns: boolean, id: MessageId, action: RewindAction): Promise<boolean> {
    const open = this.#threadLists.get(id);
    if (open === undefined) throw new Error(`no open thread list ${id}`);
    if (open.list.type !== "rewind-actions") throw new Error(`list ${id} is no rewind actions`);
    const { files, conversation } = open.list;
    const offered =
      action === "cancel" ||
      (action === "code" && files !== null) ||
      (action === "conversation" && conversation) ||
      (action === "both" && files !== null && conversation);
    if (!offered) throw new Error(`the list offers no ${action}`);
    if (!owns || this.#inbound === null) return false;
    await this.#inbound.picked({
      type: "rewind-action",
      ref: open.ref,
      session: open.list.session,
      promptId: open.list.point.id,
      action,
      list: id,
    });
    return true;
  }

  async #picksFile(owns: boolean, id: MessageId, path: string): Promise<boolean> {
    const open = this.#threadLists.get(id);
    if (open === undefined) throw new Error(`no open thread list ${id}`);
    if (open.list.type !== "diff") throw new Error(`list ${id} is no diff list`);
    if (!open.list.files.some((file) => file.path === path)) {
      throw new Error(`no file ${path} in the list`);
    }
    // The owner check is this path's own.
    if (!owns || this.#inbound === null) return false;
    await this.#inbound.picked({
      type: "diff-file",
      ref: open.ref,
      session: open.list.session,
      view: open.list.view,
      path,
      list: id,
    });
    return true;
  }

  async #picksView(owns: boolean, id: MessageId, view: string): Promise<boolean> {
    const open = this.#threadLists.get(id);
    if (open === undefined) throw new Error(`no open thread list ${id}`);
    if (open.list.type !== "diff") throw new Error(`list ${id} is no diff list`);
    if (!open.list.views.some((offered) => offered.id === view)) {
      throw new Error(`no view ${view} in the list`);
    }
    if (!owns || this.#inbound === null) return false;
    await this.#inbound.picked({
      type: "diff-view",
      ref: open.ref,
      session: open.list.session,
      view,
      list: id,
    });
    return true;
  }

  async #types(owns: boolean, id: MessageId, text: string): Promise<boolean> {
    const open = this.#suggestions.get(id);
    if (open === undefined) throw new Error(`no open suggestion ${id}`);
    // The owner check is this path's own.
    if (!owns || this.#inbound === null) return false;
    this.remove(id);
    await this.#inbound.message({
      ref: open.ref,
      id: open.suggestion.message,
      topLevel: false,
      text,
      plain: text,
      literal: false,
      content: async () => text,
    });
    return true;
  }

  async #deletes(said: { id: MessageId; ref: ThreadRef }, home: boolean): Promise<boolean> {
    // The first message of a thread is named by its message id or by the thread's own name.
    const first = this.#messages.find(
      (m) => m.channel === said.ref.channel && m.thread === said.ref.thread && m.topLevel,
    );
    const root = said.id === said.ref.thread || said.id === first?.id;
    const author = (root ? first : this.message(said.id))?.author ?? null;
    if (root) this.removeThread(said.ref);
    else this.remove(said.id);
    // The owner check of this path is the author's, in the owner's workspace: the event does not
    // say who deleted, and a deletion in another workspace is no event of this chat's.
    if (!root || !home || author !== this.owner || this.#inbound === null) return false;
    if (!this.#kept.has(key(said.ref.channel, said.ref.thread))) return false;
    await this.#inbound.rootGone(said.ref);
    return true;
  }

  async #picksOnPage(owns: boolean, version: string): Promise<boolean> {
    if (!owns || this.#inbound === null) return false;
    await this.#inbound.picked({ type: "update", channel: null, version, list: null });
    return true;
  }

  #pickOf(open: OpenList, row: string): ListPick {
    const { list, channel, message } = open;
    if (list.type === "update") {
      if (list.to !== row) throw new Error(`the list installs ${list.to}, not ${row}`);
      return { type: "update", channel, version: row, list: message };
    }
    if (list.type === "folders") {
      if (!list.folders.includes(row)) throw new Error(`no folder ${row} in the list`);
      return { type: "folder", channel, path: row, list: message };
    }
    if (!list.sessions.some((s) => s.id === row)) throw new Error(`no session ${row} in the list`);
    return { type: "session", channel, sessionId: row, thread: list.thread, list: message };
  }
}
