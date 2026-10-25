import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelLine, LINE_EVENT, lineLabel } from "../../../src/chat/slack/channel-line.ts";
import { FakeSlack, rejected } from "../../support/fake-slack.ts";
import type { JsonObject } from "../../support/fixtures.ts";

const CHANNEL = "C000PROJECT";
const BOT = "U000BOT";
const ROOT = "1792626266.636909";
const LINK = "https://example.slack.com/archives/C000PROJECT/p1792626266636909";

function slack(history: JsonObject[] = []): FakeSlack {
  const fake = new FakeSlack();
  fake.responses["conversations.replies"] = {
    ok: true,
    messages: [{ ts: ROOT, user: "U000ALICE", text: "`[web]` *Fix the login page*" }],
  };
  fake.responses["chat.getPermalink"] = { ok: true, channel: CHANNEL, permalink: LINK };
  fake.responses["conversations.history"] = { ok: true, messages: history };
  fake.responses["chat.delete"] = { ok: true };
  return fake;
}

const line = (ts: string, user = BOT, event = LINE_EVENT) => ({
  ts,
  user,
  text: "Done: x",
  metadata: { event_type: event },
});

// Measured on a dev app on 2026-10-22: a new top-level message of the bot's made the channel
// bold; a thread reply, a mention or a reaction in a thread and an edit did not.
test("a done thread's line is posted at the bottom, linking the thread by its title", async () => {
  const fake = slack();
  await new ChannelLine(fake, { botUserId: BOT }).show(CHANNEL, ROOT, "done");
  const [posted] = fake.callsTo("chat.postMessage");
  assert.equal(posted?.channel, CHANNEL);
  assert.equal(posted?.thread_ts, undefined); // top level: what makes the channel unread
  assert.equal(posted?.text, "Done: Fix the login page");
  assert.deepEqual(posted?.blocks, [
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `✅ Done: <${LINK}|Fix the login page>` }],
    },
  ]);
  assert.deepEqual(posted?.metadata, { event_type: LINE_EVENT, event_payload: {} });
});

// #72: a thread blocked on the owner, with the mark its root shows (✋); the line it replaces goes,
// and a title written later keeps the word.
test("a waiting thread's line replaces the last one and keeps its word through a title", async () => {
  const fake = slack();
  fake.responses["chat.update"] = { ok: true };
  const lines = new ChannelLine(fake, { botUserId: BOT });
  await lines.show(CHANNEL, ROOT, "done");
  await lines.show(CHANNEL, ROOT, "waiting");
  const posted = fake.callsTo("chat.postMessage").at(-1);
  assert.equal(posted?.text, "Waiting: Fix the login page");
  assert.deepEqual(posted?.blocks, [
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `✋ Waiting: <${LINK}|Fix the login page>` }],
    },
  ]);
  assert.deepEqual(
    fake.callsTo("chat.delete").map((call) => call.ts),
    [fake.postedTs[0]],
  );
  await lines.retitle(CHANNEL, ROOT, "*Login fix*");
  assert.equal(fake.callsTo("chat.update").at(-1)?.text, "Waiting: Login fix");
});

// #43: the line read the root before the session's title reached it, and kept the owner's words.
test("a line posted before the thread's title names the thread by it once the root shows it", async () => {
  const fake = slack();
  fake.responses["conversations.replies"] = {
    ok: true,
    messages: [{ ts: ROOT, user: "U000ALICE", text: "the login page answers 500, fix it" }],
  };
  fake.responses["chat.update"] = { ok: true };
  const lines = new ChannelLine(fake, { botUserId: BOT });
  // Asked at once, as at a turn's end: the footer's line first, the title a moment later.
  await Promise.all([
    lines.show(CHANNEL, ROOT, "done"),
    lines.retitle(CHANNEL, ROOT, "*Fix the login page*"),
  ]);
  assert.equal(
    fake.callsTo("chat.postMessage")[0]?.text,
    "Done: the login page answers 500, fix it",
  );
  const [updated, ...more] = fake.callsTo("chat.update");
  assert.deepEqual(more, []);
  assert.equal(updated?.channel, CHANNEL);
  assert.equal(updated?.ts, fake.createdTs[0]);
  assert.equal(updated?.text, "Done: Fix the login page");
  assert.deepEqual(updated?.blocks, [
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `✅ Done: <${LINK}|Fix the login page>` }],
    },
  ]);
});

