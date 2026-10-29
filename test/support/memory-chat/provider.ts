/**
 * The memory chat's provider: the chat seam implemented over a `Room`, with every capability
 * false. Nothing streams, nothing reacts, no activity line, no session index, no file upload,
 * and a line for the owner alone is a message of the thread.
 *
 * The seam is read as written. A member that "never rejects" swallows a refusal of the room; one
 * that rejects with `ChatError` lets the room's through. A call for a capability this chat lacks
 * does nothing but leave a record in `Room.strayCalls`, which a test asserts empty. So does a
 * thread asked for that the chat never issued.
 */

import { isDeepStrictEqual } from "node:util";
import type { Question } from "../../../src/agent/seam.ts";
import {
  type ChannelChat,
  type ChatCapabilities,
  ChatError,
  type ChatInbound,
  type ChatProvider,
  type CommandSuggestion,
  type FooterFields,
  type LoopCard,
  type Markup,
  type MessageId,
  type OpenMessageChange,
  type OwnerList,
  type OwnerRequest,
  type Presence,
  type Reply,
  type RunningList,
  type TaskUpdate,
  type ThreadChat,
  type ThreadList,
  type ThreadRef,
} from "../../../src/chat/seam.ts";
import { DAEMON, type MessageKind, type Placed, type Room, type StoredMessage } from "./room.ts";

const CAPABILITIES: ChatCapabilities = {
  nativeStreaming: false,
  rootStatus: false,
  acknowledgement: false,
  activityLine: false,
  fileUpload: false,
  threadLists: false,
  messageFold: false,
  threadTags: false,
  threadTitles: false,
  threadDelete: false,
  threadOpen: true,
  commandSuggestions: false,
  loopCard: true,
};

