/**
 * One line of the bot's at the bottom of a project channel, `Status: ` and one thread with the
 * word of its status, so the channel shows as unread in the sidebar. Slack marks a channel unread
 * only for a top-level message of someone else's: a reply in a thread, a mention or a reaction
 * there, an edit and the owner's own messages leave it as read (measured on a dev app on
 * 2026-10-22, iOS and desktop). Each time a session's work ends, done or failed (a `notify`
 * status), and each time the agent asks the owner for an approval or an answer, the bot posts a
 * new line and deletes the one before, so the channel holds one line of the bot's at most and
 * opens at the bottom, on that line.
 *
 * Only a wait names a thread among several, since only a wait asks something of the owner:
 * while a thread of the channel waits for his answer to an approval or a question, the line names
 * the one that has waited longest and counts the others (`+2`), whatever the event that posted
 * it. Else, while threads work, it counts them (`Working: 2 threads`); else it names the thread
 * whose work ended last. Between its posts the line follows the threads' status in `state.json`
 * (`refresh`), by edits, which ring nothing (measured 2026-09-27).
 *
 * The line is a context block, small and grey, and mentions nobody: it makes the channel unread,
 * and the thread itself tells the owner (`SlackThread.ask`, `SlackThread.tellEnd`), since a push
 * from the channel opens the channel and one from the thread opens the thread (measured
 * 2026-10-26, iOS). A context block alone never pushed with a mention in `text` (2026-10-25); a
 * block that does draws its emoji larger than its words (2026-10-26).
 *
 * The line is found again by its message metadata (`LINE_EVENT`), which `conversations.history`
 * returns for the app's own messages (measured the same day): `state.json` keeps nothing of it.
 * Its payload names the thread it shows, so the first refresh after a start takes over the line
 * an earlier run left; the first post in a channel after a start deletes every other line found
 * among the channel's latest messages (`HISTORY_LIMIT`).
 *
 * The line reads a root when it names it, and the session's title may reach the root after that.
 * The text each title edit leaves on a root is passed on (`retitle`), and the line is edited when
 * it names that root.
 */

import type { WebClient } from "@slack/web-api";
import { asksOwner, type RequestKind } from "../../core/port.ts";
import { getLogger, type Logger } from "../../log.ts";
import { slackUnescape } from "./app/messages.ts";
import { isTombstone } from "./channels.ts";
import { threadFacts } from "./home.ts";
import { describe, gone } from "./reply/errors.ts";
import { mrkdwnEscape } from "./reply/escape.ts";
import { stripMarkdown } from "./reply/markdown.ts";
import { retaggedText } from "./tag.ts";

export const logger = getLogger("allaboard.chat.slack.channel_line");

/** The metadata event type that marks a message as the channel's line. */
export const LINE_EVENT = "allaboard_channel_line";
/** How many of the channel's latest messages are read for a line an earlier run left. */
export const HISTORY_LIMIT = 100;
/**
 * How many characters of the thread's first line name it: at 80 the line wrapped over three rows
 * on desktop (seen 2026-10-26), at 40 it keeps one beside `Status:` and its count.
 */
export const LABEL_LIMIT = 40;
// What names a thread whose root has no words.
const NO_LABEL = "a thread";

type Message = Readonly<Record<string, unknown>>;

/** The thread's root as one short line of plain words: its title, or its first words. */
export function lineLabel(root: Message | undefined): string {
  const text = typeof root?.text === "string" ? root.text : "";
  const words = stripMarkdown(slackUnescape(retaggedText(text, null)))
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  if (words === undefined) return NO_LABEL;
  // By code point, so no character is cut in half.
  const chars = Array.from(words);
  return chars.length > LABEL_LIMIT ? `${chars.slice(0, LABEL_LIMIT - 1).join("")}…` : words;
}

/**
 * What the line says of the thread it names: its work is done or failed, it waits for the owner,
 * or it goes on: the root's status.
 */
export type LineKind = "done" | "failed" | "waiting" | "working";

/**
 * The word of a root whose status in `state.json` is `status` (working or waiting, while the work
 * goes on) and `ended` (done or error, once it ended); null for a root with neither. The end
 * first, as the session index reads the same two: an error kept beside a pending status is what
 * the root shows (an answer that never reached the chat).
 */
