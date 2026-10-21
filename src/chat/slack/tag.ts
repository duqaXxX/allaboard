/**
 * The tag of a thread, shown on its root message and kept at hand by a pin: `!tag <name>` puts
 * an inline-code `[name]` and a space at the start of the root, replacing a tag already there,
 * and pins the root; `!untag` removes the prefix and, from a root that carried a tag, the pin (a
 * pin the owner made by hand on an untagged root is left alone).
 *
 * The root is the owner's own message, and `chat.update` changes only "messages posted by the
 * authenticated user" (docs.slack.dev/reference/methods/chat.update, read 2026-10-19), so the
 * edit and the pin both go through the owner's user token (`SLACK_USER_TOKEN`, scopes
 * `chat:write` and `pins:write`); the bot only reads the root. Measured on a dev workspace on
 * 2026-10-19: that token edits and pins the owner's root; no `pinned_item` message is posted;
 * no push reaches iOS for any of the four actions; the edit reaches the daemon as
 * `message_changed`, which `app/guards.ts` drops, so no prompt is sent; `conversations.replies`
 * with the bot's `groups:history` returns `pinned_to` and `pinned_info` on a pinned root; Slack's
 * search finds the tag word an edit added. Not tried: a root with real formatting or a file.
 *
 * The tag is read back from the root's own blocks (`rootMarks`, which the Home tab uses too), so
 * `state.json` keeps nothing of it: the first element of the first `rich_text_section` is a text
 * element in code style whose text is `[name]` for a name that satisfies `TAG_NAME`, followed by
 * an element that is exactly a space.
 *
 * The title of a thread (`titleThread`) replaces the whole root: one `rich_text` block with one
 * section, the tag's two elements when the root carries a tag, then a bold text element with the
 * title. The owner's own words are gone from the root once it has a title,
 * so there is no title line to tell apart from them and nothing to replace selectively. The tag
 * is read first (`rootMarks`) and kept, so `!tag` and `!untag` work on a titled root as on any
 * other. Tag and title edits of one root are serialized, since each reads the message and writes
 * it back whole. Titling needs `chat:write` alone: no pin is involved.
 *
 * `pins.add` answers `already_pinned` for a pinned item (docs.slack.dev/reference/methods/pins.add,
 * read 2026-10-19); `pins.remove` answers `not_pinned` ("The item isn't pinned to the channel") or
 * `no_pin` ("The pin couldn't be found", docs.slack.dev/reference/methods/pins.remove, read
 * 2026-10-19). Both mean the pin is already as asked, so neither is a failure.
 */
import { isDeepStrictEqual } from "node:util";
import type { KnownBlock, WebClient } from "@slack/web-api";
import { TAG_NAME } from "../../core/port.ts";
import { isRecord } from "../../values.ts";
import { ChatError } from "../seam.ts";
import { slackUnescape } from "./app/messages.ts";
import { isTombstone } from "./channels.ts";
import { describe, GONE } from "./reply/errors.ts";
import { mrkdwnEscape } from "./reply/escape.ts";

type Json = Record<string, unknown>;

/** What a root message carries of the tag and the pin. */
export interface RootMarks {
  /** The tag the root starts with; null when it has none. */
  readonly tag: string | null;
  /** Whether the root is pinned in its channel (`pinned_to`). */
  readonly pinned: boolean;
}

// What Slack answers when a root can never be read or edited again by this token: the edit window
// of the workspace closed, the message cannot be updated, the message, its thread or its channel
// is gone, or the token lacks a scope or a membership.
const REFUSED_FOR_GOOD: ReadonlySet<string> = new Set([
  ...GONE,
  "edit_window_closed",
  "cant_update_message",
  "not_in_channel",
  "missing_scope",
]);

