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

test("each message is deleted by its author s token and the root last", async () => {
  const world = new World();
  const root = message(ROOT, OWNER);
  const first = paged(
    [root, message("1790000001.000001", BOT), message("1790000002.000001", OWNER)],
    // Slack returns the root at the head of every page.
    [root, message("1790000003.000001", BOT)],
  );
  world.bot.responses["conversations.replies"] = (args) =>
    world.deleted(world.bot).length === 0
      ? first(args)
      : { ok: true, messages: [root], has_more: false };
  assert.equal(await world.deleter.delete(CHANNEL, ROOT), null);
  const asked = world.bot.callsTo("conversations.replies");
  // The whole thread once for its pins, before the session is released; then page by page, and
  // once more before the root goes: no reply is left.
  assert.deepEqual(
    asked.map((a) => [a.ts, a.limit, a.cursor]),
    [
      [ROOT, PAGE, undefined],
      [ROOT, PAGE, "1"],
      [ROOT, PAGE, undefined],
      [ROOT, PAGE, "1"],
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

test("a thread the daemon does not hold is not touched", async () => {
  // The value of a click is untrusted: only a thread `state.json` holds is ever deleted.
  const world = new World();
  assert.equal(await world.deleter.delete(CHANNEL, "1790000009.000009"), null);
  assert.equal(await world.deleter.delete("C000NOPE", ROOT), null);
  assert.deepEqual(world.released, []);
  assert.deepEqual(world.bot.apiCalls, []);
  assert.deepEqual(world.owner.apiCalls, []);
  assert.notEqual(world.state.thread(CHANNEL, ROOT), null);
});

test("a message already gone does not stop the delete", async () => {
  const world = new World();
  world.bot.responses["conversations.replies"] = paged([
    message(ROOT, OWNER),
    message("1790000001.000001", BOT),
  ]);
  world.bot.responses["chat.delete"] = rejected("message_not_found");
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
  world.bot.responses["conversations.replies"] = () => {
    reads += 1;
    // The first read is for the pins. The owner replies after the second: the third shows it.
    const found = reads <= 2 ? listed : reads === 3 ? [listed[0] as JsonObject, late] : [listed[0]];
    return { ok: true, messages: found as JsonObject[], has_more: false };
  };
  assert.equal(await world.deleter.delete(CHANNEL, ROOT), null);
  assert.deepEqual(world.deleted(world.bot), ["1790000001.000001"]);
  // the root last, with nothing under it
  assert.deepEqual(world.deleted(world.owner), [late.ts, ROOT]);
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
  world.bot.responses["conversations.replies"] = (args) => ({
    ok: true,
    messages: [message(String(args.ts), OWNER)],
    has_more: false,
  });
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
  ["devops", "tagged-root"],
  [null, "root"],
] as const) {
  test(`a pinned root (${where}) is refused, and nothing is touched`, async () => {
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

test("the three pinned lines are worded for what is pinned", () => {
  assert.equal(
    pinnedLine({ reason: "pinned", where: "tagged-root" }, PLAIN_NAMES),
    slackTexts.DELETE_PINNED_TAGGED,
  );
  assert.equal(
    pinnedLine({ reason: "pinned", where: "root" }, PLAIN_NAMES),
    named(slackTexts.DELETE_PINNED_BY_HAND, PLAIN_NAMES),
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
      loose("1790000016.000001", BOT, "joined", { subtype: "channel_join" }),
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
  assert.equal(await world.deleter.clean(CHANNEL), null);
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
  assert.deepEqual(world.deleted(world.owner), ["1790000010.000001", "1790000012.000001", emptied]);
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
  assert.equal(await world.deleter.clean(CHANNEL), null);
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
    assert.equal(await world.deleter.clean(CHANNEL), null);
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
    fill(slackTexts.HOME_CLEAN_FAILED, { error: "ratelimited" }),
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
  assert.equal(notice, fill(slackTexts.HOME_CLEAN_FAILED, { error: "internal_error" }));
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
    fill(named(slackTexts.HOME_CLEAN_REFUSED, PLAIN_NAMES), { count: 1 }),
  );
  assert.deepEqual(world.deleted(world.bot), ["1790000011.000001"]);
});
