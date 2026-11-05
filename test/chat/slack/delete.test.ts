import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { PAGE, pinnedLine, ThreadDeleter } from "../../../src/chat/slack/delete.ts";
import * as slackTexts from "../../../src/chat/slack/texts.ts";
import { StateStore } from "../../../src/core/state.ts";
import { fill, named } from "../../../src/core/texts.ts";
import {
  type Answer,
  type Args,
  AsyncEvent,
  CHANNEL,
  FakeSlack,
  rejected,
} from "../../support/fake-slack.ts";
import type { JsonObject } from "../../support/fixtures.ts";
import { PLAIN_NAMES } from "../../support/names.ts";

const ROOT = "1790000000.000001";
const OWNER = "U000ALICE";
const BOT = "U000BOT";
const SESSION = "11111111-1111-4111-8111-111111111111";

const made: string[] = [];

after(() => {
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

/**
 * A thread's message as `conversations.replies` returns it, the fields the delete reads
 * (api-conversations-replies-by-ts.json: the bot's own carries `user` and `bot_id`).
 */
function message(ts: string, user: string): JsonObject {
  const found: JsonObject = { type: "message", ts, user, thread_ts: ROOT, text: "x" };
  return user === BOT ? { ...found, bot_id: "B000BOT" } : found;
}

/**
 * `conversations.replies` answering page by page: cursor pagination, the next page named in
 * `response_metadata.next_cursor` (docs.slack.dev/reference/methods/conversations.replies, read
 * 2026-10-05).
 */
function paged(...pages: JsonObject[][]): (args: Args) => Answer {
  return (args) => {
    const index = Number(args.cursor || 0);
    const more = index + 1 < pages.length;
    return {
      ok: true,
      messages: pages[index] ?? [],
      has_more: more,
      response_metadata: { next_cursor: more ? String(index + 1) : "" },
    };
  };
}

/** Let what is queued run: a few turns of the event loop, with no timer. */
async function settle(): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

class World {
  readonly bot = new FakeSlack();
  readonly owner = new FakeSlack();
  readonly state: StateStore;
  readonly deleter: ThreadDeleter;
  free = true;
  readonly released: [string, string][] = [];
  readonly freed: [string, string][] = [];

  constructor() {
    const directory = mkdtempSync(join(tmpdir(), "awd-delete-"));
    made.push(directory);
    this.state = new StateStore(join(directory, "state.json"));
    this.state.bind(CHANNEL, directory);
    this.state.openThread(CHANNEL, ROOT, SESSION);
    this.deleter = new ThreadDeleter(this.bot, this.owner, {
      botUserId: BOT,
      ownerUserId: OWNER,
      state: this.state,
      names: () => PLAIN_NAMES,
      release: async (channelId, threadTs) => {
        this.released.push([channelId, threadTs]);
        return this.free;
      },
      free: (channelId, threadTs) => void this.freed.push([channelId, threadTs]),
    });
  }

  deleted(client: FakeSlack): string[] {
    return client.callsTo("chat.delete").map((args) => String(args.ts));
  }
}

/**
 * `read`, until the owner's token deleted the thread's root: from then on Slack answers
 * `thread_not_found`, as for a root deleted with no replies (measured 2026-10-20).
 */
function untilRootGone(world: World, read: (args: Args) => Answer): (args: Args) => Answer {
  return (args) =>
    world.deleted(world.owner).includes(String(args.ts))
      ? rejected("thread_not_found")
      : read(args);
}

test("each message is deleted by its author s token and the root last", async () => {
  const world = new World();
  const root = message(ROOT, OWNER);
  const first = paged(
    [root, message("1790000001.000001", BOT), message("1790000002.000001", OWNER)],
    // Slack returns the root at the head of every page.
    [root, message("1790000003.000001", BOT)],
  );
  world.bot.responses["conversations.replies"] = untilRootGone(world, (args) =>
    world.deleted(world.bot).length === 0
      ? first(args)
      : { ok: true, messages: [root], has_more: false },
  );
  assert.equal(await world.deleter.delete(CHANNEL, ROOT), null);
  const asked = world.bot.callsTo("conversations.replies");
  // The whole thread once for its pins, before the session is released; then page by page, and
  // once more before the root goes: no reply is left. Once more after it: nothing is.
  assert.deepEqual(
    asked.map((a) => [a.ts, a.limit, a.cursor]),
    [
      [ROOT, PAGE, undefined],
      [ROOT, PAGE, "1"],
      [ROOT, PAGE, undefined],
      [ROOT, PAGE, "1"],
      [ROOT, PAGE, undefined],
      [ROOT, PAGE, undefined],
    ],
  );
  assert.deepEqual(world.deleted(world.bot), ["1790000001.000001", "1790000003.000001"]);
  assert.deepEqual(world.deleted(world.owner), ["1790000002.000001", ROOT]);
  assert.deepEqual(world.released, [[CHANNEL, ROOT]]);
  assert.deepEqual(world.freed, [[CHANNEL, ROOT]]); // the hold on the thread ends with the delete
  assert.equal(world.state.thread(CHANNEL, ROOT), null); // forgotten once the thread is gone
});

test("a thread in use is not deleted", async () => {
  const world = new World();
  world.free = false;
  assert.deepEqual(await world.deleter.delete(CHANNEL, ROOT), { reason: "busy" });
  // Only the root's pin was read; nothing was deleted.
  assert.deepEqual(world.bot.callsTo("chat.delete"), []);
  assert.deepEqual(world.owner.apiCalls, []);
  assert.notEqual(world.state.thread(CHANNEL, ROOT), null);
  // A refused release took no hold: the hold on the thread is another's (a deleted first message
  // being forgotten), and this delete must not end it.
  assert.deepEqual(world.freed, []);
});

test("a thread the daemon does not hold and that is no orphan is not touched", async () => {
  // The value of a click is untrusted: only a thread `state.json` holds, or an orphan of a bound
  // channel (`deletable`), is ever deleted.
  const world = new World();
  const other = "1790000009.000009";
  world.bot.responses["conversations.replies"] = orphanReplies(world, other, "U000BOB");
  assert.deepEqual(await world.deleter.delete(CHANNEL, other), { reason: "not-allaboard" });
  // A channel no longer bound has its own refusal.
  assert.deepEqual(await world.deleter.delete("C000NOPE", ROOT), { reason: "unbound" });
  // A thread already gone (a second confirm, a stale click) is gone, not refused.
  world.bot.responses["conversations.replies"] = rejected("thread_not_found");
  assert.equal(await world.deleter.delete(CHANNEL, other), null);
  // An answer with no root of that ts proves nothing: no silent success.
  world.bot.responses["conversations.replies"] = { ok: true, messages: [], has_more: false };
  assert.deepEqual(await world.deleter.delete(CHANNEL, other), { reason: "not-allaboard" });
  world.bot.responses["conversations.replies"] = {
    ok: true,
    messages: [orphanRoot("1790000009.000010", OWNER)],
    has_more: false,
  };
  assert.deepEqual(await world.deleter.delete(CHANNEL, other), { reason: "not-allaboard" });
  assert.deepEqual(world.released, []);
  assert.deepEqual(world.bot.callsTo("chat.delete"), []);
  assert.deepEqual(world.owner.apiCalls, []);
  assert.notEqual(world.state.thread(CHANNEL, ROOT), null);
});

/** A thread root with replies, as `conversations.replies` with `limit=1` returns it. */
function orphanRoot(ts: string, user: string, fields: JsonObject = {}): JsonObject {
  return { type: "message", ts, user, thread_ts: ts, text: "x", reply_count: 2, ...fields };
}

/** `conversations.replies` of a thread the daemon no longer holds, until its root is deleted. */
function orphanReplies(world: World, ts: string, user = OWNER, fields: JsonObject = {}) {
  return (args: Args): Answer =>
    world.deleted(world.owner).includes(String(args.ts))
      ? rejected("thread_not_found")
      : { ok: true, messages: [orphanRoot(ts, user, fields)], has_more: false };
}

test("a thread state.json holds is deletable, an orphan of a bound channel too", async () => {
  const world = new World();
  const orphan = "1790000060.000001";
  assert.equal(await world.deleter.deletable(CHANNEL, ROOT), null);
  assert.deepEqual(world.bot.apiCalls, []); // state.json says so: nothing is asked of Slack
  for (const [user, fields] of [
    [OWNER, {}],
    [BOT, {}],
    [OWNER, { subtype: "file_share" }],
    ["USLACKBOT", { subtype: "tombstone" }],
  ] as const) {
    world.bot.responses["conversations.replies"] = orphanReplies(world, orphan, user, fields);
    assert.equal(await world.deleter.deletable(CHANNEL, orphan), null, JSON.stringify(fields));
  }
});

const NOT_ALLABOARD = { reason: "not-allaboard" };

test("a thread someone else started, one with no reply, one gone, and an unbound channel say why", async () => {
  const world = new World();
  const orphan = "1790000061.000001";
  world.bot.responses["conversations.replies"] = orphanReplies(world, orphan, "U000BOB");
  assert.deepEqual(await world.deleter.deletable(CHANNEL, orphan), NOT_ALLABOARD);
  world.bot.responses["conversations.replies"] = orphanReplies(world, orphan, OWNER, {
    subtype: "bot_message",
  });
  assert.deepEqual(await world.deleter.deletable(CHANNEL, orphan), NOT_ALLABOARD);
  world.bot.responses["conversations.replies"] = {
    ok: true,
    messages: [orphanRoot(orphan, OWNER, { reply_count: 0 })],
    has_more: false,
  };
  assert.deepEqual(await world.deleter.deletable(CHANNEL, orphan), NOT_ALLABOARD);
  world.bot.responses["conversations.replies"] = rejected("thread_not_found");
  assert.equal(await world.deleter.deletable(CHANNEL, orphan), "gone");
  const calls = world.bot.apiCalls.length;
  assert.deepEqual(await world.deleter.deletable("C000NOPE", orphan), { reason: "unbound" });
  assert.equal(world.bot.apiCalls.length, calls, "an unbound channel is not asked about");
  world.bot.responses["conversations.replies"] = rejected("ratelimited");
  await assert.rejects(world.deleter.deletable(CHANNEL, orphan));
});

test("an orphan is deleted with the hold taken and freed, and a failed check is a failure", async () => {
  const world = new World();
  const orphan = "1790000062.000001";
  world.bot.responses["conversations.replies"] = orphanReplies(world, orphan);
  assert.equal(await world.deleter.delete(CHANNEL, orphan), null);
  assert.deepEqual(world.deleted(world.owner), [orphan]);
  assert.deepEqual(world.released, [[CHANNEL, orphan]]);
  assert.deepEqual(world.freed, [[CHANNEL, orphan]]);
  // `delete` never throws: a check Slack failed is a failure the owner reads.
  world.bot.responses["conversations.replies"] = rejected("ratelimited");
  assert.deepEqual(await world.deleter.delete(CHANNEL, "1790000063.000001"), {
    reason: "failed",
    error: "ratelimited",
  });
});

test("a message already gone does not stop the delete", async () => {
  const world = new World();
  const reply = message("1790000001.000001", BOT);
  world.bot.responses["conversations.replies"] = untilRootGone(world, () => ({
    ok: true,
    messages:
      world.deleted(world.bot).length === 0
        ? [message(ROOT, OWNER), reply]
        : [message(ROOT, OWNER)],
    has_more: false,
  }));
  world.bot.responses["chat.delete"] = rejected("message_not_found");
  world.owner.responses["chat.delete"] = rejected("message_not_found");
  assert.equal(await world.deleter.delete(CHANNEL, ROOT), null);
  assert.deepEqual(world.deleted(world.owner), [ROOT]);
  assert.equal(world.state.thread(CHANNEL, ROOT), null);
});

test("a failure stops the delete and keeps the thread", async () => {
  const world = new World();
  world.bot.responses["conversations.replies"] = paged([
    message(ROOT, OWNER),
    message("1790000001.000001", BOT),
    message("1790000002.000001", BOT),
  ]);
  world.bot.responses["chat.delete"] = rejected("internal_error");
  const refusal = await world.deleter.delete(CHANNEL, ROOT);
  assert.deepEqual(refusal, { reason: "failed", error: "internal_error" });
  assert.deepEqual(world.deleted(world.bot), ["1790000001.000001"]); // nothing after the failure
  assert.deepEqual(world.deleted(world.owner), []); // the root stays while a reply does
  assert.notEqual(world.state.thread(CHANNEL, ROOT), null); // asked again, it continues
  assert.deepEqual(world.freed, [[CHANNEL, ROOT]]); // held no longer: the thread can be used again
});

test("messages slack refuses to delete are counted and the root stays", async () => {
  const world = new World();
  // Someone else's message: tried with the owner's token, which Slack refuses.
  world.bot.responses["conversations.replies"] = paged([
    message(ROOT, OWNER),
    message("1790000001.000001", "U000BOB"),
    message("1790000002.000001", BOT),
    message("1790000003.000001", "U000OTHERAPP"),
  ]);
  world.owner.responses["chat.delete"] = rejected("cant_delete_message");
  const refusal = await world.deleter.delete(CHANNEL, ROOT);
  assert.deepEqual(refusal, { reason: "refused", count: 2 });
  assert.deepEqual(world.deleted(world.bot), ["1790000002.000001"]); // the rest still goes
  // the root was never tried: no reply is left under a deleted root
  assert.ok(!world.deleted(world.owner).includes(ROOT));
  assert.notEqual(world.state.thread(CHANNEL, ROOT), null);
});

test("a message that arrives while the thread goes is deleted before the root", async () => {
  const world = new World();
  const late = message("1790000009.000001", OWNER);
  const listed = [message(ROOT, OWNER), message("1790000001.000001", BOT)];
  let reads = 0;
  world.bot.responses["conversations.replies"] = untilRootGone(world, () => {
    reads += 1;
    // The first read is for the pins. The owner replies after the second: the third shows it.
    const found = reads <= 2 ? listed : reads === 3 ? [listed[0] as JsonObject, late] : [listed[0]];
    return { ok: true, messages: found as JsonObject[], has_more: false };
  });
  assert.equal(await world.deleter.delete(CHANNEL, ROOT), null);
  assert.deepEqual(world.deleted(world.bot), ["1790000001.000001"]);
  // the root last, with nothing under it
  assert.deepEqual(world.deleted(world.owner), [late.ts, ROOT]);
});

test("a root still shown after its delete is not called deleted", async () => {
  const world = new World();
  // The delete answers ok, and Slack goes on showing the root.
  world.bot.responses["conversations.replies"] = paged([message(ROOT, OWNER)]);
  assert.deepEqual(await world.deleter.delete(CHANNEL, ROOT), { reason: "left", count: 1 });
  assert.notEqual(world.state.thread(CHANNEL, ROOT), null);
});

test("a late reply slack refuses after the root went is counted as left", async () => {
  const world = new World();
  const late = message("1790000009.000001", BOT);
  const tombstone = { ...message(ROOT, "USLACKBOT"), subtype: "tombstone" };
  world.bot.responses["conversations.replies"] = () => ({
    ok: true,
    messages: world.deleted(world.owner).includes(ROOT)
      ? [tombstone, late]
      : [message(ROOT, OWNER)],
    has_more: false,
  });
  world.bot.responses["chat.delete"] = rejected("cant_delete_message");
  assert.deepEqual(await world.deleter.delete(CHANNEL, ROOT), { reason: "left", count: 1 });
});

test("a reply still shown after its delete keeps the root, and the delete can be asked again", async () => {
  const world = new World();
  const reply = message("1790000001.000001", BOT);
  // Every call answers ok, and Slack goes on showing the reply (#148).
  world.bot.responses["conversations.replies"] = paged([message(ROOT, OWNER), reply]);
  assert.deepEqual(await world.deleter.delete(CHANNEL, ROOT), { reason: "left", count: 1 });
  assert.deepEqual(world.deleted(world.owner), []); // the root stays above it
  assert.notEqual(world.state.thread(CHANNEL, ROOT), null);
  assert.deepEqual(world.freed, [[CHANNEL, ROOT]]);
  // The next ask finds the reply gone, and finishes.
  world.bot.responses["conversations.replies"] = untilRootGone(
    world,
    paged([message(ROOT, OWNER)]),
  );
  assert.equal(await world.deleter.delete(CHANNEL, ROOT), null);
  assert.deepEqual(world.deleted(world.owner), [ROOT]);
  assert.equal(world.state.thread(CHANNEL, ROOT), null);
});

test("a reply that came after the last read goes, and the tombstone is not counted", async () => {
  const world = new World();
  const late = message("1790000009.000001", BOT);
  const tombstone = { ...message(ROOT, "USLACKBOT"), subtype: "tombstone" };
  world.bot.responses["conversations.replies"] = () => {
    const rootGone = world.deleted(world.owner).includes(ROOT);
    if (!rootGone) return { ok: true, messages: [message(ROOT, OWNER)], has_more: false };
    return world.deleted(world.bot).includes(String(late.ts))
      ? { ok: true, messages: [tombstone], has_more: false }
      : { ok: true, messages: [tombstone, late], has_more: false };
  };
  assert.equal(await world.deleter.delete(CHANNEL, ROOT), null);
  assert.deepEqual(world.deleted(world.bot), [late.ts]);
  assert.equal(world.state.thread(CHANNEL, ROOT), null);
});

test("a delete asked again over a tombstone deletes its replies and never the tombstone", async () => {
  const world = new World();
  const reply = message("1790000001.000001", BOT);
  const tombstone = { ...message(ROOT, "USLACKBOT"), subtype: "tombstone" };
  world.bot.responses["conversations.replies"] = () =>
    world.deleted(world.bot).length === 0
      ? { ok: true, messages: [tombstone, reply], has_more: false }
      : rejected("thread_not_found");
  assert.equal(await world.deleter.delete(CHANNEL, ROOT), null);
  assert.deepEqual(world.deleted(world.bot), [reply.ts]);
  assert.deepEqual(world.deleted(world.owner), []);
  assert.equal(world.state.thread(CHANNEL, ROOT), null);
});

test("a failure that is not slack s answer is a failure too", async () => {
  const world = new World();
  world.bot.responses["conversations.replies"] = new Error("network down");
  const refusal = await world.deleter.delete(CHANNEL, ROOT);
  assert.equal(refusal?.reason, "failed");
  assert.notEqual(world.state.thread(CHANNEL, ROOT), null);
});

test("a thread whose root is gone is forgotten", async () => {
  const world = new World();
  world.bot.responses["conversations.replies"] = rejected("thread_not_found");
  assert.equal(await world.deleter.delete(CHANNEL, ROOT), null);
  assert.deepEqual(world.deleted(world.bot), []);
  assert.deepEqual(world.deleted(world.owner), []);
  assert.equal(world.state.thread(CHANNEL, ROOT), null);
});

test("threads are deleted one at a time", async () => {
  const world = new World();
  const other = "1790000100.000001";
  world.state.openThread(CHANNEL, other, SESSION);
  world.bot.responses["conversations.replies"] = untilRootGone(world, (args) => ({
    ok: true,
    messages: [message(String(args.ts), OWNER)],
    has_more: false,
  }));
  world.owner.gate = new AsyncEvent();
  world.owner.gateMethod = "chat.delete";
  const first = world.deleter.delete(CHANNEL, ROOT);
  await world.owner.gated.wait(); // the first delete is inside its call to Slack
  const second = world.deleter.delete(CHANNEL, other);
  const again = world.deleter.delete(CHANNEL, ROOT); // the same thread, twice
  await settle();
  assert.deepEqual(world.released, [[CHANNEL, ROOT]]); // the others have not started
  world.owner.gate.set();
  assert.deepEqual(await Promise.all([first, second, again]), [null, null, null]);
  assert.deepEqual(world.deleted(world.owner), [ROOT, other]); // the repeated one found nothing left
});

/** A pinned root as `conversations.replies` returns it (`pinned_to`, as tag.test.ts reads it). */
function pinnedRoot(tag: string | null): JsonObject {
  const text = tag === null ? "fix the footer" : `\`[${tag}]\` fix the footer`;
  const elements: JsonObject[] = [
    ...(tag === null
      ? []
      : [
          { type: "text", text: `[${tag}]`, style: { code: true } },
          { type: "text", text: " " },
        ]),
    { type: "text", text: "fix the footer" },
  ];
  return {
    ...message(ROOT, OWNER),
    text,
    blocks: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements }] }],
    pinned_to: [CHANNEL],
  };
}