/** `step`, with a refusal that cannot change made a `permanent` `ChatError`. */
async function permanently<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    const code = describe(error);
    // The same call is refused again at any later turn: say so, so the core stops asking.
    if (REFUSED_FOR_GOOD.has(code)) throw new ChatError(code, { cause: error, permanent: true });
    throw error;
  }
}
const ALREADY_PINNED = "already_pinned";
const NOT_PINNED: ReadonlySet<string> = new Set(["not_pinned", "no_pin"]);
// The inline-code prefix of a root's `text`, which Slack writes with backticks.
const TEXT_PREFIX = /^`\[([^\]`]*)\]` ?/;

/** The name inside a text element that is an inline-code `[name]`, null for any other element. */
function nameOf(element: unknown): string | null {
  if (!isRecord(element) || element.type !== "text" || typeof element.text !== "string") {
    return null;
  }
  const style = element.style;
  if (!isRecord(style) || style.code !== true || Object.keys(style).length !== 1) return null;
  const inner = /^\[(.*)\]$/s.exec(element.text)?.[1];
  return inner !== undefined && TAG_NAME.test(inner) ? inner : null;
}

/** Whether `element` is exactly one space, with no style. */
function isSpace(element: unknown): boolean {
  return (
    isRecord(element) && element.type === "text" && element.text === " " && !("style" in element)
  );
}

/** The first `rich_text` block of a root's blocks, or undefined. */
function richText(blocks: readonly unknown[]): Json | undefined {
  return blocks.find((block): block is Json => isRecord(block) && block.type === "rich_text");
}

/** The elements of the first section of a root's first `rich_text` block, or null. */
function leadingElements(blocks: readonly unknown[]): unknown[] | null {
  const elements = richText(blocks)?.elements;
  const section = Array.isArray(elements) ? elements[0] : undefined;
  if (!isRecord(section) || section.type !== "rich_text_section") return null;
  return Array.isArray(section.elements) ? section.elements : null;
}

/** Whether a message carries a pin: `pinned_to` is a non-empty list of channel ids. */
export function isPinned(message: Readonly<Json>): boolean {
  return Array.isArray(message.pinned_to) && message.pinned_to.length > 0;
}

/**
 * The tag a root message carries and whether it is pinned, as `conversations.replies` returns it.
 * A root with no blocks at all is read from its text.
 */
export function rootMarks(root: Readonly<Json>): RootMarks {
  const pinned = isPinned(root);
  if (Array.isArray(root.blocks)) {
    return { tag: nameOf(leadingElements(root.blocks)?.[0]), pinned };
  }
  const prefix = typeof root.text === "string" ? TEXT_PREFIX.exec(root.text)?.[1] : undefined;
  return { tag: prefix !== undefined && TAG_NAME.test(prefix) ? prefix : null, pinned };
}

/** `[name]` in code style and a space: what a tagged root starts with. */
function tagElements(tag: string): Json[] {
  return [
    { type: "text", text: `[${tag}]`, style: { code: true } },
    { type: "text", text: " " },
  ];
}

/** `blocks` with their leading tag taken off and `tag`, when there is one, put in its place. */
export function retaggedBlocks(blocks: readonly unknown[], tag: string | null): unknown[] {
  const copy = structuredClone([...blocks]);
  const rich = richText(copy);
  if (rich === undefined) {
    return tag === null
      ? copy
      : [
          {
            type: "rich_text",
            elements: [{ type: "rich_text_section", elements: tagElements(tag) }],
          },
          ...copy,
        ];
  }
  const elements = Array.isArray(rich.elements) ? rich.elements : [];
  rich.elements = elements;
  const section = elements[0];
  if (
    isRecord(section) &&
    section.type === "rich_text_section" &&
    Array.isArray(section.elements)
  ) {
    const inner = section.elements;
    const tagged = nameOf(inner[0]) !== null;
    if (tagged) inner.splice(0, isSpace(inner[1]) ? 2 : 1);
    if (tag !== null) inner.unshift(...tagElements(tag));
    // The tag may have had a section of its own (a root that starts with a list or a code
    // block), or a block of its own (a root with no rich_text block): taking it off takes those
    // with it, so a tag and an untag leave the blocks as they were.
    if (tagged && inner.length === 0) {
      elements.splice(0, 1);
      if (elements.length === 0) copy.splice(copy.indexOf(rich), 1);
    }
  } else if (tag !== null) {
    // The root starts with a list or a code block: the tag gets a line of its own.
    elements.unshift({ type: "rich_text_section", elements: tagElements(tag) });
  }
  return copy;
}

/**
 * The root as a titled one reads: a single `rich_text` block holding `tag`, when there is one,
 * and `title` in bold. The block keeps the id of the root's first `rich_text` block, so that a
 * title already shown rewrites to the very blocks the root holds and nothing is sent.
 */
export function retitledBlocks(
  blocks: readonly unknown[],
  title: string,
  tag: string | null,
): unknown[] {
  const id = richText(blocks)?.block_id;
  return [
    {
      type: "rich_text",
      ...(typeof id === "string" && { block_id: id }),
      elements: [
        {
          type: "rich_text_section",
          elements: [
            ...(tag === null ? [] : tagElements(tag)),
            { type: "text", text: title, style: { bold: true } },
          ],
        },
      ],
    },
  ];
}

/** The text fallback of a titled root: `` `[tag]` *title* `` or `*title*`. */
export function retitledText(title: string, tag: string | null): string {
  // Slack's control characters in a message's text (docs.slack.dev/reference/surfaces/formatting);
  // the tag is written where `retaggedText` writes it.
  return retaggedText(`*${mrkdwnEscape(title)}*`, tag);
}

/** `text` with its leading `` `[name]` `` taken off and `tag`, when there is one, put in its place. */
export function retaggedText(text: string, tag: string | null): string {
  const prefix = TEXT_PREFIX.exec(text);
  const body =
    prefix !== null && TAG_NAME.test(prefix[1] ?? "") ? text.slice(prefix[0].length) : text;
  return tag === null ? body : `\`[${tag}]\` ${body}`;
}

/** What a root edit rewrites: its text and its blocks. */
interface Rewrite {
  readonly text: (text: string) => string;
  readonly blocks: (blocks: readonly unknown[]) => unknown[];
}

/** Edits the root of a thread with the owner's own token: its tag and pin, its title line. */
export class RootEditor {
  readonly #bot: WebClient;
  readonly #owner: WebClient;
  // The last edit of each root still running or queued, by channel and thread.
  readonly #tails = new Map<string, Promise<void>>();

