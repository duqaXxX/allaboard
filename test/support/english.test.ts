import assert from "node:assert/strict";
import { test } from "node:test";
import { commentBlocks, isNotEnglish, markdownParagraphs } from "./english.ts";

const ITALIAN_TEXT =
  "Questo è il demone che non risponde quando la sessione è già chiusa, per questo si riavvia.";
const ENGLISH_TEXT = "This is the daemon that does not answer when the session is closed.";

test("an Italian paragraph is not English", () => {
  assert.equal(isNotEnglish(ITALIAN_TEXT), true);
});

test("an English paragraph passes", () => {
  assert.equal(isNotEnglish(ENGLISH_TEXT), false);
});

test("Italian inside backticks or a fenced block passes", () => {
  assert.equal(isNotEnglish(`The text \`${ITALIAN_TEXT}\` is a literal.`), false);
  const doc = `Intro.\n\n\`\`\`\n${ITALIAN_TEXT}\n\`\`\`\n\nEnd.`;
  assert.equal(markdownParagraphs(doc).some(isNotEnglish), false);
});

test("one quoted Italian phrase inside an English paragraph passes", () => {
  const text = `${ENGLISH_TEXT} The owner wrote "non è il caso di farlo per questo" once.`;
  assert.equal(isNotEnglish(text), false);
});

test("comment blocks are the runs of consecutive comment lines", () => {
  const source = "/**\n * One.\n * Two.\n */\nconst x = 1;\n// Three.\n// Four.\nconst y = 2;\n";
  assert.deepEqual(commentBlocks(source), ["One.\nTwo.", "Three.\nFour."]);
});