for (const [tag, where] of [
  ["devops", "root"],
  [null, "root"],
] as const) {
  test(`a pinned root (${tag ?? "no tag"}) is refused, and nothing is touched`, async () => {
    const world = new World();
    world.bot.responses["conversations.replies"] = paged([pinnedRoot(tag)]);
    assert.deepEqual(await world.deleter.delete(CHANNEL, ROOT), { reason: "pinned", where });
    assert.deepEqual(world.released, []); // the live session is not closed for a refused delete
    assert.deepEqual(world.freed, []);
    assert.deepEqual(world.deleted(world.bot), []);
    assert.deepEqual(world.deleted(world.owner), []);
    assert.notEqual(world.state.thread(CHANNEL, ROOT), null);
  });
}

test("a tag alone does not keep a thread from a delete", async () => {
  const world = new World();
  const { pinned_to: _pin, ...tagged } = pinnedRoot("devops");
  world.bot.responses["conversations.replies"] = untilRootGone(world, paged([tagged]));
  assert.equal(await world.deleter.delete(CHANNEL, ROOT), null);
  assert.deepEqual(world.deleted(world.owner), [ROOT]);
});

test("a pinned reply refuses the delete before the session is released", async () => {
  const world = new World();
  const kept = { ...message("1790000002.000001", BOT), pinned_to: [CHANNEL] };
  world.bot.responses["conversations.replies"] = paged([
    message(ROOT, OWNER),
    message("1790000001.000001", BOT),
    kept,
  ]);
  assert.deepEqual(await world.deleter.delete(CHANNEL, ROOT), { reason: "pinned", where: "reply" });
  assert.deepEqual(world.released, []);
  assert.deepEqual(world.deleted(world.bot), []);
  assert.deepEqual(world.deleted(world.owner), []);
  assert.notEqual(world.state.thread(CHANNEL, ROOT), null);
});

