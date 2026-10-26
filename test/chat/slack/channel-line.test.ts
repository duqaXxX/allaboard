import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ChannelLine,
  LABEL_LIMIT,
  LINE_EVENT,
  type LineKind,
  type LineThread,
  lineLabel,
  lineThread,
  rootKind,
} from "../../../src/chat/slack/channel-line.ts";
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

/** The context block a line is, small and grey, whose mrkdwn is `text`. */
const context = (text: string): JsonObject => ({
  type: "context",
  elements: [{ type: "mrkdwn", text }],
});

/** `link` as mrkdwn reads it: a reply's permalink carries a query, and `&` is markup there. */
const amp = (link: string) => link.replaceAll("&", "&amp;");

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
  assert.equal(posted?.text, "Status: Done: Fix the login page");
  assert.deepEqual(posted?.blocks, [
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `Status: ✅ Done: <${LINK}|Fix the login page>` }],
    },
  ]);
  // The thread it names, so the next run can take the line over: ids, no content.
  assert.deepEqual(posted?.metadata, {
    event_type: LINE_EVENT,
    event_payload: { root: ROOT, kind: "done" },
  });
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
          text: `Status: ✅ Done: <${link.replaceAll("&", "&amp;")}|Fix the login page>`,
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
  assert.equal(posted?.text, "Status: Waiting: Fix the login page");
  assert.deepEqual(posted?.blocks, [
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `Status: ✋ Waiting: <${LINK}|Fix the login page>` }],
    },
  ]);
  assert.deepEqual(
    fake.callsTo("chat.delete").map((call) => call.ts),
    [fake.postedTs[0]],
  );
  await lines.retitle(CHANNEL, ROOT, "*Login fix*");
  assert.equal(fake.callsTo("chat.update").at(-1)?.text, "Status: Waiting: Login fix");
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
  await lines.show(CHANNEL, ROOT, "waiting", request);
  assert.deepEqual(fake.callsTo("chat.postMessage")[0]?.blocks, [
    context(`Status: ✋ Waiting: <${amp(requestLink)}|Fix the login page>`),
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
  // An edit pushes nothing (measured 2026-09-27): the word stays; the root's status changes the
  // word (`refresh`).
  assert.equal(updated?.text, "Status: Waiting: Fix the login page");
  assert.deepEqual(updated?.blocks, [context(`Status: ✋ Waiting: <${LINK}|Fix the login page>`)]);
  // On its root now: the same message deleted again edits nothing, and a title keeps the root.
  await lines.withdrawn(CHANNEL, ROOT, request);
  await lines.retitle(CHANNEL, ROOT, "*Login fix*");
  assert.deepEqual(fake.callsTo("chat.update").at(-1)?.blocks, [
    context(`Status: ✋ Waiting: <${LINK}|Login fix>`),
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
  fake.responses["chat.getPermalink"] = [
    { ok: true, channel: CHANNEL, permalink: `${LINK}?thread_ts=${ROOT}` },
    { ok: true, channel: CHANNEL, permalink: LINK },
  ];
  fake.responses["chat.update"] = { ok: true };
  const lines = new ChannelLine(fake, { botUserId: BOT });
  await lines.show(CHANNEL, ROOT, "failed");
  await lines.withdrawn(CHANNEL, ROOT, request);
  assert.equal(fake.callsTo("chat.update").at(-1)?.text, "Status: Failed: Fix the login page");
  assert.equal(fake.callsTo("chat.getPermalink").at(-1)?.message_ts, ROOT);
});

test("a deleted request a later line no longer names leaves that line as it is", async () => {
  const fake = slack();
  const request = "1792626400.000300";
  const lines = new ChannelLine(fake, { botUserId: BOT });
  await lines.show(CHANNEL, ROOT, "waiting", request);
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
    "Status: Done: the login page answers 500, fix it",
  );
  const [updated, ...more] = fake.callsTo("chat.update");
  assert.deepEqual(more, []);
  assert.equal(updated?.channel, CHANNEL);
  assert.equal(updated?.ts, fake.createdTs[0]);
  assert.equal(updated?.text, "Status: Done: Fix the login page");
  assert.deepEqual(updated?.blocks, [
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `Status: ✅ Done: <${LINK}|Fix the login page>` }],
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
    ["Status: Done: Login page fix", "Status: Done: Login fix", "Status: Done: Login fix"],
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
    { type: "context", elements: [{ type: "mrkdwn", text: `Status: ✅ Done: <${LINK}|Fix>` }] },
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
  assert.equal(lineLabel({ text: "x".repeat(200) }).length, LABEL_LIMIT);
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
  assert.equal(Array.from(label).length, LABEL_LIMIT);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(label), "no lone surrogate");
});

