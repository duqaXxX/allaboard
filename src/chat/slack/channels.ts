/** What the daemon asks Slack about the channels it is bound to, and the threads in them. */

import type { WebClient } from "@slack/web-api";
import type { ChannelLookup, ThreadLookup } from "../../core/port.ts";
import { getLogger } from "../../log.ts";
import { isRecord } from "../../values.ts";
import { ChatError } from "../seam.ts";
import { THREAD_NOT_FOUND } from "./delete.ts";
import { crossedError, describe } from "./reply/errors.ts";

export const logger = getLogger("allaboard.chat.slack.channels");

const CHANNEL_NOT_FOUND = "channel_not_found";

/** The owner's user scope that lets `conversations.info` read a private channel the bot left. */
export const READ_CHANNELS_SCOPE = "groups:read";

/**
 * What the cleanup asks about a bound channel: `conversations.info`. The bot's `channel_not_found`
 * is the same answer for a deleted channel and for one the bot was removed from or never joined
 * (measured 2026-11-05), so it is `gone` only when the owner's token, which sees a channel the
 * bot does not, says `channel_not_found` too. With no `owner` (no token, or no `groups:read`) or
 * a channel the owner still sees, the answer is `no answer` and the channel is kept. Any other
 * failure crosses as a `ChatError` named by Slack's code, which the cleanup logs as no answer.
 */
export function channelLookup(slack: WebClient, owner: WebClient | null): ChannelLookup {
  return async (channelId) => {
    try {
      await slack.conversations.info({ channel: channelId });
      return "there";
    } catch (error) {
      if (describe(error) !== CHANNEL_NOT_FOUND) throw crossedError(error);
    }
    if (owner === null) {
      logger.warning(
        `Slack does not show channel ${channelId} to the bot: kept, since without the owner's token (scope ${READ_CHANNELS_SCOPE}) a deleted channel and one the bot was removed from look the same`,
      );
      return "no answer";
    }
    try {
      await owner.conversations.info({ channel: channelId });
    } catch (error) {
      if (describe(error) === CHANNEL_NOT_FOUND) return "gone";
      throw crossedError(error);
    }
    logger.warning(
      `the bot is not in channel ${channelId}, which still exists: invite it again to use the channel`,
    );
    return "no answer";
  };
}

/**
 * Whether `root`, a message `conversations.replies` returned, is a tombstone: a root deleted while
 * replies remain, which Slack returns with `subtype` `tombstone` and the text `This message was
 * deleted.` (measured 2026-10-20 on a development app; the subtype is not in the method's
 * reference). Such a root is gone, as one answered with `thread_not_found` is.
 */
export function isTombstone(root: unknown): boolean {
  return isRecord(root) && root.subtype === "tombstone";
}

/**
 * What the cleanup asks about a thread: `conversations.replies` on its root with `limit=1`. A root
 * deleted with no replies, or whose last reply was deleted since, answers `thread_not_found`
 * (measured 2026-10-01, see `home.ts`). A root deleted while replies remain is returned as a
 * tombstone, a message with `subtype` `tombstone` and the text `This message was deleted.` (measured
 * 2026-10-20; the subtype is not in the method's reference). Those two say the thread is gone; any
 * other failure crosses as a `ChatError` named by Slack's code.
 */
export function threadLookup(slack: WebClient): ThreadLookup {
  return async (ref) => {
    try {
      const answer = await slack.conversations.replies({
        channel: ref.channel,
        ts: ref.thread,
        limit: 1,
      });
      const root: unknown = answer.messages?.find((message) => message.ts === ref.thread);
      return isTombstone(root) ? "gone" : "there";
    } catch (error) {
      const code = describe(error);
      if (code === THREAD_NOT_FOUND) return "gone";
      throw crossedError(error);
    }
  };
}