  /** `bot` reads the root; `owner` is the client of the owner's user token and writes. */
  constructor(bot: WebClient, owner: WebClient) {
    this.#bot = bot;
    this.#owner = owner;
  }

  /**
   * Puts `tag` on the root of `thread` and pins it, or with a null `tag` takes the tag away and, when the root carried one, the pin. Each
   * step is skipped when the root is already as asked, so a repeat is harmless. Rejects with a
   * `ChatError` carrying Slack's code when a call was refused.
   */
  tag(channel: string, thread: string, tag: string | null): Promise<void> {
    return this.#serially(channel, thread, async () => {
      const root = await this.#root(channel, thread);
      const marks = rootMarks(root);
      await this.#edit(channel, thread, root, {
        text: (text) => retaggedText(text, tag),
        blocks: (blocks) => retaggedBlocks(blocks, tag),
      });
      if (tag !== null && !marks.pinned) await this.#pin(channel, thread);
      // Only a root that carried a tag is unpinned: a pin the owner made by hand stays.
      if (tag === null && marks.pinned && marks.tag !== null) await this.#unpin(channel, thread);
    });
  }

  /**
   * Rewrites the root of `thread` to its tag, when it has one, and `title` in bold: the owner's
   * own words leave the root. In one queued task it reads the root once, hands `keep` the words
   * the root held in the form the agent receives a message (`slackUnescape` of the root's `text`,
   * the tag left out) and waits for it, and only then edits; when `keep` throws nothing is edited.
   * Nothing is sent when the root already reads as asked. Rejects with a `ChatError` carrying
   * Slack's code when a call was refused, `permanent` when the refusal cannot change.
   */
  title(
    channel: string,
    thread: string,
    title: string,
    keep?: (text: string) => void | Promise<void>,
  ): Promise<void> {
    // One line: a newline in the title would end the bold element's line early.
    const line = title.replace(/\s+/g, " ").trim();
    return this.#serially(channel, thread, async () => {
      const root = await permanently(() => this.#root(channel, thread));
      const { tag } = rootMarks(root);
      if (keep !== undefined) {
        const text = typeof root.text === "string" ? root.text : "";
        await keep(slackUnescape(retaggedText(text, null)));
      }
      await permanently(() =>
        this.#edit(channel, thread, root, {
          text: () => retitledText(line, tag),
          blocks: (blocks) => retitledBlocks(blocks, line, tag),
        }),
      );
    });
  }

  /** Runs `work` after the edits of the same root asked before it, and wraps its failure. */
  #serially(channel: string, thread: string, work: () => Promise<void>): Promise<void> {
    const key = `${channel}/${thread}`;
    const run = (this.#tails.get(key) ?? Promise.resolve()).then(async () => {
      try {
        await work();
      } catch (error) {
        if (error instanceof ChatError) throw error;
        throw new ChatError(describe(error), { cause: error });
      }
    });
    const tail = run.then(
      () => {},
      () => {},
    );
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return run;
  }

  async #root(channel: string, thread: string): Promise<Json> {
    const answer = await this.#bot.conversations.replies({ channel, ts: thread, limit: 1 });
    const messages: unknown[] = Array.isArray(answer.messages) ? answer.messages : [];
    const root = messages.find((message) => isRecord(message) && String(message.ts) === thread);
    if (!isRecord(root)) throw new ChatError("root_not_returned");
    // A root deleted while replies remain is returned as a tombstone (measured 2026-10-20): it is
    // gone, and nothing of it is kept or edited. The same refusal `conversations.replies` gives
    // once the last reply is deleted too.
    if (isTombstone(root)) {
      throw new ChatError("thread_not_found", { permanent: true });
    }
    return root;
  }

  /** Rewrites the root's text and blocks; nothing is sent when they would not change. */
  async #edit(channel: string, thread: string, root: Json, rewrite: Rewrite): Promise<void> {
    const text = typeof root.text === "string" ? root.text : "";
    const nextText = rewrite.text(text);
    const hasBlocks = Array.isArray(root.blocks);
    const nextBlocks = hasBlocks ? rewrite.blocks(root.blocks as unknown[]) : null;
    if (nextText === text && (!hasBlocks || isDeepStrictEqual(nextBlocks, root.blocks))) return;
    await this.#owner.chat.update({
      channel,
      ts: thread,
      text: nextText,
      // A root with no blocks is shown from its text, which a block would replace.
      ...(nextBlocks !== null && { blocks: nextBlocks as KnownBlock[] }),
    });
  }
  async #pin(channel: string, thread: string): Promise<void> {
    try {
      await this.#owner.pins.add({ channel, timestamp: thread });
    } catch (error) {
      if (describe(error) !== ALREADY_PINNED) throw error;
    }
  }

  async #unpin(channel: string, thread: string): Promise<void> {
    try {
      await this.#owner.pins.remove({ channel, timestamp: thread });
    } catch (error) {
      if (!NOT_PINNED.has(describe(error))) throw error;
    }
  }
}
