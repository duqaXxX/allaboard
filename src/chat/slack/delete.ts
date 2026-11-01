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
 * in `state.json`, so asking again continues with the messages that are left. The thread is read
 * once more after its root went, and it is called deleted only if that read shows nothing left: a
 * delete of dozens of threads reported some gone while messages stayed (#148). The Claude Code
 * session is not touched: its transcript stays, and `!resume` lists it again once no thread
 * holds it.
 *
 * Purging a channel (`!clean-channel`) deletes its threads one by one as above, those `state.json`
 * no longer holds included, then cleans it up. A thread someone else started, whose root is neither
 * the owner's nor the bot's, stays; a tombstone's thread goes, since nobody's root is left.
 *
 * Cleaning up a channel reads its history (`conversations.history`, Tier 3, cursor pagination,
 * read 2026-10-05) and deletes the messages that are no thread and belong to no thread: "Detect
 * a threaded message by looking for a `thread_ts` value in the message object", and a parent
 * keeps it "even if all its replies have been deleted" (docs.slack.dev/messaging/retrieving-
 * messages, read 2026-10-05). In a channel bound to a folder every message the owner sends
 * outside a thread is a prompt or a word for the daemon, so one with no reply is a leftover
 * whoever wrote it: the owner's and the bot's both go. What stays: a thread that has a reply, a
 * pinned message, a message with any other `subtype`, anyone else's message, and a message
 * `state.json` holds as a thread whose first reply has not come yet. Slack's notices of the channel (a rename, a join: `channel_*` and `group_*`, the message event's
 * subtypes, read 2026-11-01) are tried with the owner's token whoever they name; the reference does
 * not say whether a user can delete them, so any refusal of one is counted and logged with Slack's code. A message that carries
 * `thread_ts` is deleted only after `conversations.replies` on it, with `limit=1`, returned its
 * root with no `reply_count` (a root nobody replied to has none, measured 2026-10-01): the
 * reference does not say what a parent's count reads in the channel's history once its replies
 * are gone, and a thread taken for a leftover would lose its root.
 */

import { WebAPIPlatformError, type WebClient } from "@slack/web-api";
import { fill, Mutex, type Names, named, type StatePort } from "../../core/port.ts";
import { getLogger } from "../../log.ts";
import { isRecord } from "../../values.ts";
import { isTombstone } from "./channels.ts";
import { describe } from "./reply/errors.ts";
import { isPinned, type RootMarks, rootMarks } from "./tag.ts";
import * as slackTexts from "./texts.ts";

export const logger = getLogger("allaboard.chat.slack.delete");

/** How many messages one `conversations.replies` page is asked for. */
export const PAGE = 200;
export const MESSAGE_NOT_FOUND = "message_not_found";
export const CANT_DELETE = "cant_delete_message";
export const THREAD_NOT_FOUND = "thread_not_found";
/** The subtype of a prompt the owner sent with a file: a root like any other. */
const FILE_SHARE = "file_share";
/** The subtypes of Slack's notices about a channel. */
const CHANNEL_NOTICE = /^(channel|group)_/;
/** What says the token, the channel or Slack itself is the problem: no refusal of one notice. */
const NOT_A_REFUSAL: ReadonlySet<string> = new Set([
  "channel_not_found",
  "fatal_error",
  "internal_error",
  "invalid_auth",
  "no_permission",
  "not_authed",
  "service_unavailable",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "missing_scope",
]);

/**
 * A pinned message keeps its thread: `where` says which one is pinned, the root or a reply under
 * a root that is not pinned.
 */
export interface PinnedRefusal {
  readonly reason: "pinned";
  readonly where: "root" | "reply";
}

/**
 * Why a delete left the thread where it was: its session works or waits for the owner, a message
 * of it is pinned, Slack refused `count` of its messages, `count` of them were still there once the
 * delete had done all it could, or a call failed with `error` half way.
 * Each place that offers a delete words it for itself.
 */
export type DeleteRefusal =
  | { readonly reason: "busy" }
  | PinnedRefusal
  | { readonly reason: "refused"; readonly count: number }
  | { readonly reason: "left"; readonly count: number }
  | { readonly reason: "failed"; readonly error: string };