export function rootKind(status: string | null, ended: string | null): LineKind | null {
  if (ended === "error") return "failed";
  if (ended === "done") return "done";
  return status === "waiting" || status === "working" ? status : null;
}

/**
 * A thread of a channel as the line reads it: its root's `ts`, the word of its status, and
 * whether it waits for the owner's answer to the agent (`asks`).
 */
export interface LineThread {
  readonly thread: string;
  readonly kind: LineKind | null;
  readonly asks: boolean;
}

/**
 * The thread whose root is `thread` as the line reads its entry of `state.json`: it asks the
 * owner while its root waits with an approval or a question open (`asksOwner`). A root that waits
 * on a request the owner just set off (the setup form, the hold, a shell command's confirmation)
 * is taken for working: he is there.
 */
export function lineThread(
  thread: string,
  entry: {
    readonly status: string | null;
    readonly ended: string | null;
    readonly requestKinds: Readonly<Record<string, RequestKind>>;
  },
): LineThread {
  const kind = rootKind(entry.status, entry.ended);
  const asks = kind === "waiting" && Object.values(entry.requestKinds).some(asksOwner);
  return { thread, kind: kind === "waiting" && !asks ? "working" : kind, asks };
}

/** Where the line reads the channels' threads: `state.json`, as the session index does. */
export interface LineThreads {
  channels(): readonly string[];
  of(channel: string): readonly LineThread[];
}

// Each kind's word, and its mark: the one the root's reaction shows for the same state.
const WORDS: Readonly<Record<LineKind, readonly [string, string]>> = {
  done: ["✅", "Done"],
  failed: ["❌", "Failed"],
  waiting: ["✋", "Waiting"],
  working: ["⏳", "Working"],
};

const PREFIX = "Status:";

/** What the line this run posted, or took over from an earlier run, in a channel shows. */
interface Line {
  readonly ts: string;
  // The thread the line names, its word, the message of the thread its link opens and that link.
  root: string;
  kind: LineKind;
  opened: string;
  permalink: string;
  label: string;
  // Waiting: how many other threads of the channel wait for the owner. Working: how many threads
  // work, the line naming none of them.
  count: number;
  // The content last written, so a change that leaves it the same writes nothing.
  shown: string;
}

/**
 * What a post tells the owner of, for the push's words: the thread of the event, its word, and
 * how many other threads wait.
 */
interface Told {
  readonly kind: LineKind;
  readonly label: string;
  readonly waiting: number;
}

/**
 * The line's text and blocks: `Status:` and, working, how many threads work; otherwise the thread
 * at `permalink` by `label` with the word of `kind`, waiting with the count of the others that
 * wait. `told`, on a post, gives `text` the words of the event itself. A label is a root's words,
 * which may hold a mention sequence: escaped in `text` and in mrkdwn, where one would notify.
 */
function lineContent(line: Omit<Line, "ts" | "shown">, told?: Told) {
  const [mark, word] = WORDS[line.kind];
  const plus = (n: number) => (n > 0 ? ` · +${n}` : "");
  const threads = `${line.count} ${line.count === 1 ? "thread" : "threads"}`;
  const event = told ?? { kind: line.kind, label: line.label, waiting: line.count };
  const said =
    !told && line.kind === "working"
      ? `${PREFIX} ${word}: ${threads}`
      : `${PREFIX} ${WORDS[event.kind][1]}: ${mrkdwnEscape(event.label)}${plus(event.kind === "working" ? 0 : event.waiting)}`;
  // A reply's permalink carries a query (`?thread_ts=…&cid=…`), and mrkdwn reads `&` as markup.
  const shown =
    line.kind === "working"
      ? `${PREFIX} ${mark} ${word}: ${threads}`
      : `${PREFIX} ${mark} ${word}: <${mrkdwnEscape(line.permalink)}|${mrkdwnEscape(line.label)}>${plus(line.count)}`;
  return {
    text: said,
    blocks: [{ type: "context", elements: [{ type: "mrkdwn", text: shown }] }],
  };
}

export interface ChannelLineOptions {
  /** The daemon's own bot: only its messages are taken for a line. */
  readonly botUserId: string;
  /** The threads of each channel; absent, the line counts no other thread and follows none. */
  readonly threads?: LineThreads;
  readonly logger?: Logger;
}

