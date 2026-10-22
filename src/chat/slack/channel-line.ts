/**
 * One line of the bot's at the bottom of a project channel, naming the thread whose work was done
 * last, so the channel shows as unread in the sidebar. Slack marks a channel unread only for a
 * top-level message of someone else's: a reply in a thread, a mention or a reaction there, an edit
 * and the owner's own messages leave it as read (measured on a dev app on 2026-10-22, iOS and
 * desktop). Each time a session's work is done (its reply's first footer) the bot posts a new
 * line and deletes the one before, so the channel holds one line of the bot's at most and opens at
 * the bottom, on that line.
 *
 * The line is found again by its message metadata (`LINE_EVENT`), which `conversations.history`
 * returns for the app's own messages (measured the same day): `state.json` keeps nothing of it.
 * The line this run posted is remembered per channel; the first one in a channel after a start
 * is looked for in the channel's latest messages (`HISTORY_LIMIT`), and every line found there is
 * deleted. A line of an earlier run further up than that stays where it is.
 */

import type { WebClient } from "@slack/web-api";
import { getLogger, type Logger } from "../../log.ts";
import { slackUnescape } from "./app/messages.ts";
import { describe, gone } from "./reply/errors.ts";
import { mrkdwnEscape } from "./reply/escape.ts";
import { stripMarkdown } from "./reply/markdown.ts";
import { retaggedText } from "./tag.ts";

export const logger = getLogger("allaboard.chat.slack.channel_line");

/** The metadata event type that marks a message as the channel's line. */
export const LINE_EVENT = "allaboard_channel_line";
/** How many of the channel's latest messages are read for a line an earlier run left. */
export const HISTORY_LIMIT = 100;
/** How many characters of the thread's first line name it. */
export const LABEL_LIMIT = 80;
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

export interface ChannelLineOptions {
  /** The daemon's own bot: only its messages are taken for a line. */
  readonly botUserId: string;
  readonly logger?: Logger;
}

export class ChannelLine {
  readonly #slack: WebClient;
  readonly #botUserId: string;
  readonly #log: Logger;
  // Per channel: the line this run posted last, once it posted one, and the older lines a
  // delete failed for, tried again at the next change.
  readonly #posted = new Map<string, string>();
  readonly #left = new Map<string, string[]>();
  // Per channel, the change in flight: the next one waits for it.
  readonly #chain = new Map<string, Promise<void>>();

  constructor(slack: WebClient, options: ChannelLineOptions) {
    this.#slack = slack;
    this.#botUserId = options.botUserId;
    this.#log = options.logger ?? logger;
  }

  /**
   * Move the channel's line to the bottom, naming the thread whose root is `rootTs`. Never
   * rejects: a failure is logged by its code and the reply goes on.
   */
  show(channel: string, rootTs: string): Promise<void> {
    const before = this.#chain.get(channel) ?? Promise.resolve();
    const next = before.then(async () => {
      try {
        await this.#show(channel, rootTs);
      } catch (error) {
        this.#log.warning(`could not move the line of ${channel}: ${describe(error)}`);
      }
    });
    this.#chain.set(channel, next);
    return next;
  }

  async #show(channel: string, rootTs: string): Promise<void> {
    const replies = await this.#slack.conversations.replies({ channel, ts: rootTs, limit: 1 });
    const label = lineLabel(replies.messages?.[0] as Message | undefined);
    const { permalink } = await this.#slack.chat.getPermalink({ channel, message_ts: rootTs });
    const posted = await this.#slack.chat.postMessage({
      channel,
      text: `Done: ${label}`,
      blocks: [
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `✅ Done: <${permalink}|${mrkdwnEscape(label)}>` }],
        },
      ],
      metadata: { event_type: LINE_EVENT, event_payload: {} },
      unfurl_links: false,
      unfurl_media: false,
    });
    const ts = String(posted.ts);
    const known = this.#posted.get(channel);
    const old = [
      ...(this.#left.get(channel) ?? []),
      ...(known !== undefined ? [known] : await this.#earlier(channel, ts)),
    ];
    this.#posted.set(channel, ts);
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

  /** The lines an earlier run left among the channel's latest messages, `except` aside. */
  async #earlier(channel: string, except: string): Promise<string[]> {
    const history = await this.#slack.conversations.history({ channel, limit: HISTORY_LIMIT });
    return (history.messages ?? [])
      .filter((message) => {
        const meta = (message as { metadata?: { event_type?: unknown } }).metadata;
        return (
          message.user === this.#botUserId &&
          meta?.event_type === LINE_EVENT &&
          message.ts !== except
        );
      })
      .map((message) => String(message.ts));
  }
}