test("a reply pinned while the thread goes is kept, and so is the root", async () => {
  const world = new World();
  const first = message("1790000001.000001", BOT);
  const late: JsonObject = { ...message("1790000002.000001", OWNER), pinned_to: [CHANNEL] };
  let reads = 0;
  world.bot.responses["conversations.replies"] = () => {
    // The first read is for the pin before the release: nothing is pinned yet.
    reads += 1;
    const pinnedNow = reads >= 2;
    return {
      ok: true,
      messages: [
        message(ROOT, OWNER),
        first,
        pinnedNow ? late : message("1790000002.000001", OWNER),
      ],
      has_more: false,
    };
  };
  assert.deepEqual(await world.deleter.delete(CHANNEL, ROOT), { reason: "pinned", where: "reply" });
  assert.deepEqual(world.deleted(world.bot), [first.ts]); // what is not pinned still goes
  assert.deepEqual(world.deleted(world.owner), []); // neither the pinned reply nor the root
  assert.notEqual(world.state.thread(CHANNEL, ROOT), null);
  assert.deepEqual(world.freed, [[CHANNEL, ROOT]]);
});

test("a reply pinned in one read and unpinned in the next still keeps the root", async () => {
  const world = new World();
  const reply = "1790000002.000001";
  let reads = 0;
  world.bot.responses["conversations.replies"] = () => {
    // Pinned only in the second read, the pass that skips it; unpinned in every later one.
    reads += 1;
    const late: JsonObject =
      reads === 2 ? { ...message(reply, OWNER), pinned_to: [CHANNEL] } : message(reply, OWNER);
    return { ok: true, messages: [message(ROOT, OWNER), late], has_more: false };
  };
  assert.deepEqual(await world.deleter.delete(CHANNEL, ROOT), { reason: "pinned", where: "reply" });
  assert.deepEqual(world.deleted(world.owner), []); // no reply is left under a deleted root
  assert.notEqual(world.state.thread(CHANNEL, ROOT), null);
});

