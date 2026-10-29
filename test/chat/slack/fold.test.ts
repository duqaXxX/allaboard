/**
 * Folding a message after a rewind: the message is read back with `conversations.replies`
 * (`oldest` and `latest` the message's own ts, `inclusive`: docs.slack.dev/reference/methods/
 * conversations.replies, read 2026-10-29) and rewritten with `chat.update` into one `task_card`
 * (block kit `task_card`: title, status, rich text details; same element as the run's card).
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { fitted, textOfMessage } from "../../../src/chat/slack/fold.ts";
import { CARD_TEXT_LIMIT } from "../../../src/chat/slack/reply/blocks.ts";
import { resetStatusFlags } from "../../../src/chat/slack/reply/status.ts";
import * as slackTexts from "../../../src/chat/slack/texts.ts";
import { CHANNEL, rejected, THREAD } from "../../support/fake-slack.ts";
import { madeChat } from "../../support/slack-chat.ts";

beforeEach(() => resetStatusFlags());

// biome-ignore lint/suspicious/noExplicitAny: Block Kit read in a test
type Json = Record<string, any>;

const TITLE = "Removed by rewind";

test("the text of a message is its blocks in order, and its fallback text when it has none", () => {
  const blocks = [
    { type: "markdown", text: "The **answer**" },
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: "a section" } },
    { type: "context", elements: [{ type: "mrkdwn", text: "a note" }] },
    {
      type: "rich_text",
      elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "rich" }] }],
    },
    {
      type: "task_card",
      title: "Ran 2 shell commands",
      details: {
        type: "rich_text",
        elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "ls" }] }],
      },
    },
    { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Go" } }] },
  ];
  assert.equal(
    textOfMessage({ blocks, text: "fallback" }),
    "The **answer**\n\na section\n\na note\n\nrich\n\nRan 2 shell commands\nls",
  );
  assert.equal(textOfMessage({ text: "fallback" }), "fallback");
  assert.equal(textOfMessage({ blocks: [{ type: "divider" }], text: "fallback" }), "fallback");
});

test("a text past the card's field is cut with a marker, within the field", () => {
  const short = "x".repeat(CARD_TEXT_LIMIT);
  assert.equal(fitted(short), short);
  const cut = fitted("y".repeat(CARD_TEXT_LIMIT + 1));
  assert.equal([...cut].length <= CARD_TEXT_LIMIT, true);
  assert.ok(cut.endsWith(slackTexts.FOLD_CUT));
});

test("fold reads the message back and rewrites it into one complete card with its text inside", async () => {
  const { slack, thread } = madeChat();
  await thread.notice("an answer to fold");
  const ts = slack.postedTs.at(-1);
  assert.ok(ts);
  assert.equal(await thread.fold(ts, TITLE), true);

  const [read] = slack.callsTo("conversations.replies");
  assert.equal(read?.channel, CHANNEL);
  assert.equal(read?.ts, THREAD);
  assert.equal(read?.limit, 1);
  assert.equal(read?.oldest, ts);
  assert.equal(read?.latest, ts);
  assert.equal(read?.inclusive, true);

  const [update] = slack.callsTo("chat.update");
  assert.equal(update?.channel, CHANNEL);
  assert.equal(update?.ts, ts);
  assert.equal(update?.text, TITLE);
  const blocks = update?.blocks as Json[];
  assert.equal(blocks.length, 1);
  const [card] = blocks;
  assert.equal(card?.type, "task_card");
  assert.equal(card?.title, TITLE);
  assert.equal(card?.status, "complete");
  // The id is fixed for the card's life, as the run's card's is.
  assert.equal(card?.block_id, `task-folded-${ts}`);
  assert.equal(card?.details.elements[0].elements[0].text, "an answer to fold");
});

test("fold of a message Slack no longer returns changes nothing and answers false", async () => {
  const { slack, thread } = madeChat();
  assert.equal(await thread.fold("1780000000.009999", TITLE), false);
  assert.deepEqual(slack.callsTo("chat.update"), []);
});

test("fold of a message Slack refuses to rewrite answers false", async () => {
  const { slack, thread } = madeChat();
  await thread.notice("an answer to fold");
  const ts = slack.postedTs.at(-1);
  assert.ok(ts);
  slack.responses["chat.update"] = rejected("message_not_found");
  assert.equal(await thread.fold(ts, TITLE), false);
});
