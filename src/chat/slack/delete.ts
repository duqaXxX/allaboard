/**
 * Deleting from Slack what the Home tab's edit mode names: a session's whole thread, or what
 * sits in a channel outside every thread (the commands typed there and the bot's own messages).
 *
 * `chat.delete` with a bot token "may delete only messages posted by that bot", and with a user
 * token the messages that user can delete (docs.slack.dev/reference/methods/chat.delete, read
 * 2026-10-05). A session's thread is started by the owner, so its root and the owner's replies
 * need the owner's own user token (`SLACK_USER_TOKEN`, user scope `chat:write`): the bot's
 * messages are deleted with the bot token, every other one with the owner's. Without that token
 * there is no deleter, and the page offers no delete.
 *
 * The replies go first and the root last: the reference does not say what a root deleted under
 * its replies leaves behind. `chat.delete` is Tier 3 (50+ per minute); both clients retry a rate
 * limit after the time Slack asks for, which is what a delete's time is made of (measured
 * 2026-10-05 on a free workspace: 20 to 40 seconds a thread, with a rate limit met every few
 * calls), so threads are deleted one at a time. A delete that stops half way leaves the thread
 * in `state.json`, so asking again continues with the messages that are left. The Claude Code
 * session is not touched: its transcript stays, and `!resume` lists it again once no thread
 * holds it.
 *
 * Cleaning up a channel reads its history (`conversations.history`, Tier 3, cursor pagination,
 * read 2026-10-05) and deletes the messages that are no thread and belong to no thread: "Detect
 * a threaded message by looking for a `thread_ts` value in the message object", and a parent
 * keeps it "even if all its replies have been deleted" (docs.slack.dev/messaging/retrieving-
 * messages, read 2026-10-05). In a channel bound to a folder every message the owner sends
 * outside a thread is a prompt or a word for the daemon, so one with no reply is a leftover
 * whoever wrote it: the owner's and the bot's both go. What stays: a thread that has a reply, a
 * pinned message, a message with a `subtype` (Slack's own lines), anyone else's message, and a message
 * `state.json` holds as a thread whose first reply has not come yet. A message that carries
 * `thread_ts` is deleted only after `conversations.replies` on it, with `limit=1`, returned its
 * root with no `reply_count` (a root nobody replied to has none, measured 2026-10-01): the
 * reference does not say what a parent's count reads in the channel's history once its replies
 * are gone, and a thread taken for a leftover would lose its root.
 */

import type { WebClient } from "@slack/web-api";
import { fill, Mutex, type Names, named, type StatePort } from "../../core/port.ts";
import { getLogger } from "../../log.ts";
import { isRecord } from "../../values.ts";
import { describe } from "./reply/errors.ts";
import { isPinned, type RootMarks, rootMarks } from "./tag.ts";
import * as slackTexts from "./texts.ts";

export const logger = getLogger("allaboard.chat.slack.delete");

/** How many messages one `conversations.replies` page is asked for. */
export const PAGE = 200;
export const MESSAGE_NOT_FOUND = "message_not_found";
export const CANT_DELETE = "cant_delete_message";
export const THREAD_NOT_FOUND = "thread_not_found";

/**
 * A pinned message keeps its thread: `where` says which one is pinned, the root with a tag (which
 * `!untag` removes with the pin), the root with a pin made by hand, or a reply under a root that
 * is not pinned.
 */
export interface PinnedRefusal {
  readonly reason: "pinned";
  readonly where: "tagged-root" | "root" | "reply";
}

/**
 * Why a delete left the thread where it was: its session works or waits for the owner, a message
 * of it is pinned, Slack refused `count` of its messages, or a call failed with `error` half way.
 * Each place that offers a delete words it for itself.
 */
export type DeleteRefusal =
  | { readonly reason: "busy" }
  | PinnedRefusal
  | { readonly reason: "refused"; readonly count: number }
  | { readonly reason: "failed"; readonly error: string };

/** The line a pinned thread's delete is refused with. */
export function pinnedLine(refusal: PinnedRefusal, names: Names): string {
  switch (refusal.where) {
    case "tagged-root":
      return slackTexts.DELETE_PINNED_TAGGED;
    case "root":
      return named(slackTexts.DELETE_PINNED_BY_HAND, names);
    case "reply":
      return named(slackTexts.DELETE_PINNED_REPLY, names);
  }
}