test("a root pinned while the thread goes is kept", async () => {
  const world = new World();
  const first = message("1790000001.000001", BOT);
  let reads = 0;
  world.bot.responses["conversations.replies"] = () => {
    reads += 1;
    const root = reads >= 2 ? pinnedRoot(null) : message(ROOT, OWNER);
    return { ok: true, messages: [root, first], has_more: false };
  };
  assert.deepEqual(await world.deleter.delete(CHANNEL, ROOT), { reason: "pinned", where: "root" });
  assert.deepEqual(world.deleted(world.bot), [first.ts]);
  assert.deepEqual(world.deleted(world.owner), []);
  assert.notEqual(world.state.thread(CHANNEL, ROOT), null);
});

test("a pin added after the question is caught by the next delete", async () => {
  const world = new World();
  world.bot.responses["conversations.replies"] = paged([message(ROOT, OWNER)]);
  assert.equal(await world.deleter.pinned(CHANNEL, ROOT), null);
  world.bot.responses["conversations.replies"] = paged([pinnedRoot(null)]);
  assert.deepEqual(await world.deleter.delete(CHANNEL, ROOT), { reason: "pinned", where: "root" });
});

test("the two pinned lines are worded for what is pinned", () => {
  assert.equal(
    pinnedLine({ reason: "pinned", where: "root" }, PLAIN_NAMES),
    named(slackTexts.DELETE_PINNED_ROOT, PLAIN_NAMES),
  );
  assert.equal(
    pinnedLine({ reason: "pinned", where: "reply" }, PLAIN_NAMES),
    named(slackTexts.DELETE_PINNED_REPLY, PLAIN_NAMES),
  );
});

