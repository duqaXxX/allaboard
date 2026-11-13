/**
 * What a message's fallback `text` leaves out of its blocks. A block pasted into the composer
 * stays a block: a reply's table pastes as a `table` block, a reply's card as a `task_card`.
 * Slack's `text` for such a message drops the table's cells, writing `, with interactive
 * elements` at its end instead, and keeps a card's title without its details and output (measured
 * 2026-11-10 on desktop and iOS, read back with `conversations.replies`; no Slack page documents
 * the fallback, #120).
 *
 * Shapes read: `table` (`rows`, each a list of cells; a cell is `rich_text` or `raw_text`) per
 * the Block Kit reference (docs.slack.dev/reference/block-kit/blocks/table-block, read
 * 2026-11-10); `task_card` (`details`, `output`) as `fold.ts` reads it. A `raw_number` cell, whose fields the reference
 * does not give, reads as empty.
 */

import { isRecord } from "../../../values.ts";
import { richTextOf } from "../fold.ts";

// A cell's link and styles, measured on 2026-11-10 in a pasted reply's table: `link` with `url`
// and `text`, `text` with `style.code` or `style.bold`; `italic` and `strike` are the reference's
// other style names. A style becomes its markdown mark, so that code still reads as code.
const MARKS: ReadonlyArray<readonly [string, string]> = [
  ["code", "`"],
  ["bold", "**"],
  ["italic", "_"],
  ["strike", "~~"],
];
const SCHEME = /^(?:https?:\/\/|mailto:)/;

/** A cell's element as markdown: its text in its marks, a named link with its address. */
function inline(node: unknown): string {
  if (Array.isArray(node)) return node.map(inline).join("");
  if (!isRecord(node)) return "";
  if (node.type === "link" && typeof node.url === "string") {
    const label = typeof node.text === "string" ? node.text : "";
    // As `slackUnescape` reads a link in the typed text.
    return label === "" || node.url.replace(SCHEME, "") === label
      ? label || node.url
      : `${label} (${node.url})`;
  }
  if (typeof node.text !== "string" || node.type === "rich_text") return inline(node.elements);
  const style = isRecord(node.style) ? node.style : {};
  return MARKS.reduce(
    (text, [name, mark]) => (style[name] === true ? `${mark}${text}${mark}` : text),
    node.text,
  );
}

/** One cell's text on one line, a pipe in it escaped so that the row keeps its columns. */
function cellText(cell: unknown): string {
  return inline(cell).replaceAll("\n", " ").replaceAll("|", "\\|").trim();
}

/** A `table` block as a markdown table, its first row the header; empty for a table with no rows. */
function tableText(block: Record<string, unknown>): string {
  const rows = Array.isArray(block.rows) ? block.rows.filter(Array.isArray) : [];
  if (rows.length === 0) return "";
  const lines = rows.map((row) => `| ${row.map(cellText).join(" | ")} |`);
  const width = Math.max(...rows.map((row) => row.length));
  lines.splice(1, 0, `|${" --- |".repeat(width)}`);
  return lines.join("\n");
}

/**
 * The text of the blocks a message's `text` leaves out, in their order, each table and card
 * apart; empty when it has none.
 */
export function unwrittenText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .flatMap((block) => {
      if (!isRecord(block)) return [];
      if (block.type === "table") return [tableText(block)];
      // The title is in `text` already.
      if (block.type === "task_card")
        return [
          [block.details, block.output]
            .map((part) => richTextOf(part).join(""))
            .filter((part) => part !== "")
            .join("\n"),
        ];
      return [];
    })
    .filter((part) => part !== "")
    .join("\n\n");
}

/** The prompt of a message whose text is `sent`: what its `blocks` hold beyond it follows it. */
export function withPasted(sent: string, blocks: unknown): string {
  const unwritten = unwrittenText(blocks);
  return unwritten === "" ? sent : `${sent}\n\n${unwritten}`;
}
