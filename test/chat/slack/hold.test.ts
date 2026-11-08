import assert from "node:assert/strict";
import { test } from "node:test";
import { HOLD_CANCEL, HOLD_CONTINUE, holdBlocks } from "../../../src/chat/slack/hold.ts";

type Button = { action_id: string; value: string; style?: string; text: { text: string } };

function buttons(blocks: Record<string, unknown>[]): Button[] {
  const actions = blocks[1] as { elements: Button[] };
  return actions.elements;
}

test("the hold question names the link and carries the id on both buttons", () => {
  const blocks = holdBlocks("hold-1", "<https://example.slack.com/x|Session>");
  // Rich text, beside which the request's mention pushes (#163).
  assert.deepEqual(blocks[0], {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_section",
        elements: [
          { type: "text", text: "Another session is working in this folder: " },
          { type: "link", url: "https://example.slack.com/x", text: "Session" },
          { type: "text", text: ". Send anyway?" },
        ],
      },
    ],
  });
  const [send, keep] = buttons(blocks) as [Button, Button];
  assert.deepEqual([send.action_id, keep.action_id], [HOLD_CONTINUE, HOLD_CANCEL]);
  assert.deepEqual([send.value, keep.value], ["hold-1", "hold-1"]);
});

test("the hold question s buttons answer it in its own words", () => {
  // `Continue` beside the shorter `Cancel` made the second look the lesser choice,
  // and a button's width is its text. One `primary` in the set, as the button reference asks.
  const [send, keep] = buttons(holdBlocks("hold-1", "<https://example.slack.com/x|Session>")) as [
    Button,
    Button,
  ];
  assert.deepEqual([send.text.text, send.style], ["Send anyway", "primary"]);
  assert.deepEqual([keep.text.text, keep.style], ["Don't send", undefined]);
  assert.ok(Math.abs(Array.from(send.text.text).length - Array.from(keep.text.text).length) <= 1);
});

test("the hold question shows a link's label as written, and words with no link as text", () => {
  const heading = (link: string) =>
    (holdBlocks("hold-1", link)[0] as { elements: { elements: unknown[] }[] }).elements[0]
      ?.elements;
  assert.deepEqual(heading("<https://example.slack.com/x|A | B &amp; &lt;1&gt;>")?.[1], {
    type: "link",
    url: "https://example.slack.com/x",
    text: "A | B & <1>",
  });
  // The core's words when Slack gave no permalink, their code span as code.
  assert.deepEqual(heading("thread `1.2`")?.slice(1, 3), [
    { type: "text", text: "thread " },
    { type: "text", text: "1.2", style: { code: true } },
  ]);
});
