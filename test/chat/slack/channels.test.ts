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
  const lookup = channelLookup(slack);
  assert.equal(await lookup(CHANNEL), "there");
  slack.responses["conversations.info"] = rejected("channel_not_found");
  assert.equal(await lookup(CHANNEL), "gone");
  slack.responses["conversations.info"] = rejected("ratelimited");
  await assert.rejects(
    lookup(CHANNEL),
    (error: unknown) => error instanceof Error && error.name === "ratelimited",
  );
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
