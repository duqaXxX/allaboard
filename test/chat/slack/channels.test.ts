/**
 * The lookup of a bound channel the cleanup is given. Moved with `channelLookup` from
 * `test/daemon.test.ts`, where it was tested while the function lived in `main.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { channelLookup, threadLookup } from "../../../src/chat/slack/channels.ts";
import { CHANNEL, FakeSlack, rejected, THREAD } from "../../support/fake-slack.ts";

test("the channel lookup answers gone only for channel_not_found", async () => {
  const slack = new FakeSlack();
  const lookup = channelLookup(slack, null);
  assert.equal(await lookup(CHANNEL), "there");
  slack.responses["conversations.info"] = rejected("ratelimited");
  await assert.rejects(
    lookup(CHANNEL),
    (error: unknown) => error instanceof Error && error.name === "ratelimited",
  );
});

// Measured 2026-11-05: the bot answers channel_not_found for a channel it was kicked from or
// never joined, which only the owner's token tells apart from a deleted one.
test("the bot's channel_not_found is gone only when the owner's token agrees", async () => {
  const bot = new FakeSlack();
  bot.responses["conversations.info"] = rejected("channel_not_found");
  const owner = new FakeSlack();

  // No owner client: kept, since a deleted channel and a removed bot look the same.
  assert.equal(await channelLookup(bot, null)(CHANNEL), "no answer");

  // The owner still sees it, archived or not: the bot was removed from a live channel.
  owner.responses["conversations.info"] = { ok: true, channel: { id: CHANNEL, is_member: true } };
  assert.equal(await channelLookup(bot, owner)(CHANNEL), "no answer");
  owner.responses["conversations.info"] = {
    ok: true,
    channel: { id: CHANNEL, is_archived: true },
  };
  assert.equal(await channelLookup(bot, owner)(CHANNEL), "no answer");

  // Deleted by hand: both tokens say so.
  owner.responses["conversations.info"] = rejected("channel_not_found");
  assert.equal(await channelLookup(bot, owner)(CHANNEL), "gone");

  // Any other owner failure is no answer, crossed with Slack's code.
  owner.responses["conversations.info"] = rejected("ratelimited");
  await assert.rejects(
    channelLookup(bot, owner)(CHANNEL),
    (error: unknown) => error instanceof Error && error.name === "ratelimited",
  );

  // The bot in the channel needs no owner call.
  bot.responses["conversations.info"] = { ok: true, channel: { id: CHANNEL, is_archived: true } };
  owner.responses["conversations.info"] = rejected("channel_not_found");
  assert.equal(await channelLookup(bot, owner)(CHANNEL), "there");
});

test("the thread lookup answers gone for thread_not_found and for a root that is a tombstone", async () => {
  const slack = new FakeSlack();
  const lookup = threadLookup(slack);
  const ref = { channel: CHANNEL, thread: THREAD };
  assert.equal(await lookup(ref), "there");
  slack.responses["conversations.replies"] = rejected("thread_not_found");
  assert.equal(await lookup(ref), "gone");
  // A root deleted while replies remain is returned with subtype tombstone (measured 2026-10-20).
  slack.responses["conversations.replies"] = {
    ok: true,
    messages: [
      {
        type: "message",
        subtype: "tombstone",
        text: "This message was deleted.",
        ts: THREAD,
        thread_ts: THREAD,
        reply_count: 2,
      },
    ],
    has_more: false,
  };
  assert.equal(await lookup(ref), "gone");
  // A live root with replies is there.
  slack.responses["conversations.replies"] = {
    ok: true,
    messages: [{ type: "message", text: "fix", ts: THREAD, thread_ts: THREAD, reply_count: 2 }],
    has_more: false,
  };
  assert.equal(await lookup(ref), "there");
  slack.responses["conversations.replies"] = rejected("ratelimited");
  await assert.rejects(
    lookup(ref),
    (error: unknown) => error instanceof Error && error.name === "ratelimited",
  );
});