// #88: a push from the channel opens the channel, one from the thread opens the thread
// (measured 2026-10-26, iOS): the thread tells the owner, the line mentions nobody.
test("a root's mention sequence notifies nobody from the line, in its text or its blocks", async () => {
  const fake = slack();
  fake.responses["conversations.replies"] = {
    ok: true,
    messages: [{ ts: ROOT, user: OWNER, text: "&lt;!here&gt; ask <@U000BOB>" }],
  };
  await new ChannelLine(fake, { botUserId: BOT }).show(CHANNEL, ROOT, "done");
  const [posted] = fake.callsTo("chat.postMessage");
  const text = String(posted?.text);
  assert.equal(text, "Status: Done: &lt;!here&gt; ask &lt;@U000BOB&gt;");
  const blocks = JSON.stringify(posted?.blocks);
  assert.ok(!blocks.includes("<!here") && !blocks.includes("<@U000BOB"), blocks);
  assert.ok(!text.includes("<@"), text);
});

// #88: one line names one thread, and a later event of another thread hid a thread that waited.
// Threads A (ROOT), B and C; each root's words name it.
const B = "1792626500.000500";
const C = "1792626600.000600";
const TITLES: Record<string, string> = {
  [ROOT]: "Thread A",
  [B]: "Thread B",
  [C]: "Thread C",
};
const rootLink = (ts: string) =>
  `https://example.slack.com/archives/C000PROJECT/p${ts.replace(".", "")}`;

/** What a thread is in `state.json`: its word, or "asks" for a root waiting on an approval. */
type Seen = LineKind | "asks" | null;

/** A channel whose threads' status `status` holds, as `state.json` would. */
function busy(status: Record<string, Seen>, logger?: never) {
  const fake = new FakeSlack();
  fake.responses["conversations.replies"] = (args: JsonObject) => ({
    ok: true,
    messages: [{ ts: String(args.ts), user: OWNER, text: TITLES[String(args.ts)] ?? "" }],
  });
  fake.responses["chat.getPermalink"] = (args: JsonObject) => ({
    ok: true,
    channel: CHANNEL,
    permalink: rootLink(String(args.message_ts)),
  });
  fake.responses["conversations.history"] = { ok: true, messages: [] };
  fake.responses["chat.delete"] = { ok: true };
  fake.responses["chat.update"] = { ok: true };
  const threads = {
    channels: () => [CHANNEL],
    of: (channel: string): LineThread[] =>
      channel === CHANNEL
        ? Object.entries(status).map(([thread, seen]) => ({
            thread,
            kind: seen === "asks" ? "waiting" : seen,
            asks: seen === "asks",
          }))
        : [],
  };
  const lines = new ChannelLine(fake, {
    botUserId: BOT,
    threads,
    ...(logger !== undefined && { logger }),
  });
  // As `state.json` announces it: the threads whose status changed.
  const changed = (...threads: string[]) =>
    lines.refresh(threads.map((thread) => ({ channel: CHANNEL, thread })));
  return { fake, lines, status, changed };
}

/** The last post or edit of the line. */
const last = (fake: FakeSlack) =>
  fake.apiCalls
    .filter((call) => call.method === "chat.postMessage" || call.method === "chat.update")
    .at(-1)?.args;