/** The footer as one line of words. */
function footerLine(footer: FooterFields): string {
  const { changes, sessionTokens, contextPercent, sessionLimit, weekLimit } = footer;
  return [
    // No number: the scenarios run on the real clock, and their footers must read the same.
    footer.work === null ? null : "worked",
    footer.planning ? "plan" : footer.bypass ? "bypass" : null,
    footer.model,
    footer.effort === null || footer.effortObserved === null
      ? footer.effort
      : `${footer.effort} (${footer.effortObserved})`,
    footer.folder,
    footer.branch,
    changes === null ? null : `+${changes[0]} -${changes[1]}`,
    sessionTokens === null ? null : `${sessionTokens} tokens`,
    contextPercent === null ? null : `${contextPercent}% context`,
    sessionLimit === null ? null : `session ${sessionLimit.percent}%`,
    weekLimit === null ? null : `week ${weekLimit.percent}%`,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

type Segment =
  | { readonly kind: "text"; text: string }
  | { readonly kind: "task"; update: TaskUpdate };

/**
 * One reply: a single message whose content grows. Its text and its task lines stand in the
 * order they first came; a task line changes where it stands. After `finish` a line of a run of
 * calls shows its folded words, or goes when they are empty, and from `rest` or `closeOut` on the
 * list of what still runs (on the reply the room names) and the footer are added. The message is
 * always an edit, so `rest` only lets them show.
 */
class MemoryReply implements Reply, Placed {
  readonly #room: Room;
  readonly #ref: ThreadRef;
  readonly #onOpen: OpenMessageChange;
  readonly #segments: Segment[] = [];
  #message: StoredMessage | null = null;
  #finished = false;
  #rested = false;
  #closed = false;
  /** The session's footer, once it is drawn under this reply; it stays for good. */
  #footer: string | null = null;
  /** The list of what still runs the room placed here. */
  #list: RunningList | null = null;
  #lost = false;
  #landed = false;
  readonly #landing: Promise<boolean>;
  #resolveLanding: (landed: boolean) => void = () => {};

  /** Present with `messageFold`. */
  readonly posted?: () => readonly MessageId[];

  constructor(room: Room, ref: ThreadRef, onOpen: OpenMessageChange, folds = false) {
    if (folds) this.posted = () => (this.#message === null ? [] : [this.#message.id]);
    this.#room = room;
    this.#ref = ref;
    this.#onOpen = onOpen;
    room.join(this);
    this.#landing = new Promise((resolve) => {
      this.#resolveLanding = resolve;
    });
  }

  get message(): StoredMessage | null {
    return this.#message;
  }

  get resting(): boolean {
    return this.#finished && (this.#rested || this.#landed);
  }

  assign(list: RunningList | null): void {
    if (isDeepStrictEqual(list, this.#list)) return;
    this.#list = list;
    if (this.#drawsFooter) this.#write();
  }

  async showFooter(footer: FooterFields): Promise<boolean> {
    // An end that did not land has no message the footer is known to sit under.
    if (!this.#landed) return false;
    if (!this.#room.edits) {
      // Nothing to rewrite: the footer is a message below the reply, once.
      this.#footer ??= footerLine(footer);
      try {
        this.#room.write(this.#ref.channel, this.#ref.thread, DAEMON, this.#footer, "notice");
        return true;
      } catch (error) {
        if (!(error instanceof ChatError)) throw error;
        this.#footer = null;
        return false;
      }
    }
    this.#footer ??= footerLine(footer);
    this.#write();
    return !this.#lost;
  }

  // A reply is one message that never moves, so it ends where it is whatever sits below it.
  get last(): boolean {
    if (this.#message === null) return false;
    const { others, marks } = this.#room.around(this.#message);
    const at = this.#message.position;
    return others.every((other) => other < at) && marks.every((mark) => mark < at);
  }

  get overtaken(): boolean {
    if (this.#message === null) return false;
    const at = this.#message.position;
    return this.#room.around(this.#message).others.some((other) => other > at);
  }

  async text(markdown: string): Promise<void> {
    const last = this.#segments.at(-1);
    if (last?.kind === "text") last.text += markdown;
    else this.#segments.push({ kind: "text", text: markdown });
    this.#write();
  }

  async task(update: TaskUpdate): Promise<void> {
    const held = this.#segments.find((s) => s.kind === "task" && s.update.id === update.id);
    if (held?.kind === "task") held.update = update;
    else this.#segments.push({ kind: "task", update });
    this.#write();
  }

  async finish(closing: readonly TaskUpdate[]): Promise<void> {
    for (const update of closing) await this.task(update);
    this.#finished = true;
    // What the reply writes is what the places would give it.
    this.#list = this.#room.listIf(this.#ref, this);
    this.#write();
    this.#room.place(this.#ref);
  }

  rest(): void {
    if (this.#rested) return;
    this.#rested = true;
    this.#list = this.#room.listIf(this.#ref, this);
    this.#write();
    this.#room.place(this.#ref);
  }

  /** The list shows once the reply waits (`rest`) or ended; a reply that only finished ends at once. */
  get #drawsFooter(): boolean {
    return this.#room.edits && this.#finished && (this.#rested || this.#closed);
  }

  async closeOut(): Promise<boolean> {
    if (this.#closed) return this.#landed;
    this.#closed = true;
    this.#list = this.#room.listIf(this.#ref, this);
    this.#write();
    this.#landed = !this.#lost;
    if (this.#landed && this.#message !== null) {
      this.#message.unfinished = false;
      this.#onOpen(this.#message.id, null);
    }
    if (this.#landed) this.#room.place(this.#ref);
    this.#resolveLanding(this.#landed);
    return this.#landed;
  }

  waitLanded(): Promise<boolean> {
    return this.#landing;
  }

  async settle(): Promise<boolean> {
    this.#write();
    return !this.#lost;
  }

  #render(): string {
    const lines = this.#segments.flatMap((segment) => {
      if (segment.kind === "text") return [segment.text.trim()];
      const { folded, preview, status, title } = segment.update;
      if (this.#finished && folded !== null) return [folded];
      // The preview is where the core keeps an answered question's answers: under the line.
      const shown = preview === null ? [] : [preview.title, preview.summary, preview.body];
      return [`[${status}] ${title}`, ...shown];
    });
    if (this.#drawsFooter) {
      const list = this.#list;
      if (list !== null) {
        lines.push(list.title);
        for (const { text, agent } of list.lines) {
          lines.push(
            agent === null
              ? `- ${text}`
              : `- ${text} · ${agent.calls} ${agent.calls === 1 ? "call" : "calls"}`,
          );
          if (agent !== null) lines.push(`  ⎿ ${agent.step}`);
        }
      }
      lines.push(this.#footer ?? "");
    }
    return lines.filter((line) => line !== "").join("\n");
  }

  /** Brings the message to what the reply is now; a refusal of the room is a write that did not land. */
  #write(): void {
    const text = this.#render();
    try {
      if (this.#message === null) {
        if (text === "") return;
        this.#message = this.#room.write(
          this.#ref.channel,
          this.#ref.thread,
          DAEMON,
          text,
          "reply",
        );
        this.#message.unfinished = true;
        this.#onOpen(null, this.#message.id);
        // A reply below the one that shows the list takes it off that one at once.
        this.#room.place(this.#ref);
      } else {
        this.#room.edit(this.#message, text);
      }
      this.#lost = false;
    } catch (error) {
      if (!(error instanceof ChatError)) throw error;
      this.#lost = true;
    }
  }
}

/** The record of an answered question: each question and what was answered to it. */
function answered(
  questions: readonly Question[],
  answers: Readonly<Record<string, string | readonly string[]>>,
): string {
  return questions
    .flatMap((question) => {
      const answer = answers[question.text];
      if (answer === undefined) return [];
      return [`${question.text}: ${typeof answer === "string" ? answer : answer.join(", ")}`];
    })
    .join("\n");
}

// The loop card of each thread, by room: a thread object is made afresh for every lookup.
const loopCards = new WeakMap<Room, Map<string, StoredMessage>>();

/** A list as one message: its title, then a line per file with its counts, or per prompt. */
function listText(list: ThreadList, title: string): string {
  if (list.type === "rewind-points") {
    return [title, ...list.points.map((point) => point.text)].join("\n");
  }
  if (list.type === "rewind-actions") {
    const { files } = list;
    return [
      `${title}: ${list.point.text}`,
      ...(files === null
        ? []
        : [`code: ${files.count} files +${files.insertions} -${files.deletions}`]),
      ...(list.conversation ? ["conversation"] : []),
    ].join("\n");
  }
  const rows = list.files.map((file) =>
    file.binary ? `${file.path} binary` : `${file.path} +${file.added} -${file.removed}`,
  );
  const views = list.views.map((view) => (view.id === list.view ? `[${view.label}]` : view.label));
  return [title, views.join(" "), ...rows].join("\n");
}

class MemoryThread implements ThreadChat {
  readonly #room: Room;
  readonly #ref: ThreadRef;
  /** Present with `threadLists`. */
  readonly offer?: (list: ThreadList, title: string, replacing?: MessageId) => Promise<MessageId>;
  /** Present with `fileUpload`. */
  readonly share?: (file: {
    readonly name: string;
    readonly title: string;
    readonly content: Uint8Array;
  }) => Promise<void>;
  /** Present with `messageFold`. */
  readonly fold?: (message: MessageId, title: string) => Promise<boolean>;
  readonly #folds: boolean;

  constructor(room: Room, ref: ThreadRef, lists: boolean, files: boolean, folds: boolean) {
    this.#room = room;
    this.#ref = ref;
    this.#folds = folds;
    if (folds) {
      // The title is what the message shows now; what it showed is kept behind it.
      this.fold = async (id, title) => {
        const message = room.message(id);
        if (message === null || message.channel !== ref.channel) return false;
        try {
          const inside = message.text;
          room.edit(message, title);
          message.inside = inside;
        } catch (error) {
          if (!(error instanceof ChatError)) throw error;
          return false;
        }
        message.kind = "notice";
        room.settled(id);
        return true;
      };
    }
    if (lists) {
      this.offer = async (list, title, replacing) => {
        const text = listText(list, title);
        const held = replacing === undefined ? null : room.message(replacing);
        let message: StoredMessage;
        if (held === null) {
          message = room.write(ref.channel, ref.thread, DAEMON, text, "list");
        } else {
          room.edit(held, text);
          message = held;
        }
        room.addThreadList({ message: message.id, ref, list, title }, replacing);
        return message.id;
      };
    }
    if (files) {
      this.share = async (file) => {
        room.addShared({
          ref,
          name: file.name,
          title: file.title,
          content: Buffer.from(file.content).toString("utf8"),
        });
      };
    }
  }

  openReply(onOpenMessage: OpenMessageChange): Reply {
    return new MemoryReply(this.#room, this.#ref, onOpenMessage, this.#folds);
  }

  showRunning(list: RunningList | null): void {
    this.#room.showRunning(this.#ref, list);
  }

  written(): void {}

  async notice(text: string): Promise<void> {
    await this.#post(text, "notice").catch(() => {});
  }

  async ask(requestId: string, request: OwnerRequest, title: string): Promise<MessageId> {
    const message = this.#room.write(this.#ref.channel, this.#ref.thread, DAEMON, title, "request");
    this.#room.addRequest({ requestId, message: message.id, ref: this.#ref, request, title });
    return message.id;
  }

  async withdraw(request: MessageId): Promise<boolean> {
    this.#room.remove(request);
    return true;
  }

  async keepAnswers(
    request: MessageId,
    questions: readonly Question[],
    answers: Readonly<Record<string, string | readonly string[]>>,
  ): Promise<void> {
    rewritten(this.#room, request, answered(questions, answers));
  }

  async rewrite(message: MessageId, text: string): Promise<void> {
    rewritten(this.#room, message, text);
  }

  async tell(text: string): Promise<void> {
    await this.#post(text, "notice").catch(() => {});
  }

  async say(markdown: string): Promise<void> {
    await this.#post(markdown, "reference");
  }

  async link(): Promise<string | null> {
    return null;
  }

  async endReply(reply: MessageId, note: string): Promise<boolean> {
    const message = this.#room.message(reply);
    if (message === null) return true;
    try {
      this.#room.edit(message, `${message.text}\n${note}`);
      message.unfinished = false;
    } catch (error) {
      if (!(error instanceof ChatError)) throw error;
      return false;
    }
    return true;
  }

  async showLoop(card: LoopCard): Promise<void> {
    // The time as the memory chat draws any moment: fixed, in UTC, so that a test can read it.
    const label = `${card.label} · ${new Date(card.at).toISOString().slice(11, 16)} UTC`;
    const footer = card.footer === null ? "" : footerLine(card.footer);
    const text = [label, card.text, footer].filter((part) => part !== "").join("\n");
    const cards = loopCards.get(this.#room) ?? new Map<string, StoredMessage>();
    loopCards.set(this.#room, cards);
    const key = `${this.#ref.channel}/${this.#ref.thread}`;
    try {
      const held = cards.get(key);
      if (held !== undefined && this.#room.message(held.id) !== null) {
        this.#room.edit(held, text);
      } else {
        cards.set(
          key,
          this.#room.write(this.#ref.channel, this.#ref.thread, DAEMON, text, "notice"),
        );
      }
    } catch (error) {
      if (!(error instanceof ChatError)) throw error;
    }
  }

  get loopCardLast(): boolean {
    const held = loopCards.get(this.#room)?.get(`${this.#ref.channel}/${this.#ref.thread}`);
    if (held === undefined) return false;
    return this.#room.messages(this.#ref.channel, this.#ref.thread).at(-1)?.id === held.id;
  }

  async endLoop(line: string): Promise<void> {
    loopCards.get(this.#room)?.delete(`${this.#ref.channel}/${this.#ref.thread}`);
    await this.#post(line, "notice").catch(() => {});
  }

  async close(): Promise<void> {}

  async #post(text: string, kind: MessageKind): Promise<void> {
    this.#room.write(this.#ref.channel, this.#ref.thread, DAEMON, text, kind);
  }
}

/** Rewrites a message into a notice with nothing left to press; `ChatError` for one that is not there. */
function rewritten(room: Room, id: MessageId, text: string): void {
  const message = room.message(id);
  if (message === null) throw new ChatError("message_not_found");
  room.edit(message, text);
  room.settled(id);
  message.kind = "notice";
}

class MemoryChannel implements ChannelChat {
  readonly #room: Room;
  readonly #channel: string;

  constructor(room: Room, channel: string) {
    this.#room = room;
    this.#channel = channel;
  }

  async notice(text: string): Promise<MessageId | null> {
    return this.#room.write(this.#channel, null, DAEMON, text, "notice").id;
  }

  async say(markdown: string): Promise<void> {
    this.#room.write(this.#channel, null, DAEMON, markdown, "reference");
  }

  async open(markdown: string): Promise<ThreadRef> {
    const root = this.#room.write(this.#channel, null, DAEMON, markdown, "reference", true);
    return { channel: this.#channel, thread: root.thread as string };
  }

  async offer(list: OwnerList, title: string): Promise<void> {
    const message = this.#room.write(this.#channel, null, DAEMON, title, "list");
    this.#room.addList({ message: message.id, channel: this.#channel, list, title });
  }

  async withdraw(list: MessageId): Promise<boolean> {
    this.#room.remove(list);
    return true;
  }

  async rewrite(list: MessageId, text: string): Promise<void> {
    rewritten(this.#room, list, text);
  }

  // This chat has no line for the owner alone: it is a notice of the channel.
  async tell(text: string): Promise<void> {
    this.#room.write(this.#channel, null, DAEMON, text, "notice");
  }
}

/** The chat provider over a room. */
export class MemoryProvider implements ChatProvider {
  readonly name = "Memory chat";
  readonly identities: readonly string[];
  readonly capabilities: ChatCapabilities;
  /** Present with `fileUpload`. */
  readonly fileLimit?: number;
  /** Present with `commandSuggestions`: the suggestion is a message the owner sends a text from. */
  readonly suggestCommands?: (ref: ThreadRef, suggestion: CommandSuggestion) => Promise<void>;
  readonly #room: Room;
  readonly #lists: boolean;
  readonly #files: boolean;
  readonly #folds: boolean;
  #inbound: ChatInbound | null = null;

  constructor(
    room: Room,
    identities: readonly string[],
    suggests = false,
    lists = false,
    files = false,
    fileLimit = 1 << 20,
    folds = false,
  ) {
    this.#room = room;
    this.identities = identities;
    this.#lists = lists;
    this.#files = files;
    this.#folds = folds;
    if (files) this.fileLimit = fileLimit;
    this.capabilities = {
      ...CAPABILITIES,
      commandSuggestions: suggests,
      threadLists: lists,
      messageFold: folds,
      fileUpload: files,
    };
    if (suggests) {
      this.suggestCommands = async (ref, suggestion) => {
        const lines = suggestion.candidates.map((c) => `${c.text} ${c.description}`.trim());
        const message = room.write(
          ref.channel,
          ref.thread,
          DAEMON,
          [`field: ${suggestion.typed}`, ...lines].join("\n"),
          "suggestion",
        );
        room.addSuggestion({ message: message.id, ref, suggestion });
      };
    }
  }

  thread(ref: ThreadRef): ThreadChat {
    // A thread is a name the chat gave out: the core builds none from something else (a message id).
    if (this.#room.openedAt(ref) === null) this.#room.stray(`thread ${ref.channel}/${ref.thread}`);
    return new MemoryThread(this.#room, ref, this.#lists, this.#files, this.#folds);
  }

  channel(channel: string): ChannelChat {
    return new MemoryChannel(this.#room, channel);
  }

  escape(text: string, markup: Markup): string {
    // The chat's control characters of `words`, as a chat with markup would write them.
    if (markup === "words")
      return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    return text;
  }

  channelName(channel: string, _markup: Markup): string {
    return `#${channel}`;
  }

  openedAt(ref: ThreadRef): number | null {
    return this.#room.openedAt(ref);
  }

  async channelState(channel: string): Promise<Presence> {
    if (this.#room.lookupFails()) return "no answer";
    return this.#room.knows(channel) ? "there" : "gone";
  }

  async threadState(ref: ThreadRef): Promise<Presence> {
    if (this.#room.lookupFails()) return "no answer";
    return this.#room.knowsThread(ref) ? "there" : "gone";
  }

  async start(inbound: ChatInbound): Promise<void> {
    this.#inbound = inbound;
    this.#room.attach(inbound);
  }

  async stop(): Promise<void> {
    if (this.#inbound !== null) this.#room.detach(this.#inbound);
  }

  async close(): Promise<void> {}
}
