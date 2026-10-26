import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelLine, LINE_EVENT, lineLabel } from "../../../src/chat/slack/channel-line.ts";
import { FakeSlack, rejected } from "../../support/fake-slack.ts";
import type { JsonObject } from "../../support/fixtures.ts";

const CHANNEL = "C000PROJECT";
const BOT = "U000BOT";
const OWNER = "U000ALICE";
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
  // A thread nobody replied to opens on its root.
  assert.equal(fake.callsTo("chat.getPermalink")[0]?.message_ts, ROOT);
});

// #77: as the Home tab's Open, the line opens the thread on its last reply, the one it is about.
test("a thread with replies is linked by its last reply, its query escaped for mrkdwn", async () => {
  const fake = slack();
  const reply = "1792626300.000200";
  const link = `${LINK.replace(ROOT.replace(".", ""), "1792626300000200")}?thread_ts=${ROOT}&cid=${CHANNEL}`;
  fake.responses["conversations.replies"] = {
    ok: true,
    messages: [
      {
        ts: ROOT,
        user: "U000ALICE",
        text: "Fix the login page",
        reply_count: 3,
        latest_reply: reply,
      },
    ],
  };
  fake.responses["chat.getPermalink"] = { ok: true, channel: CHANNEL, permalink: link };
  await new ChannelLine(fake, { botUserId: BOT }).show(CHANNEL, ROOT, "done");
  assert.equal(fake.callsTo("chat.getPermalink")[0]?.message_ts, reply);
  const [posted] = fake.callsTo("chat.postMessage");
  assert.deepEqual(posted?.blocks, [
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `✅ Done: <${link.replaceAll("&", "&amp;")}|Fix the login page>`,
        },
      ],
    },
  ]);
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

// #84: a request is deleted once it is answered, and Slack then answers its link with "unable to
// open this link" (seen 2026-10-25, desktop) while the line still names it.
test("a waiting line links its request, and the thread's root once that request is gone", async () => {
  const fake = slack();
  const request = "1792626400.000300";
  const requestLink = `https://example.slack.com/archives/C000PROJECT/p1792626400000300?thread_ts=${ROOT}&cid=${CHANNEL}`;
  fake.responses["conversations.replies"] = {
    ok: true,
    messages: [
      { ts: ROOT, user: OWNER, text: "Fix the login page", latest_reply: "1792626300.000200" },
    ],
  };
  fake.responses["chat.getPermalink"] = [
    { ok: true, channel: CHANNEL, permalink: requestLink },
    { ok: true, channel: CHANNEL, permalink: LINK },
  ];
  fake.responses["chat.update"] = { ok: true };
  const lines = new ChannelLine(fake, { botUserId: BOT });
  await lines.show(CHANNEL, ROOT, "waiting", OWNER, request);
  assert.deepEqual(fake.callsTo("chat.postMessage")[0]?.blocks, [
    { type: "markdown", text: `✋ Waiting: [Fix the login page](${requestLink})` },
  ]);
  // Another message of the thread, or another thread's, leaves the line as it is.
  await lines.withdrawn(CHANNEL, ROOT, "1792626300.000200");
  await lines.withdrawn(CHANNEL, "1792626999.000001", request);
  assert.deepEqual(fake.callsTo("chat.update"), []);
  await lines.withdrawn(CHANNEL, ROOT, request);
  assert.deepEqual(
    fake.callsTo("chat.getPermalink").map((call) => call.message_ts),
    [request, ROOT],
  );
  const [updated, ...more] = fake.callsTo("chat.update");
  assert.deepEqual(more, []);
  assert.equal(updated?.ts, fake.createdTs[0]);
  // An edit pushes nothing (measured 2026-09-27): the word and the mention stay; the root's
  // status changes the word (`restate`).
  assert.equal(updated?.text, `Waiting: Fix the login page <@${OWNER}>`);
  assert.deepEqual(updated?.blocks, [
    { type: "markdown", text: `✋ Waiting: [Fix the login page](${LINK})` },
  ]);
  // On its root now: the same message deleted again edits nothing, and a title keeps the root.
  await lines.withdrawn(CHANNEL, ROOT, request);
  await lines.retitle(CHANNEL, ROOT, "*Login fix*");
  assert.deepEqual(fake.callsTo("chat.update").at(-1)?.blocks, [
    { type: "markdown", text: `✋ Waiting: [Login fix](${LINK})` },
  ]);
  assert.equal(fake.callsTo("chat.update").length, 2);
});

// A turn that fails with an approval open: the failed line opens that approval, the thread's
// last reply, and the approval is deleted after.
test("an ended line whose reply is deleted keeps its word, linked by the root", async () => {
  const fake = slack();
  const request = "1792626400.000300";
  fake.responses["conversations.replies"] = {
    ok: true,
    messages: [{ ts: ROOT, user: OWNER, text: "Fix the login page", latest_reply: request }],
  };
  fake.responses["chat.update"] = { ok: true };
  const lines = new ChannelLine(fake, { botUserId: BOT });
  await lines.show(CHANNEL, ROOT, "failed");
  await lines.withdrawn(CHANNEL, ROOT, request);
  assert.equal(fake.callsTo("chat.update").at(-1)?.text, "Failed: Fix the login page");
  assert.equal(fake.callsTo("chat.getPermalink").at(-1)?.message_ts, ROOT);
});

