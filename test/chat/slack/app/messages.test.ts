/** How a message's composer blocks are read into the text a word is read in (`unformatted`). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bareText, inboundMessage, unformatted } from "../../../../src/chat/slack/app/messages.ts";

// A composer message's blocks, as Slack stores them. Read back on 2026-10-07: a section with a
// `text` element in inline code, and a `rich_text_preformatted` part. The `bold` style and the
// `rich_text_quote` and `rich_text_list` part types are named by the Block Kit reference and were
// not read from a real message.
type Part = Record<string, unknown>;

function richText(...parts: Part[]): Part[] {
  return [{ type: "rich_text", block_id: "Rd58H", elements: parts }];
}

function part(leaves: Part[], kind = "rich_text_section"): Part {
  return { type: kind, elements: leaves };
}

function leaf(text: string, style: Record<string, boolean> = {}): Part {
  return { type: "text", text, ...(Object.keys(style).length > 0 ? { style } : {}) };
}

const CODE_BLOCK = { ...part([leaf("!goal tick")], "rich_text_preformatted"), border: 0 };

const unformattedCases: [string, unknown, string][] = [
  // The two shapes read back from Slack: inline code, and a code block.
  ["`!goal tick`", richText(part([leaf("!goal tick", { code: true })])), "!goal tick"],
  ["```!goal tick```\n", richText(CODE_BLOCK), "!goal tick"],
  // Only the first run is read in the blocks: what follows it comes from the text, with its own
  // formatting and its links as the owner sent them.
  [
    "`!goal` what is it?",
    richText(part([leaf("!goal", { code: true }), leaf(" what is it?")])),
    "!goal what is it?",
  ],
  [
    "*!goal* run `make test` see https://example.com/1",
    richText(
      part([leaf("!goal", { bold: true }), leaf(" run "), leaf("make test", { code: true })]),
    ),
    "!goal run `make test` see https://example.com/1",
  ],
  [
    "`!compact`\n```notes```",
    richText(
      part([leaf("!compact", { code: true })]),
      part([leaf("notes")], "rich_text_preformatted"),
    ),
    "!compact\n```notes```",
  ],
  // Anything before the `!` keeps the message a prompt, formatted or not.
  ["`\\!stop`", richText(part([leaf("\\!stop", { code: true })])), ""],
  ["say `!stop`", richText(part([leaf("say "), leaf("!stop", { code: true })])), ""],
  ["!stop", richText(part([leaf("!stop")])), ""], // no marks: `parseBang` reads the text
  // A quote and a list are not read through.
  ["> !stop", richText(part([leaf("!stop")], "rich_text_quote")), ""],
  ["• !stop", richText(part([part([leaf("!stop")])], "rich_text_list")), ""],
  // A text that does not read as marks, the run, the marks again: left alone.
  ["`!stop`", richText(part([leaf("!status", { code: true })])), ""],
  ["`!stop", richText(part([leaf("!stop", { code: true })])), ""],
  ["x`!stop`", richText(part([leaf("!stop", { code: true })])), ""],
  // No composer block: nothing tells a mark from a character the owner typed.
  ["`!stop`", [{ type: "section", text: { type: "mrkdwn", text: "`!stop`" } }], ""],
  ["`!stop`", [], ""],
  ["`!stop`", null, ""],
];

unformattedCases.forEach(([text, blocks, expected], index) => {
  test(`unformatted [${index + 1}: ${JSON.stringify(text)}]`, () => {
    assert.equal(unformatted(text, blocks), expected);
  });
});

// The composer's blocks for a word and its argument: the style sits in the blocks, the marks in
// the text (read back on 2026-10-07).
const bareCases: [string, unknown, string][] = [
  [
    "inline code",
    richText(part([leaf("!tag "), leaf("CVE-0000-00000", { code: true })])),
    "!tag CVE-0000-00000",
  ],
  [
    "inline code, a path",
    richText(part([leaf("!bind "), leaf("a/b", { code: true })])),
    "!bind a/b",
  ],
  // Bold, italic and strikethrough marks may be characters of a name: the typed text is read.
  ["bold", richText(part([leaf("!tag "), leaf("x", { bold: true })])), ""],
  ["italic", richText(part([leaf("!open "), leaf("__init__.py", { italic: true })])), ""],
  ["strike", richText(part([leaf("!open "), leaf("a", { strike: true })])), ""],
  [
    "code and bold together",
    richText(part([leaf("!tag "), leaf("x", { code: true, bold: true })])),
    "",
  ],
  // A code block after the word is not its argument.
  [
    "a code block",
    richText(part([leaf("!tag")]), part([leaf("name")], "rich_text_preformatted")),
    "",
  ],
  ["only a code block", richText(part([leaf("!tag name")], "rich_text_preformatted")), ""],
  // Anything but text is not read: the text as sent is the better reading.
  ["a link", richText(part([leaf("!open "), { type: "link", url: "https://example.com" }])), ""],
  ["a quote", richText(part([leaf("!tag x")], "rich_text_quote")), ""],
  ["no composer block", [{ type: "section" }], ""],
  ["no blocks", null, ""],
];

bareCases.forEach(([name, blocks, expected]) => {
  test(`bareText: ${name}`, () => {
    assert.equal(bareText(blocks), expected);
  });
});

function inbound(text: string, blocks: unknown) {
  // Only `text` and `blocks` are read before the content is asked for.
  return inboundMessage({} as never, {} as never, "C1", "1.1", "1.2", { text, blocks });
}

test("a message with a name in inline code reaches the core as typed and bare", () => {
  const message = inbound(
    "!tag `CVE-0000-00000`",
    richText(part([leaf("!tag "), leaf("CVE-0000-00000", { code: true })])),
  );
  assert.equal(message.text, "!tag `CVE-0000-00000`");
  assert.equal(message.bare, "!tag CVE-0000-00000");
});

test("a !fork prompt keeps its code span in the typed text", () => {
  const message = inbound(
    "!fork run `make test`",
    richText(part([leaf("!fork run "), leaf("make test", { code: true })])),
  );
  assert.equal(message.text, "!fork run `make test`");
});

test("a name in italic blocks is read from the typed text", () => {
  const message = inbound(
    "!open __init__.py",
    richText(part([leaf("!open "), leaf("__init__.py", { italic: true })])),
  );
  assert.equal(message.bare, message.text);
});
