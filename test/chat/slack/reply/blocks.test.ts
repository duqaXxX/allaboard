import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskUpdate } from "../../../../src/chat/seam.ts";
import { cardBlock, cardFields } from "../../../../src/chat/slack/reply/blocks.ts";

function card(fields: Partial<TaskUpdate>): TaskUpdate {
  return {
    id: "c1",
    title: "Bash: ls",
    status: "complete",
    details: null,
    output: "README.md",
    name: "Bash",
    task: false,
    message: false,
    calls: 0,
    preview: null,
    folded: null,
    startedAt: null,
    ...fields,
  };
}

test("a call's card keeps its result to itself once it is done", () => {
  assert.equal(cardFields(card({})).output, undefined);
});

test("a message's card shows its words, the body that opens under its title", () => {
  const message = card({
    id: "message-1",
    title: "Message from mechanical",
    output: "Sat Oct 24 22:03:05 CEST 2026",
    name: "",
    task: true,
    message: true,
  });
  assert.equal(cardFields(message).output, "Sat Oct 24 22:03:05 CEST 2026");
  const block = cardBlock(message);
  assert.equal(block.title, "Message from mechanical");
  assert.ok(JSON.stringify(block.output).includes("Sat Oct 24 22:03:05 CEST 2026"));
});

test("a mention in a message's words notifies nobody", () => {
  const message = card({ output: "see <!channel> and <@U000BOB>", task: true, message: true });
  const shown = cardFields(message).output ?? "";
  assert.ok(!shown.includes("<!channel>") && !shown.includes("<@U000BOB>"), shown);
});

test("a card's block id is the one of its stream, and none past Slack's cap", () => {
  assert.equal(cardBlock(card({ id: "fold:c1" })).block_id, "task-fold:c1");
  // Slack refuses a block_id past 255 characters: the card goes without one.
  assert.equal(cardBlock(card({ id: "x".repeat(250) })).block_id, `task-${"x".repeat(250)}`);
  assert.equal(cardBlock(card({ id: "x".repeat(251) })).block_id, undefined);
});
