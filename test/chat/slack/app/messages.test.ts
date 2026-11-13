/** How a message's composer blocks are read into the text a word is read in (`unformatted`). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { bareText, inboundMessage, unformatted } from "../../../../src/chat/slack/app/messages.ts";
import { unwrittenText } from "../../../../src/chat/slack/app/pasted.ts";

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

// Messages the owner sent with a reply's table and a reply's card pasted in, read back with
// `conversations.replies` on 2026-11-10 (#120): the fallback `text` drops the cells and the
// card's details.
const pasted = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/slack/300-replies-pasted-table-and-card.json", import.meta.url),
    "utf8",
  ),
);

test("a pasted table reaches the agent as a markdown table after the text", async () => {
  const { text, blocks } = pasted.table;
  const message = inbound(text, blocks);
  // Slack's fallback words are left out: the owner did not type them.
  assert.equal(message.text, "a pasted table");
  assert.equal(
    await message.content(),
    `a pasted table\n\n| Word | With space |\n| --- | --- |\n| one,two | \`code\` |`,
  );
});

test("a pasted table keeps a cell's link address and its code and bold marks", async () => {
  const { text, blocks } = pasted.styled;
  assert.equal(
    await inbound(text, blocks).content(),
    `${text}\n\n| Case | Value |\n| --- | --- |\n| emoji | ✅ |\n| link | example (https://example.com) |\n| code | \`npm test\` |\n| bold | **strong** |`,
  );
});

test("a pasted card reaches the agent with its details", async () => {
  const { text, blocks } = pasted.card;
  assert.equal(
    await inbound(text, blocks).content(),
    'Ran 1 shell command\n\n$ echo "task_card sample"',
  );
});

test("a message with no table or card is sent as typed", async () => {
  const message = inbound("hello", richText(part([leaf("hello")])));
  assert.equal(await message.content(), "hello");
});

// A mistyped !word over a pasted table, in inline code and as plain text, read back on 2026-11-12:
// with a table Slack's `text` moves the code span's trailing space outside its backticks and ends
// with `, with interactive elements`, so it no longer lines up with the composer's run.
const underWord = JSON.parse(
  readFileSync(
    new URL("../../../fixtures/slack/301-replies-pasted-table-under-word.json", import.meta.url),
    "utf8",
  ),
);

test("a !word in inline code over a pasted table is read from the composer's block", async () => {
  const { text, blocks } = underWord.code;
  const message = inbound(text, blocks);
  assert.equal(message.plain, "!importnt why does row 2 differ? ");
  assert.equal(message.bare, "!importnt why does row 2 differ? ");
  assert.equal(message.text, "`!importnt why does row 2 differ? `", "no fallback words");
  assert.match((await message.content()) as string, /\| Fruit \| Colour \|/);
});

test("a plain !word over a pasted table is read without Slack's fallback words", () => {
  const { text, blocks } = underWord.plain;
  const message = inbound(text, blocks);
  assert.equal(message.plain, "!importnt why does row 2 differ?");
  assert.equal(message.bare, "!importnt why does row 2 differ?");
  assert.equal(message.text, "!importnt why does row 2 differ?");
});

test("a pasted table first and the words after are read from the words' block", async () => {
  const { text, blocks } = pasted.table;
  const message = inbound(text, blocks);
  assert.equal(message.plain, "a pasted table");
  assert.match((await message.content()) as string, /^a pasted table\n\n\| Word/);
});

test("a command over a pasted table keeps its inline code, and an unmeasured element keeps Slack's text", () => {
  const table = underWord.code.blocks[1];
  const shell = inbound("`!!echo` `whoami` , with interactive elements", [
    richText(part([leaf("!!echo ", { code: false }), leaf("whoami", { code: true })]))[0],
    table,
  ]);
  assert.equal(shell.text, "!!echo `whoami`");
  const bold = inbound("*!importnt* x, with interactive elements", [
    richText(part([leaf("!importnt", { bold: true }), leaf(" x")]))[0],
    table,
  ]);
  assert.equal(bold.plain, "!importnt x");
  const sent = "two styles, with interactive elements";
  const both = inbound(sent, [
    richText(part([leaf("two styles", { bold: true, italic: true })]))[0],
    table,
  ]);
  assert.equal(both.text, sent, "a run in two styles is not rebuilt");
});

test("unwrittenText keeps a table's columns when a cell holds a pipe or a line break", () => {
  const cell = (text: string) => ({ type: "raw_text", text });
  const table = { type: "table", rows: [[cell("a|b"), cell("c\nd")], [cell("1")]] };
  assert.equal(unwrittenText([table]), "| a\\|b | c d |\n| --- | --- |\n| 1 |");
});