/** Deletes a thread as `ThreadDeleter.delete` does: null once it is gone, else why it is not. */
export type DeleteThreadCall = (
  channelId: string,
  threadTs: string,
) => Promise<DeleteRefusal | null>;

/** Reads whether a message of a thread is pinned, as `ThreadDeleter.pinned` does. */
export type PinnedThreadCall = (
  channelId: string,
  threadTs: string,
) => Promise<PinnedRefusal | null>;

/**
 * What deletes a thread and what tells beforehand that it would be refused for a pin. One object,
 * so that a place which offers the delete always has the check.
 */
export interface ThreadDeletion {
  readonly delete: DeleteThreadCall;
  readonly pinned: PinnedThreadCall;
}

/** What the deleter asks of the session manager (`SessionManager.release` and `.free`). */
/** The part of the daemon's state a delete reads and writes. */
export type DeleterState = Pick<StatePort, "thread" | "channels" | "removeThread">;

export interface ThreadDeleterOptions {
  readonly botUserId: string;
  readonly ownerUserId: string;
  readonly state: DeleterState;
  /** The names the lines it shows take; asked when one is shown, which is after the core exists. */
  readonly names: () => Names;
  /**
   * Closes the thread's live session when it is idle, holds the thread so that no session is
   * built in it meanwhile, and says whether it did.
   */
  readonly release: (channelId: string, threadTs: string) => Promise<boolean>;
  /** Ends the hold. */
  readonly free: (channelId: string, threadTs: string) => void;
}

/** The messages of a `conversations.*` answer, `[]` for an answer with none. */
function messagesOf(answer: unknown): Record<string, unknown>[] {
  const messages = isRecord(answer) ? answer.messages : undefined;
  return Array.isArray(messages) ? messages.filter(isRecord) : [];
}

/** The cursor of the next page; null on the last one. */
function nextCursor(answer: unknown): string | null {
  const metadata = isRecord(answer) ? answer.response_metadata : undefined;
  const cursor = isRecord(metadata) ? metadata.next_cursor : undefined;
  return typeof cursor === "string" && cursor !== "" ? cursor : null;
}

/** A message's `ts`; a message without one is a failure. */
function tsOf(message: Record<string, unknown>): string {
  if (message.ts === undefined) throw new Error("a message without a ts");
  return String(message.ts);
}

/** A thread message as a delete reads it: its author's user id, and its tag and pin. */
interface Seen {
  readonly author: string;
  readonly marks: RootMarks;
}

/** The refusal for a pinned message among a thread's, the root's first; null for none. */
function pinnedOf(messages: ReadonlyMap<string, Seen>, threadTs: string): PinnedRefusal | null {
  const root = messages.get(threadTs);
  if (root?.marks.pinned) {
    return { reason: "pinned", where: root.marks.tag === null ? "root" : "tagged-root" };
  }
  return [...messages.values()].some((seen) => seen.marks.pinned)
    ? { reason: "pinned", where: "reply" }
    : null;
}

/** Deletes the threads the Home tab's Delete names, and cleans the channels it names. */
export class ThreadDeleter {
  readonly #bot: WebClient;
  readonly #owner: WebClient;
  readonly #botUserId: string;
  readonly #ownerUserId: string;
  readonly #state: DeleterState;
  readonly #names: () => Names;
  readonly #release: ThreadDeleterOptions["release"];
  readonly #free: ThreadDeleterOptions["free"];
  // One thread at a time: two deletes at once would share Slack's rate limit, and each would
  // use up its retries on the other's calls.
  readonly #oneAtATime = new Mutex();

  constructor(bot: WebClient, owner: WebClient, options: ThreadDeleterOptions) {
    this.#bot = bot;
    this.#owner = owner;
    this.#botUserId = options.botUserId;
    this.#ownerUserId = options.ownerUserId;
    this.#state = options.state;
    this.#names = options.names;
    this.#release = options.release;
    this.#free = options.free;
  }

  /**
   * Delete every message of a thread that holds a session and forget the thread. Returns null
   * once the thread is gone (or was not one of the daemon's), else why it is still there. Never
   * throws.
   */
  async delete(channelId: string, threadTs: string): Promise<DeleteRefusal | null> {
    if (this.#state.thread(channelId, threadTs) === null) {
      return null; // not a thread of the daemon's: nothing a click may delete
    }
    return this.#oneAtATime.run(() => this.#delete(channelId, threadTs));
  }

