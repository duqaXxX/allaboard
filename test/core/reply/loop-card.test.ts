import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoopCard } from "../../../src/chat/seam.ts";
import { LoopReply } from "../../../src/core/reply/loop-card.ts";

const LAUNCH = "**Bash**(watch the build)\n⎿ Running in background";

/** A card over a thread that keeps what each write showed. */
function cardOf(): [LoopReply, LoopCard[]] {
  const shown: LoopCard[] = [];
  const thread = {
    loopCardLast: true,
    showLoop: async (card: LoopCard) => {
      shown.push(card);
    },
  };
  return [new LoopReply(thread, "Scheduled run · run 1", 0), shown];
}

test("a launch line written before the words stands apart from them", async () => {
  const [card, shown] = cardOf();
  await card.text(LAUNCH, { notice: true });
  await card.text("Started the watch.");
  card.setFinal("Started the watch.");
  await card.finish();
  assert.equal(shown.at(-1)?.text, `Started the watch.\n\n${LAUNCH}`);
});

test("the report of a task the run started replaces what the run showed, its launch line too", async () => {
  const [card, shown] = cardOf();
  await card.text(LAUNCH, { notice: true });
  card.setFinal("Started the watch.");
  await card.finish();
  card.rest();
  // The report turn: its end line is aside, then its words.
  await card.text('✓ Background command "watch the build" completed', { aside: true });
  await card.text("The build is green.");
  card.setFinal("The build is green.");
  await card.closeOut();
  assert.equal(shown.at(-1)?.text, "The build is green.");
});

test("a card at rest keeps the run's words until the report writes", async () => {
  const [card, shown] = cardOf();
  card.setFinal("Started the watch.");
  await card.finish();
  card.rest();
  await card.closeOut();
  assert.equal(shown.at(-1)?.text, "Started the watch.");
});