test("a title the line already shows, of another thread, or with no line, edits nothing", async () => {
  const fake = slack();
  fake.responses["conversations.replies"] = {
    ok: true,
    messages: [{ ts: ROOT, user: "U000ALICE", text: "`[web]` *Fix `parse_args` in cli.py*" }],
  };
  const lines = new ChannelLine(fake, { botUserId: BOT });
  await lines.retitle(CHANNEL, ROOT, "*Fix `parse_args` in cli.py*");
  await lines.show(CHANNEL, ROOT, "done");
  // The root's text names the thread as the line read it, its tag and marks aside.
  await lines.retitle(CHANNEL, ROOT, "`[web]` *Fix `parse_args` in cli.py*");
  await lines.retitle(CHANNEL, ROOT, "*Fix `parse_args` in cli.py*");
  await lines.retitle(CHANNEL, "1792626999.000001", "*Another thread*");
  await lines.retitle("C000OTHER", ROOT, "*Fix `parse_args` in cli.py*");
  assert.deepEqual(fake.callsTo("chat.update"), []);
});

test("a renamed line is renamed again by a later title, and a refused edit is only logged", async () => {
  const fake = slack();
  fake.responses["chat.update"] = [{ ok: true }, rejected("ratelimited"), { ok: true }];
  const said: string[] = [];
  const lines = new ChannelLine(fake, {
    botUserId: BOT,
    logger: { warning: (text: string) => said.push(text) } as never,
  });
  await lines.show(CHANNEL, ROOT, "done");
  await lines.retitle(CHANNEL, ROOT, "*Login page fix*");
  await lines.retitle(CHANNEL, ROOT, "*Login fix*");
  // Refused: the line still says what it said, and the same words asked again edit it.
  await lines.retitle(CHANNEL, ROOT, "*Login fix*");
  assert.deepEqual(
    fake.callsTo("chat.update").map((call) => call.text),
    ["Done: Login page fix", "Done: Login fix", "Done: Login fix"],
  );
  assert.equal(said.length, 1);
  assert.ok(said[0]?.includes("ratelimited"), said[0]);
});

test("a line deleted by hand is not edited again", async () => {
  const fake = slack();
  fake.responses["chat.update"] = rejected("message_not_found");
  const said: string[] = [];
  const lines = new ChannelLine(fake, {
    botUserId: BOT,
    logger: { warning: (text: string) => said.push(text) } as never,
  });
  await lines.show(CHANNEL, ROOT, "done");
  await lines.retitle(CHANNEL, ROOT, "*Login page fix*");
  await lines.retitle(CHANNEL, ROOT, "*Login fix*");
  assert.equal(fake.callsTo("chat.update").length, 1);
  assert.deepEqual(said, []);
});

test("the next line replaces the one before, which goes only once the new one is there", async () => {
  const fake = slack();
  const lines = new ChannelLine(fake, { botUserId: BOT });
  await lines.show(CHANNEL, ROOT, "done");
  await lines.show(CHANNEL, ROOT, "done");
  const [first, second] = fake.callsTo("chat.postMessage").map((_, i) => fake.createdTs[i]);
  assert.deepEqual(fake.callsTo("chat.delete"), [{ channel: CHANNEL, ts: first }]);
  assert.ok(second !== undefined && second !== first);
  // The history is read once, for the first line after a start.
  assert.equal(fake.callsTo("conversations.history").length, 1);
});