export class ChannelLine {
  readonly #slack: WebClient;
  readonly #botUserId: string;
  readonly #threads: LineThreads | undefined;
  readonly #log: Logger;
  // Per channel: the line this run posted or took over, and the older lines a delete failed
  // for, tried again at the next change.
  readonly #posted = new Map<string, Line>();
  readonly #left = new Map<string, string[]>();
  // The channels whose history was read for a line an earlier run left.
  readonly #looked = new Set<string>();
  // Per thread (`channel/root`): its label, its root's permalink, and the roots Slack has no more
  // of (deleted, or left as a tombstone over its replies).
  readonly #labels = new Map<string, string>();
  readonly #roots = new Map<string, string>();
  readonly #gone = new Set<string>();
  // Per channel, the change in flight: the next one waits for it.
  readonly #chain = new Map<string, Promise<void>>();

  constructor(slack: WebClient, options: ChannelLineOptions) {
    this.#slack = slack;
    this.#botUserId = options.botUserId;
    this.#threads = options.threads;
    this.#log = options.logger ?? logger;
  }

  /**
   * Post the channel's line at the bottom for an event of the thread whose root is `rootTs`, of
   * the word `kind`. The line names the
   * thread that has waited longest for the owner when one does, this one included when it asks,
   * else this one, its link opening it on the message `opened`, or on its last reply. Never
   * rejects: a failure is logged by its code and the reply goes on.
   */
  show(channel: string, rootTs: string, kind: LineKind, opened?: string): Promise<void> {
    return this.#queue(channel, () => this.#show(channel, rootTs, kind, opened), "move");
  }