test("a root whose pin cannot be read is a failure, and the thread stays", async () => {
  const world = new World();
  world.bot.responses["conversations.replies"] = rejected("internal_error");
  assert.deepEqual(await world.deleter.delete(CHANNEL, ROOT), {
    reason: "failed",
    error: "internal_error",
  });
  assert.deepEqual(world.freed, []);
});

/**
 * A channel's message as `conversations.history` returns it: the message object of
 * 006-event_callback-message.json, and for a thread's parent the `thread_ts` and `reply_count`
 * of api-conversations-replies-root.json (a threaded message is detected "by looking for a
 * `thread_ts` value", docs.slack.dev/messaging/retrieving-messages, read 2026-10-05).
 */
function loose(ts: string, user: string, text: string, fields: JsonObject = {}): JsonObject {
  const found: JsonObject = { type: "message", ts, user, text, ...fields };
  return user === BOT ? { ...found, bot_id: "B000BOT" } : found;
}

test("a clean up deletes what has no reply outside a thread", async () => {
  const world = new World();
  const waiting = "1790000050.000001";
  const emptied = "1790000013.000001";
  const orphan = "1790000014.000001"; // a thread with replies whose session is gone
  world.state.openThread(CHANNEL, waiting); // a thread of the daemon's, no reply yet
  const pages = [
    [
      loose("1790000010.000001", OWNER, "!stop"),
      loose("1790000011.000001", BOT, "Stopped what was running in this channel."),
      loose("1790000012.000001", OWNER, "a prompt nobody answered"),
      loose(ROOT, OWNER, "fix the footer", { thread_ts: ROOT, reply_count: 19 }),
      // A parent keeps `thread_ts` once every reply is deleted.
      loose(emptied, OWNER, "a prompt whose replies are gone", { thread_ts: emptied }),
    ],
    [
      loose(orphan, OWNER, "an old thread", { thread_ts: orphan, reply_count: 4 }),
      loose("1790000015.000001", "U000BOB", "!stop"),
      loose("1790000016.000001", "U000BOB", "joined", { subtype: "channel_join" }),
      loose("1790000018.000001", OWNER, "renamed", { subtype: "group_name" }),
      loose("1790000019.000001", OWNER, "pinned", {
        subtype: "channel_name",
        pinned_to: [CHANNEL],
      }),
      loose("1790000020.000001", OWNER, "a pin", { subtype: "pinned_item" }),
      loose(waiting, OWNER, "a prompt whose setup is open"),
      // A reply also sent to the channel belongs to its thread.
      loose("1790000017.000001", BOT, "done", { thread_ts: ROOT, subtype: "thread_broadcast" }),
    ],
  ];
  world.bot.responses["conversations.history"] = paged(...pages);
  // Asked of the thread itself, a root with a reply carries `reply_count` and one with none
  // does not (api-conversations-replies-root.json, and the Home's measure of 2026-10-01).
  const roots: Record<string, JsonObject> = {
    [orphan]: loose(orphan, OWNER, "an old thread", { thread_ts: orphan, reply_count: 4 }),
    [emptied]: loose(emptied, OWNER, "a prompt whose replies are gone", { thread_ts: emptied }),
  };
  world.bot.responses["conversations.replies"] = (args) => ({
    ok: true,
    messages: [roots[String(args.ts)] as JsonObject],
    has_more: false,
  });
  assert.equal(
    await world.deleter.clean(CHANNEL),
    fill(slackTexts.HOME_CLEAN_DONE, { deleted: 6 }),
  );
  const asked = world.bot.callsTo("conversations.history");
  assert.deepEqual(
    asked.map((a) => [a.channel, a.limit, a.cursor]),
    [
      [CHANNEL, PAGE, undefined],
      [CHANNEL, PAGE, "1"],
    ],
  );
  // Only a message that carries `thread_ts` and that `state.json` does not hold is asked
  // about, its root alone.
  const checked = world.bot.callsTo("conversations.replies");
  assert.deepEqual(
    checked.map((a) => [a.ts, a.limit]),
    [
      [emptied, 1],
      [orphan, 1],
    ],
  );
  assert.deepEqual(world.deleted(world.owner), [
    "1790000010.000001",
    "1790000012.000001",
    emptied,
    "1790000016.000001",
    "1790000018.000001",
  ]);
  assert.deepEqual(world.deleted(world.bot), ["1790000011.000001"]);
  assert.notEqual(world.state.thread(CHANNEL, ROOT), null);
  assert.deepEqual(world.released, []);
});