test("after a start, every line an earlier run left is deleted, and nothing else", async () => {
  const fake = slack([
    line("1792626300.000001"),
    line("1792626200.000001"),
    line("1792626250.000001", "U000ALICE"),
    line("1792626240.000001", BOT, "other_event"),
    { ts: "1792626230.000001", user: BOT, text: "a reply's message" },
  ]);
  await new ChannelLine(fake, { botUserId: BOT }).show(CHANNEL, ROOT, "done");
  assert.deepEqual(
    fake.callsTo("chat.delete").map((call) => call.ts),
    ["1792626300.000001", "1792626200.000001"],
  );
});

test("a failure is logged, never thrown, and the channel's next line still comes", async () => {
  const fake = slack();
  fake.responses["chat.getPermalink"] = [
    rejected("channel_not_found"),
    { ok: true, channel: CHANNEL, permalink: LINK },
  ];
  const said: string[] = [];
  const lines = new ChannelLine(fake, {
    botUserId: BOT,
    logger: { warning: (text: string) => said.push(text) } as never,
  });
  await lines.show(CHANNEL, ROOT, "done");
  await lines.show(CHANNEL, ROOT, "done");
  assert.equal(said.length, 1);
  assert.ok(said[0]?.includes("channel_not_found"), said[0]);
  assert.equal(fake.callsTo("chat.postMessage").length, 1);
});

test("an old line already gone is no failure", async () => {
  const fake = slack([line("1792626300.000001")]);
  fake.responses["chat.delete"] = rejected("message_not_found");
  const said: string[] = [];
  await new ChannelLine(fake, {
    botUserId: BOT,
    logger: { warning: (text: string) => said.push(text) } as never,
  }).show(CHANNEL, ROOT, "done");
  assert.deepEqual(said, []);
});

test("a thread is named by its title or first words, as text, never as markup", () => {
  assert.equal(lineLabel({ text: "*Fix the login page*" }), "Fix the login page");
  assert.equal(lineLabel({ text: "`[api]` first line\nsecond line" }), "first line");
  assert.equal(lineLabel({ text: "" }), "a thread");
  assert.equal(lineLabel(undefined), "a thread");
  assert.equal(lineLabel({ text: "x".repeat(200) }).length, 80);
  // A sequence written in the thread stays text inside the link (`mrkdwnEscape` at the post).
  assert.equal(lineLabel({ text: "tell &lt;!here&gt;" }), "tell <!here>");
});

test("an old line a delete failed for is deleted at the next change", async () => {
  const fake = slack();
  fake.responses["chat.delete"] = [rejected("ratelimited"), { ok: true }];
  const lines = new ChannelLine(fake, { botUserId: BOT, logger: { warning: () => {} } as never });
  await lines.show(CHANNEL, ROOT, "done");
  await lines.show(CHANNEL, ROOT, "done");
  await lines.show(CHANNEL, ROOT, "done");
  const [first, second] = fake.createdTs;
  assert.deepEqual(
    fake.callsTo("chat.delete").map((call) => call.ts),
    [first, first, second],
  );
});

test("lines asked for at once in one channel leave one line", async () => {
  const fake = slack();
  const lines = new ChannelLine(fake, { botUserId: BOT });
  await Promise.all([
    lines.show(CHANNEL, ROOT, "done"),
    lines.show(CHANNEL, ROOT, "done"),
    lines.show(CHANNEL, ROOT, "done"),
  ]);
  const posted = fake.createdTs;
  assert.equal(posted.length, 3);
  assert.deepEqual(
    fake.callsTo("chat.delete").map((call) => call.ts),
    posted.slice(0, 2),
  );
});

test("a long title is cut between characters, never inside one", () => {
  const label = lineLabel({ text: "🚀".repeat(100) });
  assert.equal(Array.from(label).length, 80);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(label), "no lone surrogate");
});
