/**
 * The Slack calls behind the daemon's own words, in one place for the thread (`SlackThread`), the
 * channel (`SlackChannel`) and the handlers that post blocks of their own (`Answers.deliver`): a
 * message to the channel or to its thread, and a message rewritten into a notice.
 */
import type {
  ChatPostMessageArguments,
  ChatPostMessageResponse,
  KnownBlock,
  WebClient,
} from "@slack/web-api";
import { Cancelled } from "../../core/port.ts";
import { getLogger } from "../../log.ts";
import { ChatError } from "../seam.ts";
import { threadLookup } from "./channels.ts";
import { contextBlock, FALLBACK_LIMIT, noticeText } from "./reply/blocks.ts";
import { take } from "./reply/chars.ts";
import { crossedError, describe } from "./reply/errors.ts";
import type { Limiter } from "./reply/limiter.ts";

const logger = getLogger("allaboard.chat.slack.notice");

/**
 * `chat.postMessage` into the thread `args.thread_ts` names. Slack answers `ok` to a post whose
 * thread root was deleted and puts it in the channel, with no `thread_ts` on the message
 * (measured 2026-11-07, #221; not in the method's reference). Such a post is deleted at once and
 * the call fails as `gone`, so that no message of the daemon's lands outside its thread. Every
 * post with a `thread_ts` goes through here.
 */
export async function postInThread(
  slack: WebClient,
  args: ChatPostMessageArguments & { readonly thread_ts: string },
): Promise<ChatPostMessageResponse> {
  const posted = await slack.chat.postMessage(args);
  if (posted.message?.thread_ts !== undefined) return posted;
  // The shape alone is not trusted with a deletion: the root is asked for before the post goes.
  const root = await threadLookup(slack)({ channel: args.channel, thread: args.thread_ts }).catch(
    (error: unknown) => describe(error),
  );
  if (root !== "gone") {
    logger.warning(
      `a post in ${args.channel}/${args.thread_ts} came back with no thread_ts, and the root is ${root === "there" ? "there" : `unconfirmed (${root})`}: kept`,
    );
    return posted;
  }
  if (typeof posted.ts === "string") {
    try {
      await slack.chat.delete({ channel: args.channel, ts: posted.ts });
    } catch (error) {
      logger.warning(`could not delete a stray post in ${args.channel}: ${describe(error)}`);
    }
  }
  throw new ChatError("thread_gone", { permanent: true, failure: "gone" });
}

/** Slack's message metadata: what a root keeps for the daemon's own later edits. */
export interface MessageMetadata {
  readonly event_type: string;
  // A null value is accepted by Slack and read back as sent (measured 2026-11-07), though the
  // library's type allows none: `deliver` and the root editor cast.
  readonly event_payload: Readonly<Record<string, string | null>>;
}

/** Where a message goes: a thread of the channel, or the channel itself when `threadTs` is null. */
export interface Place {
  readonly channel: string;
  readonly threadTs: string | null;
}

/**
 * One message to `place`: a normal post or, with `ephemeral`, one only `ownerUserId` sees. A
 * normal post pushes only inside a thread the owner started; an ephemeral message never does.
 * `blocks` are built to Block Kit's reference by the modules that make them: opaque to the
 * library's types. Returns the `ts` of a normal post, which `chat.delete` takes; null for an
 * ephemeral message, which Slack lets nobody delete or update.
 */
export async function deliver(
  slack: WebClient,
  ownerUserId: string,
  place: Place,
  text: string,
  blocks: readonly object[],
  options: { readonly ephemeral: boolean; readonly metadata?: MessageMetadata },
): Promise<string | null> {
  const shown = blocks as unknown as KnownBlock[];
  if (options.ephemeral) {
    const where = place.threadTs === null ? {} : { thread_ts: place.threadTs };
    await slack.chat.postEphemeral({
      channel: place.channel,
      user: ownerUserId,
      text: take(text, FALLBACK_LIMIT),
      blocks: shown,
      ...where,
    });
    return null;
  }
  const message = {
    channel: place.channel,
    text: take(text, FALLBACK_LIMIT),
    blocks: shown,
    unfurl_links: false,
    unfurl_media: false,
    ...(options.metadata !== undefined && {
      metadata: options.metadata as ChatPostMessageArguments["metadata"],
    }),
  };
  const posted =
    place.threadTs === null
      ? await slack.chat.postMessage(message)
      : await postInThread(slack, { ...message, thread_ts: place.threadTs });
  return posted.ts ?? null;
}

/** One of the daemon's notices, small and grey as the footer; `text` is mrkdwn. */
export function deliverNotice(
  slack: WebClient,
  ownerUserId: string,
  place: Place,
  text: string,
  options: { readonly ephemeral: boolean },
): Promise<string | null> {
  return deliver(slack, ownerUserId, place, text, [contextBlock(noticeText(text))], options);
}

/**
 * `call`, with a failure crossing the seam as a `ChatError` named by Slack's code. A `Cancelled`
 * is no failure of the chat: it crosses as it is.
 */
export async function crossing<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof Cancelled) throw error;
    throw crossedError(error);
  }
}

/**
 * The message `ts` rewritten into a notice that says `text`, with nothing left to press: an edit
 * (silent), against the app's `chat.update` budget, which every reply draws from. Rejects with a
 * `ChatError` named by Slack's code.
 */
export function rewriteAsNotice(
  slack: WebClient,
  limiter: Limiter,
  channel: string,
  ts: string,
  text: string,
): Promise<void> {
  return crossing(async () => {
    await limiter.acquire();
    await slack.chat.update({ channel, ts, text, blocks: [contextBlock(noticeText(text))] });
  });
}
