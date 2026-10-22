import assert from "node:assert/strict";
import { test } from "node:test";
import { codeOutOfLists, plainWords } from "../../../../src/chat/slack/reply/markdown.ts";

// The pattern `plainWords` read a labelled link with until it was replaced, kept here as the
// definition of the result: quadratic on a run of `<`, and right on every input.
const LABELLED_BEFORE = /<[^|>]*\|([^>]*)>/g;

/** Every string of `length` characters over `alphabet`. */
function* strings(alphabet: string, length: number): Generator<string> {
  if (length === 0) {
    yield "";
    return;
  }
  for (const head of strings(alphabet, length - 1)) {
    for (const char of alphabet) yield head + char;
  }
}

test("a labelled link reads as its label, on every arrangement of its three marks", () => {
  // A label kept, dropped or cut shows in the words. Seven characters reach two links in a
  // row, a link in a link and a mark left open. With these six characters the words of a text
  // are its runs of letters, which is all the rest of `plainWords` has to do here.
  const alphabet = "<|>a b";
  let differing: string | null = null;
  for (let length = 0; length <= 7 && differing === null; length += 1) {
    for (const text of strings(alphabet, length)) {
      const words = text.replace(LABELLED_BEFORE, "$1").match(/[ab]+/g) ?? [];
      if (plainWords(text) !== words.join(" ")) {
        differing = text;
        break;
      }
    }
  }
  assert.equal(differing, null);
});

test("a link reads as its label and the text around it stays", () => {
  assert.equal(plainWords("see <https://example.com/a|the page> now"), "see the page now");
  assert.equal(plainWords("<a|>b"), "b"); // an empty label
  assert.equal(plainWords("x <a<b|label> y"), "x label y"); // the first `<` opens the link
  assert.equal(plainWords("one <two|three"), plainWords("one two three")); // never closed
});

for (const [name, text] of [
  ["a run of <", "<".repeat(200_000)],
  ["a run of <|", "<|".repeat(100_000)],
  ["a run of < closed once", `${"<".repeat(200_000)}>`],
  ["a run of <| closed once", `${"<|".repeat(100_000)}>`],
] as const) {
  test(`a text read back takes a time linear in its length [${name}]`, () => {
    // Measured 2026-10-11 on Node 26.5.1: 62 ms at 12,000 `<` and 660 ms at 40,000,
    // on the event loop every thread shares. At this length the pattern of then takes seconds.
    const began = performance.now();
    plainWords(text);
    assert.ok(performance.now() - began < 500);
  });
}

// A fence indented under its list item is stored as the item's plain text, its lines run
// together; at column 0, with the item's later lines there too and a blank line before the next
// item, it is stored as code and the list goes on from the next number (measured 2026-10-22,
// dev app, private channel, by post, stream and edit).
const IN_LIST = [
  "1. **Now:** run test A:",
  "   ```",
  "   php -d memory_limit=64M /tmp/p.php",
  "   cat /tmp/m",
  "   ```",
  "   Paste what it prints.",
  "2. Test B comes **later**.",
].join("\n");
const OUT_OF_LIST = [
  "1. **Now:** run test A:",
  "```",
  "php -d memory_limit=64M /tmp/p.php",
  "cat /tmp/m",
  "```",
  "Paste what it prints.",
  "",
  "2. Test B comes **later**.",
].join("\n");

test("a code block in a list item moves to the start of the line, and the list goes on", () => {
  assert.equal(codeOutOfLists(IN_LIST, true), OUT_OF_LIST);
  const bullets = "- a:\n  ~~~\n  x\n  ~~~\n- b";
  assert.equal(codeOutOfLists(bullets, true), "- a:\n~~~\nx\n~~~\n\n- b");
});

test("text with no code block in a list is left as written", () => {
  for (const text of [
    "1. one\n   two\n2. three",
    "intro\n```\n  indented code\n```\n- a\n- b",
    "- a\n\n```\nx\n```\nafter",
    "plain words, no list",
    // A list written as an example inside a code block of its own.
    "Example:\n```md\n1. a\n   ```js\n   x\n   ```\n2. b\n```\n",
  ]) {
    assert.equal(codeOutOfLists(text, true), text);
  }
});

test("text cut anywhere moves code to a prefix of what the whole text gives", () => {
  for (const text of [IN_LIST, `${IN_LIST}\n\nAfter the list.`, "- a:\n  ```\n  x\n  ```\n- b\n"]) {
    const whole = codeOutOfLists(text, true);
    let last = "";
    for (let cut = 0; cut <= text.length; cut += 1) {
      const part = codeOutOfLists(text.slice(0, cut), false);
      assert.ok(
        whole.startsWith(part),
        `${JSON.stringify(text)} cut at ${cut}: ${JSON.stringify(part)}`,
      );
      assert.ok(part.startsWith(last), `${JSON.stringify(text)} cut at ${cut} shrank`);
      last = part;
    }
  }
});

test("the items nested under a moved code block follow it out, and the list goes on", () => {
  const text = "1. a\n   ```\n   x\n   ```\n   - sub\n   - sub2\n2. b";
  assert.equal(codeOutOfLists(text, true), "1. a\n```\nx\n```\n- sub\n- sub2\n\n2. b");
});