/** The words the line shows. */
const shown = (fake: FakeSlack) => {
  const [block] = (last(fake)?.blocks ?? []) as JsonObject[];
  if (block?.type === "rich_text") {
    const [section] = block.elements as JsonObject[];
    return ((section?.elements ?? []) as JsonObject[])
      .map((e) =>
        e.type === "emoji" ? `:${e.name}:` : e.type === "link" ? `[${e.text}](${e.url})` : e.text,
      )
      .join("");
  }
  const [element] = (block?.elements ?? []) as JsonObject[];
  return String(element?.text);
};

test("a thread that asks while another waits names the one that waited longest, and counts it", async () => {
  const { fake, lines, status, changed } = busy({ [ROOT]: "asks", [B]: null });
  await lines.show(CHANNEL, ROOT, "waiting", "1792626450.000450");
  // B asks: its question is posted before `state.json` holds its kind.
  status[B] = "working";
  await lines.show(CHANNEL, B, "waiting", "1792626550.000550");
  const posted = last(fake);
  // The text names B's own wait; the line names A, which waited first.
  assert.equal(posted?.text, "Status: Waiting: Thread B · +1");
  assert.deepEqual(posted?.blocks, [
    context(`Status: ✋ Waiting: <${rootLink(ROOT)}|Thread A> · +1`),
  ]);
  // A answered: B is the one that waits.
  status[ROOT] = "working";
  status[B] = "asks";
  await changed(ROOT, B);
  assert.equal(shown(fake), `Status: ✋ Waiting: <${rootLink(B)}|Thread B>`);
  // B answered: nothing waits.
  status[B] = "working";
  await changed(B);
  // Both work: the line counts them, naming neither.
  assert.equal(shown(fake), "Status: ⏳ Working: 2 threads");
  assert.equal(fake.callsTo("chat.postMessage").length, 2); // edits push nothing
});

test("a thread that ends while another waits is told, and the line names the one that waits", async () => {
  const { fake, lines, status, changed } = busy({ [ROOT]: "asks", [B]: "done" });
  await lines.show(CHANNEL, B, "done");
  // The push names B's end and counts the one that waits.
  assert.equal(last(fake)?.text, "Status: Done: Thread B · +1");
  assert.equal(shown(fake), `Status: ✋ Waiting: <${rootLink(ROOT)}|Thread A>`);
  // The owner's own `!stop` on A: its root says done, and nothing waits.
  status[ROOT] = "done";
  await changed(ROOT);
  assert.equal(shown(fake), `Status: ✅ Done: <${rootLink(ROOT)}|Thread A>`);
});

// #88: only a wait names a thread among several; work is counted, an end names its thread.
test("a waiting line answered while others work opens its root once the work ends", async () => {
  const request = "1792626450.000450";
  const { fake, lines, status, changed } = busy({ [ROOT]: "asks", [B]: "working" });
  await lines.show(CHANNEL, ROOT, "waiting", request);
  status[ROOT] = "working";
  await changed(ROOT);
  assert.equal(shown(fake), "Status: ⏳ Working: 2 threads");
  status[ROOT] = "done";
  status[B] = "done";
  await changed(ROOT, B); // ended with no post: the owner's own stop
  assert.equal(shown(fake), `Status: ✅ Done: <${rootLink(ROOT)}|Thread A>`);
});