  /**
   * The threads of `changed` (every channel's, with none given) are no longer as the line shows
   * them: each is read again, and each line is edited to the threads' status, which pushes
   * nothing. A line whose thread is gone, with nothing waiting, is deleted. Lines an earlier run
   * left are taken over. Queued behind the line's moves. Never rejects.
   */
  refresh(
    changed?: Iterable<{ readonly channel: string; readonly thread: string }>,
  ): Promise<void> {
    const threads = this.#threads;
    if (threads === undefined) return Promise.resolve();
    const refs = changed === undefined ? undefined : [...changed];
    const channels =
      refs === undefined ? threads.channels() : [...new Set(refs.map((ref) => ref.channel))];
    return Promise.all(
      channels.map((channel) =>
        this.#queue(
          channel,
          () => {
            // A changed thread's root is read again, it may have been deleted: in the queue, so
            // a post in flight cannot write back what it read before the change.
            for (const ref of refs ?? []) {
              if (ref.channel === channel) this.#labels.delete(`${channel}/${ref.thread}`);
            }
            return this.#sync(channel);
          },
          "update",
        ),
      ),
    ).then(() => {});
  }

  /**
   * Links the thread's root instead when the line opens the message `messageTs` of the thread
   * `rootTs`, which was just deleted: Slack answers a deleted message's link with "unable to open
   * this link". Its word stays. Queued behind the line's moves. Never rejects.
   */
  withdrawn(channel: string, rootTs: string, messageTs: string): Promise<void> {
    return this.#queue(channel, () => this.#withdrawn(channel, rootTs, messageTs), "relink");
  }

  async #withdrawn(channel: string, rootTs: string, messageTs: string): Promise<void> {
    const line = this.#posted.get(channel);
    if (line === undefined || line.root !== rootTs || line.opened !== messageTs) return;
    await this.#apply(channel, line, {
      opened: rootTs,
      permalink: await this.#rootLink(channel, rootTs),
    });
  }

  /** Runs `work` after the channel's change in flight; a failure is logged as one to `verb`. */
  #queue(channel: string, work: () => Promise<void>, verb: string): Promise<void> {
    const before = this.#chain.get(channel) ?? Promise.resolve();
    const next = before.then(async () => {
      try {
        await work();
      } catch (error) {
        this.#log.warning(`could not ${verb} the line of ${channel}: ${describe(error)}`);
      }
    });
    this.#chain.set(channel, next);
    return next;
  }

  /**
   * Names the thread whose root is `rootTs` by `text`, the root's text once its title was
   * written, when the line names that thread. Queued behind the line's moves, so a line being
   * posted with the root's earlier words is edited once it is there. Never rejects.
   */
  retitle(channel: string, rootTs: string, text: string): Promise<void> {
    return this.#queue(channel, () => this.#retitle(channel, rootTs, text), "rename");
  }

  async #retitle(channel: string, rootTs: string, text: string): Promise<void> {
    const label = lineLabel({ text });
    this.#labels.set(`${channel}/${rootTs}`, label);
    const line = this.#posted.get(channel);
    if (line !== undefined && line.root === rootTs) await this.#apply(channel, line, { label });
  }

  /** The line of `channel` brought to its threads' status in `state.json`. */
  async #sync(channel: string): Promise<void> {
    const line = this.#posted.get(channel) ?? (await this.#adopt(channel));
    const threads = this.#threads;
    if (line === undefined || threads === undefined) return;
    const all = threads.of(channel);
    this.#forget(channel, all);
    const waiting = await this.#waiting(channel, all, null);
    const first = waiting[0];
    if (first !== undefined) {
      // A waiting line keeps the request it opens until that request is deleted (`withdrawn`).
      const same = first === line.root && line.kind === "waiting";
      await this.#apply(channel, line, {
        root: first,
        kind: "waiting",
        opened: same ? line.opened : first,
        permalink: same ? line.permalink : await this.#rootLink(channel, first),
        label: await this.#label(channel, first),
        count: waiting.length - 1,
      });
      return;
    }
    // Leaving a wait, the line opens its thread's root: the request it opened is answered.
    const relink =
      line.kind === "waiting"
        ? { opened: line.root, permalink: await this.#rootLink(channel, line.root) }
        : {};
    const working = all.filter((t) => t.kind === "working").length;
    if (working > 0) {
      // Several may work: the line names none, and keeps its thread for when they are done.
      await this.#apply(channel, line, { kind: "working", count: working, ...relink });
      return;
    }
    const own = all.find((t) => t.thread === line.root);
    if (own === undefined || (await this.#read(channel, line.root)) === GONE) {
      // Its thread is gone (deleted, or pruned), and none waits.
      await this.#remove(channel, line);
      return;
    }
    if (own.kind === null) {
      // A root with no status any more (a hold cancelled before any turn): nothing to tell.
      await this.#remove(channel, line);
      return;
    }
    await this.#apply(channel, line, { kind: own.kind, count: 0, ...relink });
  }

  /**
   * The line an earlier run left in `channel`, the newest found among its latest messages, taken
   * over once per run when it says which thread it names; a line of a version that did not stays
   * as it is until the next is posted.
   */
  async #adopt(channel: string): Promise<Line | undefined> {
    if (this.#looked.has(channel)) return undefined;
    const history = await this.#slack.conversations.history({ channel, limit: HISTORY_LIMIT });
    // Only once read: a refused read is tried again at the next change.
    this.#looked.add(channel);
    const lines = (history.messages ?? []).filter((message) => this.#isLine(message));
    const found = lines[0];
    // The older lines go with the next post, as the ones a delete failed for.
    this.#left.set(channel, [
      ...(this.#left.get(channel) ?? []),
      ...lines.slice(1).map((message) => String(message.ts)),
    ]);
    const payload = (found as { metadata?: { event_payload?: Record<string, unknown> } })?.metadata
      ?.event_payload;
    const root = payload?.root;
    const kind = payload?.kind;
    if (found === undefined || typeof root !== "string" || typeof kind !== "string") return;
    if (!(kind in WORDS)) return undefined;
    const line: Line = {
      ts: String(found.ts),
      root,
      kind: kind as LineKind,
      opened: root,
      permalink: await this.#rootLink(channel, root),
      label: await this.#label(channel, root),
      count: 0,
      shown: "",
    };
    this.#posted.set(channel, line);
    return line;
  }

  /**
   * Writes `change` into the line `line` when it changes what the line shows; an edit pushes
   * nothing (measured 2026-09-27). A line deleted by hand
   * is forgotten: the next one is posted as usual.
   */
  async #apply(channel: string, line: Line, change: Partial<Omit<Line, "ts">>): Promise<void> {
    const next = { ...line, ...change };
    const content = lineContent(next);
    const shown = JSON.stringify(content.blocks);
    if (shown !== line.shown) {
      try {
        // With no `metadata` the edit keeps the line's own, which finds it after a start ("the
        // message's previous metadata will be retained", docs.slack.dev chat.update, read
        // 2026-10-22). The thread it names may change: the payload is written again.
        await this.#slack.chat.update({
          channel,
          ts: line.ts,
          ...content,
          ...(next.root !== line.root || next.kind !== line.kind
            ? { metadata: lineMetadata(next) }
            : {}),
        });
      } catch (error) {
        if (gone(error)) {
          this.#posted.delete(channel);
          return;
        }
        throw error;
      }
    }
    Object.assign(line, change, { shown });
  }

  /** Deletes the line `line`, which names no thread any more. */
  async #remove(channel: string, line: Line): Promise<void> {
    try {
      await this.#slack.chat.delete({ channel, ts: line.ts });
    } catch (error) {
      if (!gone(error)) throw error;
    }
    this.#posted.delete(channel);
  }

  /** Drops what is known of the threads of `channel` that are no longer among `threads`. */
  #forget(channel: string, threads: readonly LineThread[]): void {
    const kept = new Set(threads.map((t) => `${channel}/${t.thread}`));
    for (const cache of [this.#labels, this.#roots, this.#gone]) {
      for (const key of cache.keys()) {
        if (key.startsWith(`${channel}/`) && !kept.has(key)) cache.delete(key);
      }
    }
  }

  /**
   * The roots of `threads` that wait for the owner's answer, `asking` too when given (a thread
   * whose request is being posted, before `state.json` holds its kind), oldest first; a root
   * Slack has no more of is left out, one it did not answer for this time is kept.
   */
  async #waiting(
    channel: string,
    threads: readonly LineThread[],
    asking: string | null,
  ): Promise<string[]> {
    const roots = new Set(threads.filter((t) => t.asks).map((t) => t.thread));
    if (asking !== null) roots.add(asking);
    const sorted = [...roots].sort((a, b) => Number(a) - Number(b));
    const read = await Promise.all(sorted.map((root) => this.#read(channel, root)));
    return sorted.filter((_, i) => read[i] !== GONE);
  }

  /**
   * The label of the root `rootTs`, read from Slack once; `GONE` for a root Slack no longer has
   * (`thread_not_found`, or the tombstone it leaves over the replies of a deleted root, measured
   * 2026-10-20); undefined, logged, when Slack did not answer.
   */
  async #read(channel: string, rootTs: string): Promise<string | typeof GONE | undefined> {
    const key = `${channel}/${rootTs}`;
    if (this.#gone.has(key)) return GONE;
    const known = this.#labels.get(key);
    if (known !== undefined) return known;
    const root = await this.#fetch(channel, rootTs);
    return root === GONE || root === undefined ? root : lineLabel(root);
  }

  /**
   * The root `rootTs` as Slack has it now, its label kept for `#read`; `GONE` and undefined as
   * there.
   */
  async #fetch(channel: string, rootTs: string): Promise<Message | typeof GONE | undefined> {
    const key = `${channel}/${rootTs}`;
    try {
      const replies = await this.#slack.conversations.replies({ channel, ts: rootTs, limit: 1 });
      const root = replies.messages?.[0] as Message | undefined;
      if (root === undefined || isTombstone(root)) {
        this.#gone.add(key);
        return GONE;
      }
      this.#labels.set(key, lineLabel(root));
      return root;
    } catch (error) {
      if (describe(error) === "thread_not_found") {
        this.#gone.add(key);
        return GONE;
      }
      this.#log.warning(`could not read a thread of ${channel}: ${describe(error)}`);
      return undefined;
    }
  }

  /** The label of the root `rootTs`; the words of a root with none when Slack did not say. */
  async #label(channel: string, rootTs: string): Promise<string> {
    const read = await this.#read(channel, rootTs);
    return read === undefined || read === GONE ? NO_LABEL : read;
  }

  /** The permalink of the root `rootTs`, asked of Slack once: it never changes. */
  async #rootLink(channel: string, rootTs: string): Promise<string> {
    const key = `${channel}/${rootTs}`;
    const known = this.#roots.get(key);
    if (known !== undefined) return known;
    const link = await this.#permalink(channel, rootTs, rootTs);
    this.#roots.set(key, link);
    return link;
  }

  async #show(
    channel: string,
    rootTs: string,
    kind: LineKind,
    message: string | undefined,
  ): Promise<void> {
    const root = await this.#fetch(channel, rootTs);
    const all = this.#threads?.of(channel) ?? [];
    const waiting = await this.#waiting(channel, all, kind === "waiting" ? rootTs : null);
    // A root Slack has no more of names nothing; the threads that wait still do.
    if (root === GONE && waiting.length === 0) return;
    const label = root === GONE || root === undefined ? NO_LABEL : lineLabel(root);
    const own = async (): Promise<
      Pick<Line, "root" | "kind" | "opened" | "permalink" | "label">
    > => {
      // Else the thread's last reply, which Slack opens the thread on, as the Home tab's Open
      // does; its root while it has none, or when Slack did not answer.
      const facts = root !== GONE && root !== undefined ? threadFacts(root).latestTs : null;
      const opened = message ?? facts ?? rootTs;
      return {
        root: rootTs,
        kind,
        opened,
        permalink: await this.#permalink(channel, opened, rootTs),
        label,
      };
    };
    const first = waiting[0];
    let named: Pick<Line, "root" | "kind" | "opened" | "permalink" | "label">;
    if (first !== undefined && first !== rootTs) {
      try {
        named = {
          root: first,
          kind: "waiting",
          opened: first,
          permalink: await this.#rootLink(channel, first),
          label: await this.#label(channel, first),
        };
      } catch (error) {
        // The event is told whatever another thread's link costs.
        if (root === GONE) throw error;
        this.#log.warning(`could not name a waiting thread of ${channel}: ${describe(error)}`);
        named = await own();
      }
    } else {
      named = await own();
    }
    // Nothing waits: an end while other threads work counts them, naming none.
    const working = (this.#threads?.of(channel) ?? []).filter(
      (t) => t.kind === "working" && t.thread !== rootTs,
    ).length;
    const counted =
      waiting.length === 0 && working > 0
        ? { kind: "working" as const, count: working }
        : { count: waiting.filter((t) => t !== named.root).length };
    const shownLine = { ...named, ...counted };
    const content = lineContent(shownLine, {
      kind,
      label,
      waiting: waiting.filter((t) => t !== rootTs).length,
    });
    const posted = await this.#slack.chat.postMessage({
      channel,
      ...content,
      metadata: lineMetadata(shownLine),
      unfurl_links: false,
      unfurl_media: false,
    });
    const ts = String(posted.ts);
    this.#looked.add(channel);
    const known = this.#posted.get(channel);
    const old = [
      ...(this.#left.get(channel) ?? []),
      ...(known !== undefined ? [known.ts] : await this.#earlier(channel, ts)),
    ];
    this.#posted.set(channel, { ts, ...shownLine, shown: JSON.stringify(content.blocks) });
    // Deleted only once the new line is there: the channel never goes without one.
    const left: string[] = [];
    for (const line of new Set(old)) {
      try {
        await this.#slack.chat.delete({ channel, ts: line });
      } catch (error) {
        if (gone(error)) continue;
        left.push(line);
        this.#log.warning(`could not delete an old line of ${channel}: ${describe(error)}`);
      }
    }
    this.#left.set(channel, left);
  }

  /** The permalink of `messageTs`, or of the root `rootTs` when Slack no longer has that reply. */
  async #permalink(channel: string, messageTs: string, rootTs: string): Promise<string> {
    try {
      return String(
        (await this.#slack.chat.getPermalink({ channel, message_ts: messageTs })).permalink,
      );
    } catch (error) {
      if (messageTs === rootTs || !gone(error)) throw error;
      return String(
        (await this.#slack.chat.getPermalink({ channel, message_ts: rootTs })).permalink,
      );
    }
  }

  /** Whether `message` is a line of this bot's. */
  #isLine(message: unknown): boolean {
    const { user, metadata } = message as { user?: unknown; metadata?: { event_type?: unknown } };
    return user === this.#botUserId && metadata?.event_type === LINE_EVENT;
  }

  /** The lines an earlier run left among the channel's latest messages, `except` aside. */
  async #earlier(channel: string, except: string): Promise<string[]> {
    const history = await this.#slack.conversations.history({ channel, limit: HISTORY_LIMIT });
    return (history.messages ?? [])
      .filter((message) => this.#isLine(message) && message.ts !== except)
      .map((message) => String(message.ts));
  }
}

// What `#read` answers for a root Slack has no more of.
const GONE = Symbol("gone");

/**
 * The line's metadata: its event type, which finds it after a start, and the thread it names
 * with its word, which let the next run take it over (`ChannelLine.refresh`). Ids
 * only, no message content.
 */
function lineMetadata(line: Pick<Line, "root" | "kind">) {
  return {
    event_type: LINE_EVENT,
    event_payload: {
      root: line.root,
      kind: line.kind,
    },
  };
}