test("a clean up keeps a pinned message, whoever wrote it", async () => {
  const world = new World();
  world.bot.responses["conversations.history"] = paged([
    loose("1790000010.000001", OWNER, "a note kept by hand", { pinned_to: [CHANNEL] }),
    loose("1790000011.000001", BOT, "a pinned bot line", { pinned_to: [CHANNEL] }),
    loose("1790000012.000001", OWNER, "a prompt nobody answered", { pinned_to: [] }),
  ]);
  assert.equal(
    await world.deleter.clean(CHANNEL),
    fill(slackTexts.HOME_CLEAN_DONE, { deleted: 1 }),
  );
  assert.deepEqual(world.deleted(world.owner), ["1790000012.000001"]);
  assert.deepEqual(world.deleted(world.bot), []);
});

const UNKNOWN_THREADS: [string, JsonObject | Error][] = [
  ["no root in the answer: no proof", { ok: true, messages: [], has_more: false }],
  ["gone meanwhile", rejected("thread_not_found")],
];

for (const [name, answer] of UNKNOWN_THREADS) {
  test(`a message with thread_ts is kept unless its thread is known empty [${name}]`, async () => {
    const world = new World();
    world.state.removeThread(CHANNEL, ROOT);
    world.bot.responses["conversations.history"] = paged([
      loose(ROOT, OWNER, "fix the footer", { thread_ts: ROOT }),
    ]);
    world.bot.responses["conversations.replies"] = answer;
    assert.equal(
      await world.deleter.clean(CHANNEL),
      fill(slackTexts.HOME_CLEAN_DONE, { deleted: 0 }),
    );
    assert.deepEqual(world.deleted(world.owner), []);
    assert.deepEqual(world.deleted(world.bot), []);
  });
}

test("a thread that cannot be asked about stops the clean up", async () => {
  const world = new World();
  world.state.removeThread(CHANNEL, ROOT);
  world.bot.responses["conversations.history"] = paged([
    loose(ROOT, OWNER, "fix the footer", { thread_ts: ROOT }),
  ]);
  world.bot.responses["conversations.replies"] = rejected("ratelimited");
  assert.equal(
    await world.deleter.clean(CHANNEL),
    fill(slackTexts.HOME_CLEAN_FAILED, { error: "ratelimited", deleted: 0, count: 0 }),
  );
  assert.deepEqual(world.deleted(world.owner), []);
});

test("a clean up of a channel that is not bound reads nothing", async () => {
  const world = new World();
  assert.equal(await world.deleter.clean("C000NOPE"), null);
  assert.deepEqual(world.bot.apiCalls, []);
  assert.deepEqual(world.owner.apiCalls, []);
});