test("threads at work are counted, and the last to end is named", async () => {
  const { fake, lines, status, changed } = busy({ [ROOT]: "working", [B]: "working" });
  await lines.show(CHANNEL, ROOT, "waiting", "1792626450.000450");
  status[ROOT] = "working";
  await changed(ROOT);
  assert.equal(shown(fake), "Status: ⏳ Working: 2 threads");
  status[ROOT] = "done";
  await lines.show(CHANNEL, ROOT, "done"); // A ends, B still works
  assert.equal(last(fake)?.text, "Status: Done: Thread A");
  assert.equal(shown(fake), "Status: ⏳ Working: 1 thread");
  status[B] = "done";
  await lines.show(CHANNEL, B, "done");
  assert.equal(shown(fake), `Status: ✅ Done: <${rootLink(B)}|Thread B>`);
  // Stopped by the owner, B's end posts nothing: the line names the thread it kept.
  status[B] = "working";
  await changed(B);
  assert.equal(shown(fake), "Status: ⏳ Working: 1 thread");
  status[B] = "done";
  await changed(B);
  assert.equal(shown(fake), `Status: ✅ Done: <${rootLink(B)}|Thread B>`);
});

test("a waiting line keeps the request it opens while it waits, and the root once answered", async () => {
  const request = "1792626450.000450";
  const { fake, lines, status, changed } = busy({ [ROOT]: "asks" });
  await lines.show(CHANNEL, ROOT, "waiting", request);
  await changed(ROOT); // the same status: nothing to write
  assert.deepEqual(fake.callsTo("chat.update"), []);
  status[ROOT] = "working";
  await changed(ROOT);
  assert.equal(shown(fake), "Status: ⏳ Working: 1 thread");
});

// The setup form, a `!!` command's confirmation, a same-folder hold: the root waits, on what the
// owner has just written; `lineThread` takes it for working.
test("a thread on the owner's own form neither counts nor heads the line as waiting", async () => {
  const { fake, lines } = busy({ [ROOT]: "done", [B]: "working" });
  await lines.show(CHANNEL, ROOT, "done");
  // The push tells of A's end; the line counts B at work.
  assert.equal(last(fake)?.text, "Status: Done: Thread A");
  assert.equal(shown(fake), "Status: ⏳ Working: 1 thread");
});

test("a waiting thread whose root is left as a tombstone is not counted", async () => {
  const { fake, lines, changed } = busy({ [ROOT]: "done", [B]: "asks", [C]: "asks" });
  await lines.show(CHANNEL, ROOT, "done");
  assert.equal(shown(fake), `Status: ✋ Waiting: <${rootLink(B)}|Thread B> · +1`);
  // B's root deleted by hand: its replies keep a tombstone in its place (measured 2026-10-20).
  const replies = fake.responses["conversations.replies"] as (args: JsonObject) => JsonObject;
  fake.responses["conversations.replies"] = (args: JsonObject) =>
    args.ts === B
      ? { ok: true, messages: [{ ts: B, subtype: "tombstone", text: "This message was deleted." }] }
      : replies(args);
  await changed(B);
  assert.equal(shown(fake), `Status: ✋ Waiting: <${rootLink(C)}|Thread C>`);
});

test("a waiting thread Slack did not answer for this time is still counted", async () => {
  const said: string[] = [];
  const logger = { warning: (text: string) => said.push(text) } as never;
  const { fake, lines } = busy({ [ROOT]: "done", [B]: "asks", [C]: "asks" }, logger);
  const replies = fake.responses["conversations.replies"] as (args: JsonObject) => JsonObject;
  fake.responses["conversations.replies"] = (args: JsonObject) =>
    args.ts === C ? rejected("ratelimited") : replies(args);
  await lines.show(CHANNEL, ROOT, "done");
  assert.equal(shown(fake), `Status: ✋ Waiting: <${rootLink(B)}|Thread B> · +1`);
  assert.ok(said[0]?.includes("ratelimited"), said[0]);
});

test("an event of a root left as a tombstone names only the threads that wait", async () => {
  const { fake, lines } = busy({ [ROOT]: "done", [B]: null });
  const replies = fake.responses["conversations.replies"] as (args: JsonObject) => JsonObject;
  fake.responses["conversations.replies"] = (args: JsonObject) =>
    args.ts === ROOT
      ? {
          ok: true,
          messages: [{ ts: ROOT, subtype: "tombstone", text: "This message was deleted." }],
        }
      : replies(args);
  await lines.show(CHANNEL, ROOT, "done");
  assert.deepEqual(fake.callsTo("chat.postMessage"), []); // nothing to tell
  const { fake: other, lines: others } = busy({ [ROOT]: "done", [B]: "asks" });
  other.responses["conversations.replies"] = fake.responses["conversations.replies"];
  await others.show(CHANNEL, ROOT, "done");
  assert.equal(shown(other), `Status: ✋ Waiting: <${rootLink(B)}|Thread B>`);
});