// #84: once the owner answered, the line said Waiting while the work went on (seen 2026-10-26).
test("a line follows its thread's root status by edits, linked by the root but while waiting", async () => {
  const fake = slack();
  const request = "1792626400.000300";
  const requestLink = `${LINK}?thread_ts=${ROOT}`;
  fake.responses["chat.getPermalink"] = [
    { ok: true, channel: CHANNEL, permalink: requestLink },
    { ok: true, channel: CHANNEL, permalink: LINK },
  ];
  fake.responses["chat.update"] = { ok: true };
  const lines = new ChannelLine(fake, { botUserId: BOT });
  await lines.show(CHANNEL, ROOT, "waiting", OWNER, request);
  // The same word, or another thread's status, edits nothing.
  await lines.restate(CHANNEL, ROOT, "waiting");
  await lines.restate(CHANNEL, "1792626999.000001", "working");
  await lines.restate("C000OTHER", ROOT, "working");
  assert.deepEqual(fake.callsTo("chat.update"), []);
  await lines.restate(CHANNEL, ROOT, "working");
  const updated = fake.callsTo("chat.update").at(-1);
  assert.equal(updated?.ts, fake.createdTs[0]);
  assert.equal(updated?.text, `Working: Fix the login page <@${OWNER}>`);
  assert.deepEqual(updated?.blocks, [
    { type: "markdown", text: `⏳ Working: [Fix the login page](${LINK})` },
  ]);
  // Waiting again (another request still open), then done by the owner's own stop: no post.
  await lines.restate(CHANNEL, ROOT, "waiting");
  await lines.restate(CHANNEL, ROOT, "done");
  assert.deepEqual(
    fake.callsTo("chat.update").map((call) => call.text),
    [
      `Working: Fix the login page <@${OWNER}>`,
      `Waiting: Fix the login page <@${OWNER}>`,
      `Done: Fix the login page <@${OWNER}>`,
    ],
  );
  assert.equal(fake.callsTo("chat.postMessage").length, 1);
  // A title keeps the word the status gave.
  await lines.retitle(CHANNEL, ROOT, "*Login fix*");
  assert.equal(fake.callsTo("chat.update").at(-1)?.text, `Done: Login fix <@${OWNER}>`);
});

test("a deleted request a later line no longer names leaves that line as it is", async () => {
  const fake = slack();
  const request = "1792626400.000300";
  const lines = new ChannelLine(fake, { botUserId: BOT });
  await lines.show(CHANNEL, ROOT, "waiting", undefined, request);
  await lines.show(CHANNEL, ROOT, "done");
  await lines.withdrawn(CHANNEL, ROOT, request);
  assert.deepEqual(fake.callsTo("chat.update"), []);
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

// A last reply Slack no longer has (deleted by hand) still leaves the thread its line, on its root.
test("a last reply that is gone is linked by the thread's root instead", async () => {
  const fake = slack();
  fake.responses["conversations.replies"] = {
    ok: true,
    messages: [{ ts: ROOT, user: "U000ALICE", text: "Fix", latest_reply: "1792626300.000200" }],
  };
  fake.responses["chat.getPermalink"] = [
    rejected("message_not_found"),
    { ok: true, channel: CHANNEL, permalink: LINK },
  ];
  await new ChannelLine(fake, { botUserId: BOT }).show(CHANNEL, ROOT, "done");
  assert.deepEqual(
    fake.callsTo("chat.getPermalink").map((call) => call.message_ts),
    ["1792626300.000200", ROOT],
  );
  const [posted] = fake.callsTo("chat.postMessage");
  assert.deepEqual(posted?.blocks, [
    { type: "context", elements: [{ type: "mrkdwn", text: `✅ Done: <${LINK}|Fix>` }] },
  ]);
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

// #20: with Slack's "Thread replies" notifications off, a mention in `text` pushes beside a
// markdown block and shows nowhere; beside a context block alone it stays silent (measured
// 2026-10-25, iOS).
test("a line that tells the owner of the work's end mentions him in its text alone", async () => {
  const fake = slack();
  fake.responses["chat.update"] = { ok: true };
  const lines = new ChannelLine(fake, { botUserId: BOT });
  await lines.show(CHANNEL, ROOT, "failed", OWNER);
  const [posted] = fake.callsTo("chat.postMessage");
  assert.equal(posted?.text, `Failed: Fix the login page <@${OWNER}>`);
  assert.deepEqual(posted?.blocks, [
    { type: "markdown", text: `❌ Failed: [Fix the login page](${LINK})` },
  ]);
  // A title keeps the line's form: an edit pushes nothing, and the next start finds it the same.
  await lines.retitle(CHANNEL, ROOT, "*Login fix*");
  const updated = fake.callsTo("chat.update").at(-1);
  assert.equal(updated?.text, `Failed: Login fix <@${OWNER}>`);
  assert.deepEqual(updated?.blocks, [
    { type: "markdown", text: `❌ Failed: [Login fix](${LINK})` },
  ]);
});

test("a root's mention sequence notifies nobody from the line, in its text or its blocks", async () => {
  for (const mention of [undefined, OWNER]) {
    const fake = slack();
    fake.responses["conversations.replies"] = {
      ok: true,
      messages: [{ ts: ROOT, user: OWNER, text: "&lt;!here&gt; ask <@U000BOB>" }],
    };
    await new ChannelLine(fake, { botUserId: BOT }).show(CHANNEL, ROOT, "done", mention);
    const [posted] = fake.callsTo("chat.postMessage");
    const text = String(posted?.text);
    assert.ok(text.startsWith("Done: &lt;!here&gt; ask &lt;@U000BOB&gt;"), text);
    const blocks = JSON.stringify(posted?.blocks);
    assert.ok(!blocks.includes("<!here") && !blocks.includes("<@U000BOB"), blocks);
  }
});