  async #delete(channelId: string, threadTs: string): Promise<DeleteRefusal | null> {
    if (this.#state.thread(channelId, threadTs) === null) {
      return null; // deleted while this call waited its turn
    }
    // No hold is taken before `release`, and a refused one took none: the hold on the thread is
    // then another's (a deletion of its first message being forgotten), not this call's to free.
    let notHeld = true;
    try {
      // Read before the session is released, so that a pinned thread keeps its live session.
      const pinned = pinnedOf(await this.#messages(channelId, threadTs), threadTs);
      if (pinned !== null) return pinned;
      notHeld = false;
      // From here until `free`, the thread is held: a message sent in it while its messages go
      // finds no session, and none is rebuilt from the entry `state.json` still has
      // (`SessionManager.release`).
      if (!(await this.#release(channelId, threadTs))) {
        notHeld = true;
        return { reason: "busy" };
      }
      const { refused, pinned: kept } = await this.#empty(channelId, threadTs);
      // A message pinned meanwhile stays, and so does the root: no reply is left under a deleted
      // root, and a pinned message is never deleted.
      if (kept !== null) return kept;
      if (refused > 0) {
        // The root stays while a reply does, so the thread can still be opened.
        return { reason: "refused", count: refused };
      }
      this.#state.removeThread(channelId, threadTs);
    } catch (error) {
      logger.warning(`could not delete ${channelId}/${threadTs}: ${describe(error)}`);
      return { reason: "failed", error: describe(error) };
    } finally {
      if (!notHeld) this.#free(channelId, threadTs);
    }
    logger.info(`deleted thread ${channelId}/${threadTs}`);
    return null;
  }

  /**
   * The refusal for a thread with a pinned message, the root or a reply (`rootMarks`, as the Home
   * tab reads it), else null (also for a thread that is gone). Both ways of deleting go through
   * `delete`, which asks it again at every confirmation.
   */
  async pinned(channelId: string, threadTs: string): Promise<PinnedRefusal | null> {
    return pinnedOf(await this.#messages(channelId, threadTs), threadTs);
  }

  /**
   * Delete the thread's replies, then its root. The thread is read again after each pass, so a
   * message that arrived meanwhile goes too, and the root goes only once a read shows no reply
   * left: a delete never leaves replies under a deleted root. A message pinned by then is not
   * deleted, and neither is the root: `pinned` says what the last read found. Returns how many
   * messages Slack refused to delete; the root stays when it is not zero.
   */
  async #empty(
    channelId: string,
    threadTs: string,
  ): Promise<{ refused: number; pinned: PinnedRefusal | null }> {
    const handled = new Set<string>();
    const refused = new Set<string>();
    const kept = new Set<string>();
    let messages: Map<string, Seen>;
    for (;;) {
      messages = await this.#messages(channelId, threadTs);
      const replies = [...messages].filter(([ts]) => ts !== threadTs && !handled.has(ts));
      if (replies.length === 0) break;
      for (const [ts, seen] of replies) {
        handled.add(ts);
        if (seen.marks.pinned) {
          kept.add(ts); // the owner keeps it
          continue;
        }
        if (!(await this.#remove(channelId, ts, seen.author))) refused.add(ts);
      }
    }
    // A reply skipped as pinned is still there even if a later read shows it unpinned: the root
    // stays above it.
    const pinned =
      pinnedOf(messages, threadTs) ??
      (kept.size > 0 ? { reason: "pinned", where: "reply" as const } : null);
    const root = refused.size > 0 || pinned !== null ? undefined : messages.get(threadTs);
    if (root !== undefined && !(await this.#remove(channelId, threadTs, root.author))) {
      refused.add(threadTs);
    }
    return { refused: refused.size, pinned };
  }

  /**
   * Delete one message with its author's token; anyone else's is tried with the owner's, which
   * deletes what the owner may delete in Slack. False when Slack refuses this very message
   * (`cant_delete_message`): the caller goes on and counts it. A message already gone is
   * deleted; any other failure throws.
   */
  async #remove(channelId: string, ts: string, author: string): Promise<boolean> {
    const client = author === this.#botUserId ? this.#bot : this.#owner;
    try {
      await client.chat.delete({ channel: channelId, ts });
    } catch (error) {
      if (describe(error) === CANT_DELETE) return false;
      if (describe(error) !== MESSAGE_NOT_FOUND) throw error;
    }
    return true;
  }

  /**
   * Delete what sits in a bound channel outside every thread: the owner's messages and the
   * bot's that have no reply. Returns null when done (or for a channel that is not bound), else
   * the line that says why it stopped. Never throws.
   */
  async clean(channelId: string): Promise<string | null> {
    if (!this.#state.channels().includes(channelId)) {
      return null; // not a channel of the daemon's: nothing a click may clean
    }
    return this.#oneAtATime.run(async () => {
      let loose = new Map<string, string>();
      let refused = 0;
      try {
        loose = await this.#loose(channelId);
        for (const [ts, author] of loose) {
          if (!(await this.#remove(channelId, ts, author))) refused += 1;
        }
      } catch (error) {
        logger.warning(`could not clean up ${channelId}: ${describe(error)}`);
        return fill(slackTexts.HOME_CLEAN_FAILED, { error: describe(error) });
      }
      logger.info(`cleaned up ${channelId}: ${loose.size} messages, ${refused} refused`);
      return refused > 0
        ? fill(named(slackTexts.HOME_CLEAN_REFUSED, this.#names()), { count: refused })
        : null;
    });
  }

  /** The channel's messages a clean-up deletes, `ts` to author, read page by page. */
  async #loose(channelId: string): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    let cursor: string | null = null;
    for (;;) {
      const page: unknown = await this.#bot.conversations.history({
        channel: channelId,
        limit: PAGE,
        ...(cursor === null ? {} : { cursor }),
      });
      for (const message of messagesOf(page)) {
        const ts = tsOf(message);
        const author = String(message.user || "");
        const threaded = message.thread_ts;
        if (message.subtype || (threaded && String(threaded) !== ts)) {
          continue; // Slack's own line; or a thread's reply shown in the channel
        }
        if (author !== this.#botUserId && author !== this.#ownerUserId) continue;
        if (this.#state.thread(channelId, ts) !== null) {
          continue; // a thread of the daemon's with no reply yet
        }
        // The history carries `pinned_to` as `conversations.replies` does (measured 2026-10-20 on
        // a free workspace: a hand-pinned `!help` outside a thread stayed through a clean-up).
        if (isPinned(message)) continue; // the owner keeps it
        if (threaded && (await this.#hasReplies(channelId, ts))) continue; // a thread
        found.set(ts, author);
      }
      cursor = nextCursor(page);
      if (cursor === null) return found;
    }
  }

  /**
   * Whether a message that carries `thread_ts` still has a reply, asked of the thread itself.
   * True as well for one that is gone meanwhile: there is nothing to delete.
   */
  async #hasReplies(channelId: string, ts: string): Promise<boolean> {
    let answer: unknown;
    try {
      answer = await this.#bot.conversations.replies({ channel: channelId, ts, limit: 1 });
    } catch (error) {
      if (describe(error) === THREAD_NOT_FOUND) return true;
      throw error;
    }
    const messages = messagesOf(answer);
    const root = messages.find((message) => String(message.ts) === ts);
    // No root in the answer is no proof of an empty thread: keep the message.
    return root === undefined || Boolean(root.reply_count) || messages.length > 1;
  }

  /**
   * Every message of the thread, its `ts` to what is read of it, page by page (cursor
   * pagination, `response_metadata.next_cursor`). Empty when the root is gone.
   */
  async #messages(channelId: string, threadTs: string): Promise<Map<string, Seen>> {
    const found = new Map<string, Seen>();
    let cursor: string | null = null;
    for (;;) {
      let page: unknown;
      try {
        page = await this.#bot.conversations.replies({
          channel: channelId,
          ts: threadTs,
          limit: PAGE,
          ...(cursor === null ? {} : { cursor }),
        });
      } catch (error) {
        if (describe(error) === THREAD_NOT_FOUND) return found;
        throw error;
      }
      for (const message of messagesOf(page)) {
        found.set(tsOf(message), { author: String(message.user || ""), marks: rootMarks(message) });
      }
      cursor = nextCursor(page);
      if (cursor === null) return found;
    }
  }
}