test("a waiting thread whose link Slack refuses leaves the event its own line", async () => {
  const said: string[] = [];
  const logger = { warning: (text: string) => said.push(text) } as never;
  const { fake, lines } = busy({ [ROOT]: "done", [B]: "asks" }, logger);
  const links = fake.responses["chat.getPermalink"] as (args: JsonObject) => JsonObject;
  fake.responses["chat.getPermalink"] = (args: JsonObject) =>
    args.message_ts === B ? rejected("ratelimited") : links(args);
  await lines.show(CHANNEL, ROOT, "done");
  assert.equal(shown(fake), `Status: ✅ Done: <${rootLink(ROOT)}|Thread A> · +1`);
  assert.ok(
    said.some((text) => text.includes("ratelimited")),
    said.join("\n"),
  );
});

test("a line whose root has no status any more, with nothing waiting, is deleted", async () => {
  const { fake, lines, status, changed } = busy({ [ROOT]: "asks" });
  await lines.show(CHANNEL, ROOT, "waiting", "1792626450.000450");
  status[ROOT] = null; // a hold cancelled before any turn: the root shows nothing
  await changed(ROOT);
  assert.deepEqual(
    fake.callsTo("chat.delete").map((call) => call.ts),
    [fake.createdTs[0]],
  );
});

test("a line whose thread is gone, with nothing waiting, is deleted", async () => {
  const { fake, lines, status, changed } = busy({ [ROOT]: "done" });
  await lines.show(CHANNEL, ROOT, "done");
  delete status[ROOT]; // deleted, or pruned
  await changed(ROOT);
  assert.deepEqual(
    fake.callsTo("chat.delete").map((call) => call.ts),
    [fake.createdTs[0]],
  );
  // No line: the next change posts nothing; the next event posts one as usual.
  status[B] = "asks";
  await changed(B);
  assert.deepEqual(fake.callsTo("chat.update"), []);
});

test("a title of the thread the line names renames it there", async () => {
  const { fake, lines } = busy({ [ROOT]: "done" });
  await lines.show(CHANNEL, ROOT, "done");
  await lines.retitle(CHANNEL, ROOT, "*Login fix*");
  await lines.retitle(CHANNEL, B, "*Not named*");
  assert.equal(shown(fake), `Status: ✅ Done: <${rootLink(ROOT)}|Login fix>`);
  assert.equal(fake.callsTo("chat.update").length, 1);
});

test("a long root is named by its first words", async () => {
  const { fake, lines } = busy({ [ROOT]: "done" });
  TITLES[ROOT] =
    "fammi una domanda con AskUserQuestion e poi dopo la mia risposta aspetta 60 secondi";
  try {
    await lines.show(CHANNEL, ROOT, "done");
  } finally {
    TITLES[ROOT] = "Thread A";
  }
  // Cut between words or not, one character short of the limit, then the ellipsis.
  assert.equal(last(fake)?.text, "Status: Done: fammi una domanda con AskUserQuestion e…");
});