test("a clean up that slack stops says so", async () => {
  const world = new World();
  world.bot.responses["conversations.history"] = paged([
    loose("1790000010.000001", OWNER, "!stop"),
    loose("1790000011.000001", BOT, "Stopped."),
  ]);
  world.owner.responses["chat.delete"] = rejected("internal_error");
  const notice = await world.deleter.clean(CHANNEL);
  assert.equal(
    notice,
    fill(slackTexts.HOME_CLEAN_FAILED, { error: "internal_error", deleted: 0, count: 0 }),
  );
  assert.deepEqual(world.deleted(world.bot), []); // it stopped at the failure
});

test("a clean up counts what slack refuses and deletes the rest", async () => {
  const world = new World();
  world.bot.responses["conversations.history"] = paged([
    loose("1790000010.000001", OWNER, "!stop"),
    loose("1790000011.000001", BOT, "Stopped."),
  ]);
  world.owner.responses["chat.delete"] = rejected("cant_delete_message");
  assert.equal(
    await world.deleter.clean(CHANNEL),
    fill(named(slackTexts.HOME_CLEAN_REFUSED, PLAIN_NAMES), { deleted: 1, count: 1 }),
  );
  assert.deepEqual(world.deleted(world.bot), ["1790000011.000001"]);
});

test("a notice with a reply, or that a thread holds, stays", async () => {
  const world = new World();
  const held = "1790000031.000001";
  const replied = "1790000032.000001";
  world.state.openThread(CHANNEL, held);
  world.bot.responses["conversations.history"] = paged([
    loose(held, OWNER, "renamed", { subtype: "channel_name" }),
    loose(replied, OWNER, "joined", {
      subtype: "channel_join",
      thread_ts: replied,
      reply_count: 3,
    }),
  ]);
  world.bot.responses["conversations.replies"] = () => ({
    ok: true,
    messages: [
      loose(replied, OWNER, "joined", {
        subtype: "channel_join",
        thread_ts: replied,
        reply_count: 3,
      }),
    ],
    has_more: false,
  });
  await world.deleter.clean(CHANNEL);
  assert.deepEqual(world.deleted(world.owner), []);
});

test("any refusal of a notice is counted, and the clean up goes on", async () => {
  const world = new World();
  world.bot.responses["conversations.history"] = paged([
    loose("1790000033.000001", OWNER, "renamed", { subtype: "channel_name" }),
    loose("1790000034.000001", BOT, "Stopped."),
  ]);
  world.owner.responses["chat.delete"] = rejected("restricted_action");
  assert.equal(
    await world.deleter.clean(CHANNEL),
    fill(named(slackTexts.HOME_CLEAN_REFUSED, PLAIN_NAMES), { deleted: 1, count: 1 }),
  );
  assert.deepEqual(world.deleted(world.bot), ["1790000034.000001"]);
});

test("a failure that is no refusal stops the clean up and says how far it went", async () => {
  const world = new World();
  world.bot.responses["conversations.history"] = paged([
    loose("1790000034.000001", BOT, "Stopped."),
    loose("1790000033.000001", OWNER, "renamed", { subtype: "channel_name" }),
  ]);
  world.owner.responses["chat.delete"] = new Error("network down");
  assert.equal(
    await world.deleter.clean(CHANNEL),
    fill(slackTexts.HOME_CLEAN_FAILED, { error: "Error", deleted: 1, count: 0 }),
  );
});

test("a failure of the owner's token on a notice stops the clean up and is named", async () => {
  const world = new World();
  world.bot.responses["conversations.history"] = paged([
    loose("1790000033.000001", OWNER, "renamed", { subtype: "channel_name" }),
  ]);
  world.owner.responses["chat.delete"] = rejected("token_revoked");
  assert.equal(
    await world.deleter.clean(CHANNEL),
    fill(slackTexts.HOME_CLEAN_FAILED, { error: "token_revoked", deleted: 0, count: 0 }),
  );
});

test("the stopped line counts what slack refused before it", async () => {
  const world = new World();
  world.bot.responses["conversations.history"] = paged([
    loose("1790000033.000001", OWNER, "renamed", { subtype: "channel_name" }),
    loose("1790000035.000001", OWNER, "!stop"),
  ]);
  let calls = 0;
  world.owner.responses["chat.delete"] = () => {
    calls += 1;
    return calls === 1 ? rejected("restricted_action") : new Error("network down");
  };
  assert.equal(
    await world.deleter.clean(CHANNEL),
    fill(slackTexts.HOME_CLEAN_FAILED, { error: "Error", deleted: 0, count: 1 }),
  );
});

test("a server failure on a notice stops the clean up, as on any message", async () => {
  const world = new World();
  world.bot.responses["conversations.history"] = paged([
    loose("1790000033.000001", OWNER, "renamed", { subtype: "channel_name" }),
  ]);
  world.owner.responses["chat.delete"] = rejected("internal_error");
  assert.equal(
    await world.deleter.clean(CHANNEL),
    fill(slackTexts.HOME_CLEAN_FAILED, { error: "internal_error", deleted: 0, count: 0 }),
  );
});

function threadRoot(ts: string, user: string, fields: JsonObject = {}): JsonObject {
  return loose(ts, user, "x", { thread_ts: ts, reply_count: 2, ...fields });
}

