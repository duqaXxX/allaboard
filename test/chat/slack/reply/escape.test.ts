import assert from "node:assert/strict";
import { test } from "node:test";
import {
  markdownEscape,
  mrkdwnEscape,
  quietMentions,
  shownAsWritten,
} from "../../../../src/chat/slack/reply/escape.ts";

test("mrkdwn reads ampersand and angle brackets as markup, so they are escaped", () => {
  assert.equal(mrkdwnEscape("a & <b> c"), "a &amp; &lt;b&gt; c");
  // The ampersand goes first: the entities it writes are not escaped again.
  assert.equal(mrkdwnEscape("&lt;"), "&amp;lt;");
  assert.equal(mrkdwnEscape("plain *text* `code`"), "plain *text* `code`");
});

test("a markdown block's inline characters are each escaped with a backslash", () => {
  assert.equal(markdownEscape("a*b_c`d~e"), "a\\*b\\_c\\`d\\~e");
  assert.equal(markdownEscape("[x](y) {z} & \\"), "\\[x\\]\\(y\\) \\{z\\} \\& \\\\");
  assert.equal(markdownEscape("# + - . !"), "# + - . !");
});

test("model text is shown as written: no link can hide its target and no fence can close", () => {
  assert.equal(shownAsWritten("<https://example.com|safe>"), "&lt;https://example.com|safe&gt;");
  assert.equal(shownAsWritten("```"), "`​`​`​");
});

const Z = String.fromCodePoint(0x200b);

// Stored as broadcast and user elements when raw, as text with the space, in text, inline code,
// after an autolink and across lines alike (measured 2026-10-21, dev app, private channel).
test("every mention sequence that notifies gets a zero-width space after its bracket", () => {
  const cases: [string, string][] = [
    ["before <!here> after", `before <${Z}!here> after`],
    [
      "<!channel>, <!everyone>, <!subteam^S000TEAM>",
      `<${Z}!channel>, <${Z}!everyone>, <${Z}!subteam^S000TEAM>`,
    ],
    ["hi <@U000ALICE> there", `hi <${Z}@U000ALICE> there`],
    ["code `<!here>` end", `code \`<${Z}!here>\` end`],
    ["```\n<!HERE>\n```", `\`\`\`\n<${Z}!HERE>\n\`\`\``],
    ["<http://x`> <!here> `y`", `<http://x\`> <${Z}!here> \`y\``],
  ];
  for (const [text, quiet] of cases) assert.equal(quietMentions(text, true), quiet, text);
});

test("what notifies nobody is left as written", () => {
  for (const text of [
    "see <#C000TEST> now",
    "<!-- a comment --> and <!DOCTYPE html>",
    "Vec<String> and a < b && c > d",
    "<!date^1392734382^{date}|then>",
    "no bracket at all",
  ]) {
    assert.equal(quietMentions(text, true), text);
  }
});

test("text cut anywhere quiets to a prefix of what the whole text quiets to", () => {
  const texts = [
    "say <!here> then `<!channel>` and <@U000ALICE> done <!-- x --> <",
    "<!h<!here><!subteam^S1> <!everyone",
    "a <! <@ <!chan",
  ];
  for (const text of texts) {
    const whole = quietMentions(text, true);
    let last = "";
    for (let cut = 0; cut <= text.length; cut += 1) {
      const part = quietMentions(text.slice(0, cut), false);
      assert.ok(whole.startsWith(part), `${JSON.stringify(text)} cut at ${cut}`);
      assert.ok(part.startsWith(last), `${JSON.stringify(text)} cut at ${cut} shrank`);
      last = part;
    }
  }
});

test("an end that may still become a mention waits, and is quieted when nothing follows", () => {
  assert.equal(quietMentions("plain words", false), "plain words");
  assert.equal(quietMentions("before <", false), "before ");
  assert.equal(quietMentions("before <!he", false), "before ");
  assert.equal(quietMentions("before <!here", false), `before <${Z}!here`);
  assert.equal(quietMentions("before <!hex", false), "before <!hex");
  // Words added after the end would follow it in Slack: it is quieted all the same.
  assert.equal(quietMentions("before <", true), `before <${Z}`);
  assert.equal(quietMentions("before <!he", true), `before <${Z}!he`);
});

test("a title written inside a markdown block's formatting notifies nobody", () => {
  assert.equal(markdownEscape("Fix *this* <!here>"), `Fix \\*this\\* <${Z}!here>`);
});
