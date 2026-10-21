/**
 * Claude's markdown as Slack reads it: how many blocks it makes of a text and where to cut one,
 * and the text with its markers gone, for a notification's banner.
 *
 * The patterns follow Python's regular expression rules where the two engines differ: Python's
 * `\s` and `\w` are Unicode (`PY_SPACE`, `WORD`), its `.` stops at `\n` only, and its `^` under
 * `re.M` starts a line after `\n` only (JavaScript's also after `\r`, U+2028 and U+2029).
 */

import { blank, PY_SPACE, strip } from "../../../text.ts";
import { len } from "./chars.ts";
import { mrkdwnEscape } from "./escape.ts";

const S = `[${PY_SPACE}]`;
// Python's `\w` on text: a letter or a digit of any script, or `_`.
const WORD = "[\\p{L}\\p{N}_]";

// Slack stores a `markdown` block, and a stream's `markdown_text`, as several blocks: a header
// per heading, a table per table, a divider per rule, and rich text for each run of anything
// else between them. A write by `chat.update` or `chat.postMessage` is refused when the message
// passes 50 of them; a stream is not, and the update that follows its stop is (measured
// 2026-10-08, slack-sdk 3.45.0). Quotes, lists, images, bold lines and code blocks stay in the
// rich text around them, and a `#` inside a code block is not a heading.
// Read as CommonMark and GFM define them where Slack was not measured (a heading underlined
// with `=`, a fence longer than three marks, a rule with spaces in it): a shape counted that
// Slack keeps in its rich text only ends a message early.
// Sticky, so that it reads a heading at an offset of a whole text as well as at a line's start.
const HEADING = new RegExp(` {0,3}#{1,6}(?:${S}|$)`, "y");
const UNDERLINE = new RegExp(`^ {0,3}=+${S}*$`);
const RULE = new RegExp(`^ {0,3}([-*_])(?:${S}*\\1){2,}${S}*$`);
const TABLE_CELL = /^:?-+:?$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/;

/** Whether a heading starts at `offset` of `text`. */
export function headingAt(text: string, offset: number): boolean {
  HEADING.lastIndex = offset;
  return HEADING.test(text);
}

/** Python's `line.rstrip("\r")`. */
function rstripReturns(line: string): string {
  let end = line.length;
  while (end > 0 && line.charCodeAt(end - 1) === 0x0d) end -= 1;
  return line.slice(0, end);
}

/**
 * Whether `line` is a table's delimiter row: cells of dashes, each with an optional colon at
 * either end, between pipes, the first and the last pipe optional.
 *
 * Read cell by cell, in time linear in the line. The agent writes the text, and one pattern for
 * the whole row backtracks in cubic time on a long run of spaces (measured 2026-10-11, Node
 * 26.5.1), on the event loop every thread shares.
 */
function tableRule(line: string): boolean {
  let row = strip(line);
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split("|").every((cell) => TABLE_CELL.test(strip(cell)));
}

/** Where each block starts that Slack makes of a markdown text, as offsets into it. */
export function markdownStarts(text: string): number[] {
  const starts: number[] = [];
  const lines = text.split("\n");
  let offset = 0;
  let fence = "";
  let running = false;
  let table = false;
  for (const [number, raw] of lines.entries()) {
    const here = offset;
    offset += raw.length + 1;
    const line = rstripReturns(raw);
    const mark = FENCE.exec(line);
    const run = mark?.[1] ?? "";
    const info = mark?.[2] ?? "";
    if (fence) {
      // Closed by a run of the same mark, at least as long, with nothing after it.
      if (mark !== null && run.startsWith(fence) && blank(info)) fence = "";
    } else if (mark !== null && !info.includes("`")) {
      fence = run;
      table = false;
    } else {
      if (blank(line)) {
        table = false;
        continue;
      }
      if (table && line.includes("|")) continue;
      table = false;
      const following = rstripReturns(lines[number + 1] ?? "");
      if (line.includes("|") && following.includes("|") && tableRule(following)) {
        starts.push(here);
        table = true;
        running = false;
        continue;
      }
      if (headingAt(line, 0) || RULE.test(line) || (running && UNDERLINE.test(line))) {
        starts.push(here);
        running = false;
        continue;
      }
    }
    if (!running) {
      starts.push(here);
      running = true;
    }
  }
  return starts;
}