test("a purge deletes the threads, orphans too, keeps the others', and says the count", async () => {
  const world = new World();
  const orphan = "1790000040.000001";
  const someone = "1790000041.000001";
  const leftover = "1790000042.000001";
  world.bot.responses["conversations.history"] = paged([
    threadRoot(ROOT, OWNER),
    threadRoot(orphan, OWNER),
    threadRoot(someone, "U000BOB"),
    loose(leftover, OWNER, "!clean-channel"),
  ]);
  world.bot.responses["conversations.replies"] = (args) =>
    world.deleted(world.owner).includes(String(args.ts))
      ? rejected("thread_not_found")
      : { ok: true, messages: [threadRoot(String(args.ts), OWNER)], has_more: false };
  assert.equal(
    await world.deleter.purge(CHANNEL),
    fill(slackTexts.CLEAN_WORD_DONE, { threads: 2, kept: 0, left: 0, deleted: 1, refused: 0 }),
  );
  assert.deepEqual(world.deleted(world.owner), [ROOT, orphan, leftover]);
  assert.equal(world.state.thread(CHANNEL, ROOT), null);
});

test("a purge keeps a thread in use", async () => {
  const world = new World();
  world.free = false;
  world.bot.responses["conversations.history"] = paged([threadRoot(ROOT, OWNER)]);
  world.bot.responses["conversations.replies"] = paged([threadRoot(ROOT, OWNER)]);
  assert.equal(
    await world.deleter.purge(CHANNEL),
    fill(slackTexts.CLEAN_WORD_DONE, { threads: 0, kept: 1, left: 0, deleted: 0, refused: 0 }),
  );
  assert.deepEqual(world.deleted(world.owner), []);
  assert.notEqual(world.state.thread(CHANNEL, ROOT), null);
});

test("a survey counts a pinned thread apart", async () => {
  const world = new World();
  world.bot.responses["conversations.history"] = paged([threadRoot(ROOT, OWNER)]);
  world.bot.responses["conversations.replies"] = paged([
    threadRoot(ROOT, OWNER, { pinned_to: [CHANNEL] }),
  ]);
  assert.deepEqual(await world.deleter.survey(CHANNEL), { threads: 0, busy: 0, pinned: 1 });
});

test("a failure stops a purge, and its line says so", async () => {
  const world = new World();
  world.bot.responses["conversations.history"] = paged([
    threadRoot(ROOT, OWNER),
    loose("1790000042.000001", OWNER, "!clean-channel"),
  ]);
  world.bot.responses["conversations.replies"] = paged([threadRoot(ROOT, OWNER)]);
  world.owner.responses["chat.delete"] = new Error("network down");
  const line = await world.deleter.purge(CHANNEL);
  assert.ok(line?.includes(fill(slackTexts.CLEAN_WORD_STOPPED, { error: "Error" })), line ?? "");
  assert.notEqual(world.state.thread(CHANNEL, ROOT), null);
});

test("a purge of a channel that is not bound touches nothing", async () => {
  const world = new World();
  assert.equal(await world.deleter.purge("C000OTHER"), null);
  assert.equal(world.bot.callsTo("conversations.history").length, 0);
});

test("a survey counts a thread that works or waits as staying", async () => {
  for (const status of ["working", "waiting"] as const) {
    const world = new World();
    world.state.setStatusPending(CHANNEL, ROOT, status);
    world.bot.responses["conversations.history"] = paged([threadRoot(ROOT, OWNER)]);
    assert.deepEqual(await world.deleter.survey(CHANNEL), { threads: 0, busy: 1, pinned: 0 });
  }
});

test("a survey lists an orphan with a file, a tombstone, and no thread that is gone", async () => {
  const world = new World();
  const file = "1790000050.000001";
  const tombstone = "1790000051.000001";
  const gone = "1790000052.000001";
  const roots: Record<string, JsonObject[]> = {
    [file]: [threadRoot(file, OWNER, { subtype: "file_share" })],
    // A tombstone goes whether or not the history gives it a `thread_ts`.
    [tombstone]: [
      loose(tombstone, "USLACKBOT", "deleted", { subtype: "tombstone", reply_count: 1 }),
      message("1790000053.000001", BOT),
    ],
  };
  world.state.removeThread(CHANNEL, ROOT);
  world.bot.responses["conversations.history"] = paged([
    threadRoot(file, OWNER, { subtype: "file_share" }),
    loose(tombstone, "USLACKBOT", "deleted", { subtype: "tombstone" }),
    threadRoot(gone, OWNER),
  ]);
  world.bot.responses["conversations.replies"] = (args) => {
    const found = roots[String(args.ts)];
    return found ? { ok: true, messages: found, has_more: false } : rejected("thread_not_found");
  };
  assert.deepEqual(await world.deleter.survey(CHANNEL), { threads: 2, busy: 0, pinned: 0 });
});

test("a purge holds an orphan and frees it", async () => {
  const world = new World();
  const orphan = "1790000054.000001";
  world.state.removeThread(CHANNEL, ROOT);
  world.bot.responses["conversations.history"] = paged([threadRoot(orphan, OWNER)]);
  world.bot.responses["conversations.replies"] = (args) =>
    world.deleted(world.owner).includes(String(args.ts))
      ? rejected("thread_not_found")
      : { ok: true, messages: [threadRoot(orphan, OWNER)], has_more: false };
  await world.deleter.purge(CHANNEL);
  assert.deepEqual(world.released, [[CHANNEL, orphan]]);
  assert.deepEqual(world.freed, [[CHANNEL, orphan]]);
});

test("a clean up takes the owner's file message with no reply, and no one else's", async () => {
  const world = new World();
  const own = "1790000055.000001";
  world.bot.responses["conversations.history"] = paged([
    loose(own, OWNER, "a file", { subtype: "file_share" }),
    loose("1790000056.000001", "U000BOB", "a file", { subtype: "file_share" }),
  ]);
  await world.deleter.clean(CHANNEL);
  assert.deepEqual(world.deleted(world.owner), [own]);
});
