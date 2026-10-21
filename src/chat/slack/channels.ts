/** What the daemon asks Slack about the channels it is bound to, and the threads in them. */

import type { WebClient } from "@slack/web-api";
import type { ChannelLookup, ThreadLookup } from "../../core/port.ts";
import { isRecord } from "../../values.ts";
import { ChatError } from "../seam.ts";
import { THREAD_NOT_FOUND } from "./delete.ts";
import { describe } from "./reply/errors.ts";

const CHANNEL_NOT_FOUND = "channel_not_found";

/**
 * What the cleanup asks about a bound channel: `conversations.info`. Only `channel_not_found` is
 * an answer that the channel is gone; any other failure crosses as a `ChatError` named by
 * Slack's code, which the cleanup logs as no answer.
 */
export function channelLookup(slack: WebClient): ChannelLookup {
  return async (channelId) => {
    try {
      await slack.conversations.info({ channel: channelId });
      return "there";
    } catch (error) {
      const code = describe(error);
      if (code === CHANNEL_NOT_FOUND) return "gone";
      throw new ChatError(code, { cause: error });
    }
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
      throw new ChatError(code, { cause: error });
    }
  };
}
