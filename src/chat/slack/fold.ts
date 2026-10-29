/**
 * Folding a message of the daemon's after a rewind: the message is read back, its content turned
 * into text, and the message rewritten into one collapsed `task_card` titled by the core, the
 * text inside. Nothing is deleted. The message is read with `conversations.replies` (the root's
 * read path, `channels:history` and `groups:history` of the manifest) and written with
 * `chat.update`, the daemon's own message being the app's to edit.
 *
 * Block shapes read: `markdown` (`text`), `section` and `header` (`text.text`), `context`
 * (`elements[].text`), `rich_text` (nested elements with `text`) and `task_card` (`title`,
 * `details`, `output`), per the Block Kit reference (docs.slack.dev/reference/block-kit/blocks,
 * read 2026-10-29). A message with no readable block gives its `text`.
 */
import type { KnownBlock, WebClient } from "@slack/web-api";
import { isRecord } from "../../values.ts";
import { CARD_TEXT_LIMIT, cardBlock } from "./reply/blocks.ts";
import { take } from "./reply/chars.ts";
import * as slackTexts from "./texts.ts";

type Json = Record<string, unknown>;

/** The text of the elements of a rich text block, in reading order. */
function richTextOf(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(richTextOf);
  if (!isRecord(node)) return [];
  if (typeof node.text === "string" && node.type !== "rich_text") return [node.text];
  return richTextOf(node.elements);
}

/** The text of one block, empty for a block that holds none (a divider, a control). */
function blockText(block: Json): string {
  switch (block.type) {
    case "markdown":
      return typeof block.text === "string" ? block.text : "";
    case "section":
    case "header":
      return isRecord(block.text) && typeof block.text.text === "string" ? block.text.text : "";
    case "context":
      return Array.isArray(block.elements)
        ? block.elements
            .flatMap((element) =>
              isRecord(element) && typeof element.text === "string" ? [element.text] : [],
            )
            .join(" ")
        : "";
    case "rich_text":
      return richTextOf(block).join("");
    case "task_card":
      return [block.title, richTextOf(block.details).join(""), richTextOf(block.output).join("")]
        .filter((part): part is string => typeof part === "string" && part !== "")
        .join("\n");
    default:
      return "";
  }
}

/** What a message showed, as text: its blocks in order, else its fallback `text`. */
export function textOfMessage(message: Json): string {
  const blocks = Array.isArray(message.blocks) ? message.blocks : [];
  const text = blocks
    .flatMap((block) => (isRecord(block) ? [blockText(block)] : []))
    .filter((part) => part !== "")
    .join("\n\n");
  if (text !== "") return text;
  return typeof message.text === "string" ? message.text : "";
}

/** `text` cut at the card's field limit, with a marker that says it was. */
export function fitted(text: string): string {
  if ([...text].length <= CARD_TEXT_LIMIT) return text;
  const marker = slackTexts.FOLD_CUT;
  return `${take(text, CARD_TEXT_LIMIT - [...marker].length - 1)}\n${marker}`;
}

/** The messages `ts` of a thread, or null when Slack returns none such. */
async function read(
  slack: WebClient,
  channel: string,
  thread: string,
  ts: string,
): Promise<Json | null> {
  const answer = await slack.conversations.replies({
    channel,
    ts: thread,
    oldest: ts,
    latest: ts,
    inclusive: true,
    limit: 1,
  });
  const messages: unknown[] = Array.isArray(answer.messages) ? answer.messages : [];
  const found = messages.find((message) => isRecord(message) && String(message.ts) === ts);
  return isRecord(found) ? found : null;
}

/**
 * Rewrites the message `ts` of `thread` into a collapsed card titled `title` holding its text.
 * False, with the message as it was, when it cannot be read or written.
 */
export async function foldMessage(
  slack: WebClient,
  limiter: { acquire(): Promise<void> },
  channel: string,
  thread: string,
  ts: string,
  title: string,
): Promise<boolean> {
  const message = await read(slack, channel, thread, ts);
  if (message === null) return false;
  const card = cardBlock({
    id: `folded-${ts}`,
    title,
    status: "complete",
    details: fitted(textOfMessage(message)),
    output: null,
    name: "",
    task: false,
    message: false,
    calls: 0,
    preview: null,
    folded: null,
    startedAt: null,
  });
  await limiter.acquire();
  await slack.chat.update({
    channel,
    ts,
    text: title,
    blocks: [card as unknown as KnownBlock],
  });
  return true;
}