/** How many blocks a markdown text with words in it counts in a message. */
export function markdownBlocks(text: string): number {
  return Math.max(1, markdownStarts(text).length);
}

/**
 * Where to cut a markdown text so that it makes at most `room` blocks, at a block's start no
 * earlier than `floor` (what a stream was already sent); null when nothing is to cut. A heading
 * is never the last block before the cut, nor the last of a text that fills the room: it opens
 * the next message, with the text it heads.
 */
export function markdownCut(text: string, room: number, floor = 0): number | null {
  const starts = markdownStarts(text);
  let index: number | null = starts.length === room ? starts.length : null;
  if (starts.length > room) {
    index = null;
    for (let i = room; i < starts.length; i += 1) {
      if ((starts.at(i) ?? 0) >= floor) {
        index = i;
        break;
      }
    }
  }
  if (index === null) return null;
  for (;;) {
    const before = starts[index - 1];
    if (index <= 1 || before === undefined || before < floor || !headingAt(text, before)) break;
    index -= 1;
  }
  return starts[index] ?? null;
}

// A pattern that reads ahead and then fails is tried again from every later start, which is
// quadratic on a long run of `[`, of blank lines or of `_` inside a word. So the three that read
// ahead also match what they read where no marker is (a `[` no link closes, space no marker
// follows, `_` between two letters), and the replacement puts that back as it was.
const LINK = /\[([^\]]*)(?:\](?:\([^)]*(\))?)?)?/g;
// `(?<![^\n])` is Python's `^` under `re.M`; `\p{Nd}` its `\d`.
const LINE_MARKER = new RegExp(`(?<![^\\n])${S}*((?:#+|>|[-+*]|\\p{Nd}+\\.)${S}+)?`, "gu");
const PAIRED = /\*\*|__|~~|`+/g;
const EMPHASIS = new RegExp(`(?<!${WORD})[*_]+|[*_]+(?!${WORD})|(_+)`, "gu");

/**
 * The markdown markers of `text` removed, nothing escaped, in a time linear in the text: a
 * banner is cut from a paragraph as long as Claude wrote it.
 */
export function stripMarkdown(text: string): string {
  let plain = text.replace(LINK, (all: string, label: string, closed: string | undefined) =>
    closed ? label : all,
  );
  plain = plain.replace(LINE_MARKER, (all: string, marker: string | undefined) =>
    marker ? "" : all,
  );
  plain = plain.replace(PAIRED, "");
  plain = plain.replace(EMPHASIS, (_all: string, kept: string | undefined) => kept ?? "");
  return strip(plain);
}

/**
 * A paragraph of Claude's markdown as the plain `text` of a notification: the markers gone
 * (headings, quotes, list bullets, emphasis, code ticks, link targets) and `&`, `<`, `>`
 * escaped, since Slack reads them as markup there too. With `limit` it is cut before it is
 * escaped, so the result holds at most that many characters and no half an entity.
 */
export function bannerText(paragraph: string, options: { limit?: number } = {}): string {
  const plain = stripMarkdown(paragraph);
  const limit = options.limit;
  if (limit === undefined) return mrkdwnEscape(plain);
  const out: string[] = [];
  let size = 0;
  // By code point: an emoji is one character of the limit.
  for (const char of plain) {
    const piece = mrkdwnEscape(char);
    const cost = len(piece);
    if (size + cost > limit) break;
    out.push(piece);
    size += cost;
  }
  return out.join("");
}

// A `<` with what follows it up to the next `|` or `>`, and the label when a `|...>` comes
// next. The stretch with no label is matched too, so that the search goes on after it: no `<`
// inside it opens a link either, since it would stop at the same `|` or `>`.
const LABELLED = /<[^|>]*(?:\|([^>]*)>)?/g;
const WORDS = new RegExp(`${WORD}+`, "gu");

/**
 * `text` with each `<target|label>` replaced by its label: what `/<[^|>]*\|([^>]*)>/g` and
 * `"$1"` give, in a time linear in the text (that pattern starts again at every `<`
 * of a run, and reads to the end each time). A link ends at a `>`, so the text after the last
 * one is left unread, and every `|` in what is read has a `>` after it.
 */
function labelsOnly(text: string): string {
  const end = text.lastIndexOf(">") + 1;
  const read = text.slice(0, end).replace(LABELLED, (whole, label?: string) => label ?? whole);
  return read + text.slice(end);
}

/**
 * The words of a text with the markup, the punctuation and the spacing gone: what two
 * renderings of one text (Claude's markdown and Slack's converted read-back of it, with `*b*`
 * for `**b**`, `<url|label>` for a link, `•` for a bullet) have in common.
 */
export function plainWords(text: string): string {
  const words = stripMarkdown(labelsOnly(text)).match(WORDS) ?? [];
  return words.join(" ").toLowerCase();
}

// A list item's first line; its length is where the item's own lines start.
const LIST_ITEM = /^ {0,3}(?:\d{1,9}[.)]|[-*+]) {1,4}(?=\S)/;
// A line that starts an item, read before the words after its marker have arrived.
const ITEM_START = /^(?:\d{1,9}[.)]|[-*+])(?: |$)/;
const ITEM_SO_FAR = /^(?:\d{1,9}[.)]?|[-*+])$/;
const FENCE_OPEN = /^(`{3,}|~{3,})/;
const FENCE_SO_FAR = /^(?:`{1,2}|~{1,2})$/;
const FENCE_CLOSE = /^(`{3,}|~{3,})[ \t]*$/;

