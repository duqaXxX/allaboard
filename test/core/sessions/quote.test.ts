/** A text quoted line by line: long lines wrapped before they are escaped and marked. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { QUOTE_WIDTH, quoted, wrapped } from "../../../src/core/sessions/quote.ts";

const same = (piece: string) => piece;

test("each line is marked, a blank one with the bare mark", () => {
  assert.equal(quoted("one\n\ntwo\r\nthree", same), "> one\n>\n> two\n> three");
});

test("the text is shown as it is: its own marks are not escaped", () => {
  assert.equal(quoted("# a *b*\n- c", same), "> # a *b*\n> - c");
});

test("a line past the width is wrapped at whitespace, every piece marked and escaped whole", () => {
  const line = "word ".repeat(6000).trimEnd(); // 30k characters in one line
  const out = quoted(line, same).split("\n");
  assert.ok(out.length >= 30);
  for (const piece of out) {
    assert.ok(piece.startsWith("> w"), piece.slice(0, 10));
    assert.ok(piece.length <= QUOTE_WIDTH + 2);
  }
});

test("the pieces of a wrapped line joined give the line back, whatever the whitespace", () => {
  for (const space of [" ", "\t", "\u00a0", "\u3000"]) {
    const line = Array.from({ length: 700 }, (_, n) => `w${n}`).join(space);
    const pieces = wrapped(line, 100);
    assert.ok(pieces.length > 1);
    assert.equal(pieces.join(""), line);
    for (const piece of pieces) assert.ok(piece.length <= 100);
    // Cut after a whitespace, which stays at the end of its piece.
    for (const piece of pieces.slice(0, -1)) assert.match(piece, /\s$/);
  }
});

test("a line with no whitespace is cut hard, and never inside a grapheme", () => {
  const cases = [
    "😀".repeat(QUOTE_WIDTH), // surrogate pairs
    "👨\u200d👩\u200d👧".repeat(300), // ZWJ sequences of 8 units
    "e\u0301".repeat(QUOTE_WIDTH), // letter and combining accent
  ];
  for (const line of cases) {
    const pieces = wrapped(line, QUOTE_WIDTH);
    assert.ok(pieces.length >= 2);
    assert.equal(pieces.join(""), line);
    for (const piece of pieces) {
      assert.ok(piece.length <= QUOTE_WIDTH, `${piece.length}`);
      // Every piece is whole graphemes: segmenting it alone gives the same graphemes.
      const own = [...new Intl.Segmenter().segment(piece)].length;
      assert.ok(own > 0 && piece.codePointAt(0) !== 0x301 && piece.codePointAt(0) !== 0x200d);
      assert.ok(!piece.endsWith("\u200d"));
    }
  }
  // A grapheme wider than the width goes whole rather than being cut.
  const wide = `a${"\u0301".repeat(50)}`;
  assert.deepEqual(wrapped(wide, 10), [wide]);
  // Even one far longer than the width plus any look-ahead is never cut inside.
  const huge = `a${"\u0301".repeat(QUOTE_WIDTH * 2)}`;
  assert.deepEqual(wrapped(huge, QUOTE_WIDTH), [huge]);
});

test("each piece of a wrapped line is escaped whole, after it is cut", () => {
  const line = `${"a<b ".repeat(400)}`.trimEnd();
  const out = quoted(line, (piece) => piece.replaceAll("<", "&lt;")).split("\n");
  assert.ok(out.length > 1);
  for (const piece of out) assert.ok(!piece.includes("<") && piece.startsWith("> "));
  assert.equal(out.map((piece) => piece.slice(2)).join(" "), line.replaceAll("<", "&lt;"));
});