test("after a start, the line an earlier run left is taken over and follows the threads", async () => {
  const { fake, lines } = busy({ [ROOT]: "working", [B]: "asks" });
  fake.responses["conversations.history"] = {
    ok: true,
    messages: [
      {
        ts: "1792626990.000100",
        user: BOT,
        text: "Status: Done: Thread A",
        metadata: {
          event_type: LINE_EVENT,
          event_payload: { root: ROOT, kind: "done" },
        },
      },
    ],
  };
  await lines.refresh();
  const [updated, ...more] = fake.callsTo("chat.update");
  assert.deepEqual(more, []);
  assert.equal(updated?.ts, "1792626990.000100");
  assert.deepEqual(updated?.blocks, [context(`Status: ✋ Waiting: <${rootLink(B)}|Thread B>`)]);
  assert.deepEqual(updated?.metadata, {
    event_type: LINE_EVENT,
    event_payload: { root: B, kind: "waiting" },
  });
  // The history is read once per channel and run.
  await lines.refresh();
  assert.equal(fake.callsTo("conversations.history").length, 1);
});

test("the lines an earlier run left below the one taken over go with the next post", async () => {
  const { fake, lines } = busy({ [ROOT]: "working" });
  const left = (ts: string) => ({
    ts,
    user: BOT,
    text: "Status: Done: Thread A",
    metadata: { event_type: LINE_EVENT, event_payload: { root: ROOT, kind: "done" } },
  });
  fake.responses["conversations.history"] = [
    rejected("ratelimited"), // refused once: looked for again at the next change
    { ok: true, messages: [left("1792626990.000100"), left("1792626980.000100")] },
  ];
  await lines.refresh();
  await lines.refresh();
  assert.equal(fake.callsTo("chat.update").at(-1)?.ts, "1792626990.000100");
  await lines.show(CHANNEL, ROOT, "done");
  assert.deepEqual(
    fake
      .callsTo("chat.delete")
      .map((call) => call.ts)
      .sort(),
    ["1792626980.000100", "1792626990.000100"],
  );
});

test("a line an earlier version left, which names no thread, stays as it is", async () => {
  const { fake, lines } = busy({ [ROOT]: "working" });
  fake.responses["conversations.history"] = {
    ok: true,
    messages: [line("1792626990.000100")],
  };
  await lines.refresh();
  assert.deepEqual(fake.callsTo("chat.update"), []);
});

test("with no threads to read, the line follows nothing", async () => {
  const fake = slack();
  const lines = new ChannelLine(fake, { botUserId: BOT });
  await lines.show(CHANNEL, ROOT, "waiting");
  const before = fake.apiCalls.length;
  await lines.refresh();
  await lines.refresh([{ channel: CHANNEL, thread: ROOT }]);
  assert.equal(fake.apiCalls.length, before);
});

test("a thread asks the owner while its root waits with an approval or a question open", () => {
  const entry = (
    status: string | null,
    kinds: Record<string, "question" | "approval" | "setup" | "hold" | "shell">,
  ) => ({
    status,
    ended: null,
    requestKinds: kinds,
  });
  assert.deepEqual(lineThread(B, entry("waiting", { "1.1": "setup", "1.2": "question" })), {
    thread: B,
    kind: "waiting",
    asks: true,
  });
  assert.equal(lineThread(B, entry("waiting", { "1.1": "approval" })).asks, true);
  // The owner's own form: the root waits, and the line takes it for working.
  for (const kind of ["setup", "hold", "shell"] as const) {
    assert.deepEqual(lineThread(B, entry("waiting", { "1.1": kind })), {
      thread: B,
      kind: "working",
      asks: false,
    });
  }
  // A request left open by an ended turn, until the repair takes it.
  assert.equal(lineThread(B, entry("working", { "1.1": "question" })).asks, false);
  // An answer that never reached the chat: the root shows ❌, nothing waits.
  assert.deepEqual(
    lineThread(B, { status: "waiting", ended: "error", requestKinds: { "1.1": "question" } }),
    { thread: B, kind: "failed", asks: false },
  );
});

test("a root's word is its end first, then its pending status, as the session index reads", () => {
  assert.equal(rootKind("working", "error"), "failed");
  assert.equal(rootKind("working", "done"), "done");
  assert.equal(rootKind("waiting", null), "waiting");
  assert.equal(rootKind("working", null), "working");
  assert.equal(rootKind(null, "done"), "done");
  assert.equal(rootKind(null, null), null);
});