/** How many spaces `line` starts with. */
function leading(line: string): number {
  let count = 0;
  while (line[count] === " ") count += 1;
  return count;
}

/**
 * Claude's markdown with every fenced code block that sits in a list item moved to the start of
 * the line, the item's lines after it with it, and a blank line before the item that follows.
 * Slack stores a fence indented under its item as the item's plain text, its lines run together;
 * moved, it is stored as code and the list goes on from the next number (measured 2026-10-22).
 * Any other text is left as written.
 *
 * For text still arriving (`whole` false), a line waits while it may still turn into a fence or
 * an item, so every later call starts with what this one returns.
 */
export function codeOutOfLists(text: string, whole: boolean): string {
  let out = "";
  // Where the open item's own lines start; whether one of its fences was moved; the fence open,
  // and whether it is one being moved (a fence outside any item keeps every line as written).
  let item: number | null = null;
  let moved = false;
  let fence: { indent: number; marks: string; moving: boolean } | null = null;
  let afterBlank = false;
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const complete = newline !== -1 || whole;
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(start, end);
    const lead = leading(line);
    const rest = line.slice(lead);
    let shown: string | null = line;
    if (fence !== null) {
      if (fence.moving) shown = line.slice(Math.min(fence.indent, lead));
    } else if (item !== null) {
      if (!complete && rest === "") shown = null;
      else if (lead >= item && lead - item <= 3 && FENCE_OPEN.test(rest)) shown = rest;
      else if (!complete && lead >= item && lead - item <= 3 && FENCE_SO_FAR.test(rest)) {
        shown = null;
      } else if (moved && lead <= 3 && ITEM_START.test(rest) && (complete || rest.includes(" "))) {
        shown = (out.endsWith("\n\n") ? "" : "\n") + line;
      } else if (moved && !complete && lead <= 3 && ITEM_SO_FAR.test(rest)) shown = null;
      else if (moved && lead > 0) shown = line.slice(Math.min(item, lead));
    }
    if (shown === null) break;
    out += shown;
    if (newline === -1) break;
    out += "\n";
    // What this line opens or ends, read once it is whole.
    if (fence !== null) {
      const close = FENCE_CLOSE.exec(line.slice(Math.min(fence.indent + 3, lead)));
      const marks = close?.[1] ?? "";
      if (marks[0] === fence.marks[0] && marks.length >= fence.marks.length) fence = null;
    } else if (item !== null && lead >= item && lead - item <= 3 && FENCE_OPEN.test(rest)) {
      fence = { indent: lead, marks: FENCE_OPEN.exec(rest)?.[1] ?? "", moving: true };
      moved = true;
    } else if (lead <= 3 && FENCE_OPEN.test(rest)) {
      // A fence of its own, outside any item: the list, if one was open, ends there.
      fence = { indent: lead, marks: FENCE_OPEN.exec(rest)?.[1] ?? "", moving: false };
      item = null;
      moved = false;
    } else {
      const opened = LIST_ITEM.exec(line);
      if (opened !== null) {
        item = opened[0].length;
        moved = false;
      } else if (afterBlank && lead === 0 && rest !== "") {
        item = null;
        moved = false;
      }
    }
    afterBlank = fence === null && rest === "";
    start = newline + 1;
  }
  return out;
}