/** The line a pinned thread's delete is refused with. */
export function pinnedLine(refusal: PinnedRefusal, names: Names): string {
  switch (refusal.where) {
    case "root":
      return named(slackTexts.DELETE_PINNED_ROOT, names);
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
  /** What `purge` would take and keep, as `ThreadDeleter.survey` reads it. */
  readonly survey: (channelId: string) => Promise<ChannelSurvey>;
  /** Empties a channel, as `ThreadDeleter.purge` does: the line that says how it went. */
  readonly purge: (channelId: string) => Promise<string | null>;
}

/** What the deleter asks of the session manager (`SessionManager.release` and `.free`). */
/** The threads a channel's purge would delete, and those it would keep and why. */
export interface ChannelSurvey {
  readonly threads: number;
  readonly busy: number;
  readonly pinned: number;
}

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

/** A message a clean-up deletes: its author, and the subtype of a notice of Slack's. */
interface Loose {
  readonly author: string;
  readonly notice: string | null;
}

/** A thread message as a delete reads it: its author's user id, and its tag and pin. */
interface Seen {
  readonly author: string;
  readonly marks: RootMarks;
  /** The root of a thread that lost it while replies remain: Slack's, not a message to delete. */
  readonly tombstone: boolean;
}

/** The refusal for a pinned message among a thread's, the root's first; null for none. */
function pinnedOf(messages: ReadonlyMap<string, Seen>, threadTs: string): PinnedRefusal | null {
  const root = messages.get(threadTs);
  if (root?.marks.pinned) {
    return { reason: "pinned", where: "root" };
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
    return this.#oneAtATime.run(() => {
      if (this.#state.thread(channelId, threadTs) === null) {
        return Promise.resolve(null); // deleted while this call waited its turn
      }
      return this.#delete(channelId, threadTs);
    });
  }

  async #delete(channelId: string, threadTs: string): Promise<DeleteRefusal | null> {
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
      const { refused, pinned: kept, left } = await this.#empty(channelId, threadTs);
      // A message pinned meanwhile stays, and so does the root: no reply is left under a deleted
      // root, and a pinned message is never deleted.
      if (kept !== null) return kept;
      if (refused > 0) {
        // The root stays while a reply does, so the thread can still be opened.
        return { reason: "refused", count: refused };
      }
      if (left > 0) {
        logger.warning(`deleted ${channelId}/${threadTs}, yet ${left} messages are still there`);
        return { reason: "left", count: left };
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
   * Delete the thread's replies, then its root, then read what is left. The thread is read again
   * after each pass, so a message that arrived meanwhile goes too. The root goes only once a read
   * shows no reply: while one is shown, whether pinned, refused or deleted with Slack still showing
   * it, the root stays, so that the thread can be opened and listed and the delete asked again. A
   * root gone with a reply under it (a tombstone) is forgotten by the cleanup. Returns how many
   * messages Slack refused, what is pinned, and how many are still shown (`left`), a tombstone not
   * counted. What arrives after the root went can only be counted in `left`.
   */
  async #empty(
    channelId: string,
    threadTs: string,
  ): Promise<{ refused: number; pinned: PinnedRefusal | null; left: number }> {
    const handled = new Set<string>();
    const refused = new Set<string>();
    const kept = new Set<string>();
    const messages = await this.#sweep(channelId, threadTs, handled, refused, kept);
    // A reply skipped as pinned is still there even if a later read shows it unpinned.
    const pinned =
      pinnedOf(messages, threadTs) ??
      (kept.size > 0 ? { reason: "pinned", where: "reply" as const } : null);
    if (refused.size > 0 || pinned !== null) return { refused: refused.size, pinned, left: 0 };
    const stillShown = [...messages.keys()].filter((ts) => ts !== threadTs).length;
    if (stillShown > 0) return { refused: 0, pinned: null, left: stillShown };
    const root = messages.get(threadTs);
    if (root === undefined || root.tombstone) return { refused: 0, pinned: null, left: 0 };
    if (!(await this.#remove(channelId, threadTs, root.author))) {
      return { refused: 1, pinned: null, left: 0 };
    }
    // A reply that came between the last read and the root's delete goes here.
    const after = await this.#sweep(channelId, threadTs, handled, new Set(), new Set());
    const left = [...after.values()].filter((seen) => !seen.tombstone).length;
    return { refused: 0, pinned: null, left };
  }

  /**
   * Deletes the replies not `handled` yet until a read shows none, adding to `refused` what Slack
   * refuses and to `kept` what is pinned. Returns what that last read found.
   */
  async #sweep(
    channelId: string,
    threadTs: string,
    handled: Set<string>,
    refused: Set<string>,
    kept: Set<string>,
  ): Promise<Map<string, Seen>> {
    for (;;) {
      const messages = await this.#messages(channelId, threadTs);
      const replies = [...messages].filter(([ts]) => ts !== threadTs && !handled.has(ts));
      if (replies.length === 0) return messages;
      for (const [ts, seen] of replies) {
        handled.add(ts);
        if (seen.marks.pinned) {
          kept.add(ts); // the owner keeps it
          continue;
        }
        if (!(await this.#remove(channelId, ts, seen.author))) refused.add(ts);
      }
    }
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
   * bot's that have no reply, and Slack's notices. Returns the line that says what it did or why
   * it stopped, null for a channel that is not bound. Never throws.
   */
  async clean(channelId: string): Promise<string | null> {
    if (!this.#state.channels().includes(channelId)) {
      return null; // not a channel of the daemon's: nothing a click may clean
    }
    const { deleted, refused, error } = await this.#oneAtATime.run(() =>
      this.#cleanLoose(channelId),
    );
    if (error !== null) {
      return fill(slackTexts.HOME_CLEAN_FAILED, { error, deleted, count: refused });
    }
    return refused > 0
      ? fill(named(slackTexts.HOME_CLEAN_REFUSED, this.#names()), { deleted, count: refused })
      : fill(slackTexts.HOME_CLEAN_DONE, { deleted });
  }

  /** Deletes what `#loose` finds, and says how far it went. Never throws. */
  async #cleanLoose(
    channelId: string,
  ): Promise<{ deleted: number; refused: number; error: string | null }> {
    let deleted = 0;
    let refused = 0;
    try {
      for (const [ts, { author, notice }] of await this.#loose(channelId)) {
        const gone = notice
          ? await this.#removeNotice(channelId, ts, notice)
          : await this.#remove(channelId, ts, author);
        if (gone) deleted += 1;
        else refused += 1;
      }
    } catch (error) {
      logger.warning(`could not clean up ${channelId}: ${describe(error)}`);
      return { deleted, refused, error: describe(error) };
    }
    logger.info(`cleaned up ${channelId}: ${deleted} messages, ${refused} refused`);
    return { deleted, refused, error: null };
  }

  /** What `purge` would take and keep, read now. Throws on a failed read. */
  async survey(channelId: string): Promise<ChannelSurvey> {
    let [threads, busy, pinned] = [0, 0, 0];
    for (const ts of await this.#threadsOf(channelId)) {
      const status = this.#state.thread(channelId, ts)?.status;
      if (status === "working" || status === "waiting") busy += 1;
      else if (pinnedOf(await this.#messages(channelId, ts), ts) !== null) pinned += 1;
      else threads += 1;
    }
    return { threads, busy, pinned };
  }

  /**
   * Delete a bound channel's threads one by one, each holding the lock only for itself, then clean
   * it up. A thread in use or pinned stays, a failure stops the purge. Returns the line that says
   * how it went, null for a channel that is not bound. Never throws.
   */
  async purge(channelId: string): Promise<string | null> {
    if (!this.#state.channels().includes(channelId)) return null;
    let [threads, kept, left] = [0, 0, 0];
    let stop: string | null = null;
    try {
      for (const ts of await this.#threadsOf(channelId)) {
        const refusal = await this.#oneAtATime.run(() => this.#delete(channelId, ts));
        if (refusal === null) threads += 1;
        else if (refusal.reason === "busy" || refusal.reason === "pinned") kept += 1;
        else left += 1;
        if (refusal?.reason === "failed") {
          stop = refusal.error;
          break;
        }
      }
    } catch (error) {
      logger.warning(`could not read the threads of ${channelId}: ${describe(error)}`);
      stop = describe(error);
    }
    const loose =
      stop === null
        ? await this.#oneAtATime.run(() => this.#cleanLoose(channelId))
        : { deleted: 0, refused: 0, error: stop };
    const line = fill(slackTexts.CLEAN_WORD_DONE, {
      threads,
      kept,
      left,
      deleted: loose.deleted,
      refused: loose.refused,
    });
    return loose.error === null
      ? line
      : `${line} ${fill(slackTexts.CLEAN_WORD_STOPPED, { error: loose.error })}`;
  }

  /**
   * The threads a purge deletes: those `state.json` holds, and the ones with a reply it no longer
   * holds, whose root is the owner's, the bot's or a tombstone.
   */
  async #threadsOf(channelId: string): Promise<string[]> {
    const found: string[] = [];
    for await (const message of this.#history(channelId)) {
      const ts = tsOf(message);
      if (this.#state.thread(channelId, ts) !== null) {
        found.push(ts);
        continue;
      }
      const author = String(message.user || "");
      const known = author === this.#botUserId || author === this.#ownerUserId;
      const root = String(message.thread_ts ?? "") === ts;
      const started = known && root && (!message.subtype || message.subtype === FILE_SHARE);
      if ((isTombstone(message) || started) && (await this.#holdsReplies(channelId, ts))) {
        found.push(ts);
      }
    }
    return found;
  }

  /**
   * Whether a thread still has a reply, for a purge that would delete it: unlike `#hasReplies`,
   * which keeps what it cannot tell about, one gone or with no root in the answer is no thread.
   */
  async #holdsReplies(channelId: string, ts: string): Promise<boolean> {
    let answer: unknown;
    try {
      answer = await this.#bot.conversations.replies({ channel: channelId, ts, limit: 1 });
    } catch (error) {
      if (describe(error) === THREAD_NOT_FOUND) return false;
      throw error;
    }
    const messages = messagesOf(answer);
    const root = messages.find((message) => String(message.ts) === ts);
    return root !== undefined && (Boolean(root.reply_count) || messages.length > 1);
  }

  /** The channel's messages, page by page. */
  async *#history(channelId: string): AsyncGenerator<Record<string, unknown>> {
    let cursor: string | null = null;
    for (;;) {
      const page: unknown = await this.#bot.conversations.history({
        channel: channelId,
        limit: PAGE,
        ...(cursor === null ? {} : { cursor }),
      });
      yield* messagesOf(page);
      cursor = nextCursor(page);
      if (cursor === null) return;
    }
  }

  /**
   * Delete a notice of Slack's with the owner's token. False for any refusal of Slack's, whose code
   * no reference names: one notice must not stop the clean up at every retry. A rate limit, a
   * network failure or `NOT_A_REFUSAL` is none, and throws.
   */
  async #removeNotice(channelId: string, ts: string, subtype: string): Promise<boolean> {
    try {
      await this.#owner.chat.delete({ channel: channelId, ts });
      return true;
    } catch (error) {
      if (!(error instanceof WebAPIPlatformError)) throw error;
      if (describe(error) === MESSAGE_NOT_FOUND) return true;
      if (NOT_A_REFUSAL.has(describe(error))) throw error;
      logger.warning(`slack refused to delete a ${subtype} notice: ${describe(error)}`);
      return false;
    }
  }

  /** The channel's messages a clean-up deletes, `ts` to what is read of it, read page by page. */
  async #loose(channelId: string): Promise<Map<string, Loose>> {
    const found = new Map<string, Loose>();
    for await (const message of this.#history(channelId)) {
      const ts = tsOf(message);
      const author = String(message.user || "");
      const threaded = message.thread_ts;
      const subtype = String(message.subtype ?? "");
      const notice = CHANNEL_NOTICE.test(subtype);
      if ((subtype && !notice && subtype !== FILE_SHARE) || (threaded && String(threaded) !== ts)) {
        continue; // another of Slack's own lines; or a thread's reply shown in the channel
      }
      if (!notice && author !== this.#botUserId && author !== this.#ownerUserId) continue;
      if (this.#state.thread(channelId, ts) !== null) {
        continue; // a thread of the daemon's with no reply yet
      }
      // The history carries `pinned_to` as `conversations.replies` does (measured 2026-10-20 on
      // a free workspace: a hand-pinned `!help` outside a thread stayed through a clean-up).
      if (isPinned(message)) continue; // the owner keeps it
      if (threaded && (await this.#hasReplies(channelId, ts))) continue; // a thread
      found.set(ts, { author, notice: notice ? subtype : null });
    }
    return found;
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
        found.set(tsOf(message), {
          author: String(message.user || ""),
          marks: rootMarks(message),
          tombstone: isTombstone(message),
        });
      }
      cursor = nextCursor(page);
      if (cursor === null) return found;
    }
  }
}
