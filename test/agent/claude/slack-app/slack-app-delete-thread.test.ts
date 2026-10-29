/**
 * `!delete-thread` as the Slack app draws it: the question only the owner sees, and its two
 * buttons. The harness is `test/support/slack-app.ts`; the click is an ephemeral one, in the shape
 * measured on 2026-10-19 (`ephemeralClick`), and what Bolt's `respond` posts is caught at the
 * global `fetch` (`respondedTo`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeleteRefusal } from "../../../../src/chat/slack/delete.ts";
import {
  DELETE_THREAD_CANCEL,
  DELETE_THREAD_CONFIRM,
} from "../../../../src/chat/slack/delete-thread.ts";
import * as slackTexts from "../../../../src/chat/slack/texts.ts";
import * as texts from "../../../../src/core/texts.ts";
import { fill, named } from "../../../../src/core/texts.ts";
import { CHANNEL, OWNER, THREAD } from "../../../support/fake-slack.ts";
import { NAMES } from "../../../support/names.ts";
import {
  type Body,
  ephemeralClick,
  respondedTo,
  worldFor,
  worldOf,
} from "../../../support/slack-app.ts";

test("the question is posted for the owner alone, in the thread, with its two buttons", async (t) => {
  const world = worldOf(t);
  await world.built.askDelete(CHANNEL, THREAD);
  const posts = world.slack.callsTo("chat.postEphemeral") as Body[];
  assert.equal(posts.length, 1);
  const [post] = posts as [Body];
  assert.equal(post.channel, CHANNEL);
  assert.equal(post.thread_ts, THREAD);
  assert.equal(post.user, OWNER);
  assert.equal(post.text, slackTexts.HOME_DELETE_TITLE);
  const [section, actions] = post.blocks as [Body, Body];
  assert.equal(
    section.text.text,
    `*${slackTexts.HOME_DELETE_TITLE}*\n${named(slackTexts.HOME_DELETE_TEXT, NAMES)}`,
  );
  assert.deepEqual(
    actions.elements.map((button: Body) => [button.action_id, button.text.text, button.style]),
    [
      [DELETE_THREAD_CONFIRM, slackTexts.HOME_DELETE_CONFIRM, "danger"],
      [DELETE_THREAD_CANCEL, slackTexts.HOME_DELETE_DENY, undefined],
    ],
  );
  assert.equal(world.slack.callsTo("chat.postMessage").length, 0, "nothing that stays");
});

test("a pinned thread gets the refusal in place of the question", async (t) => {
  const world = worldOf(t);
  world.pinnedRefusal = { reason: "pinned", where: "tagged-root" };
  await world.built.askDelete(CHANNEL, THREAD);
  const posts = world.slack.callsTo("chat.postEphemeral") as Body[];
  assert.equal(posts.length, 1);
  const [post] = posts as [Body];
  assert.equal(post.text, slackTexts.DELETE_PINNED_TAGGED);
  assert.equal(post.thread_ts, THREAD);
  assert.equal(post.user, OWNER);
  assert.ok(
    !(post.blocks as Body[]).some((block) => block.type === "actions"),
    "no question, no buttons",
  );
});

test("Delete thread takes the question away, then deletes the thread the click sits in", async (t) => {
  const responses = respondedTo(t);
  const world = worldOf(t);
  await world.dispatch(ephemeralClick(DELETE_THREAD_CONFIRM, THREAD));
  await world.settle();
  assert.deepEqual(responses, [{ delete_original: true }]);
  assert.deepEqual(world.threadDeletes, [[CHANNEL, THREAD]]);
  assert.deepEqual(world.ephemerals(), [], "a thread that is gone needs no line");
});

// Each way a delete stops, and the line the thread gets for it: the thread's own words, never
// the Home tab's, which speak of a page and a button the thread does not have.
const REFUSALS: readonly [DeleteRefusal, string][] = [
  [{ reason: "busy" }, texts.DELETE_THREAD_BUSY],
  [{ reason: "pinned", where: "tagged-root" }, slackTexts.DELETE_PINNED_TAGGED],
  [{ reason: "pinned", where: "root" }, named(slackTexts.DELETE_PINNED_BY_HAND, NAMES)],
  [{ reason: "pinned", where: "reply" }, named(slackTexts.DELETE_PINNED_REPLY, NAMES)],
  [
    { reason: "refused", count: 2 },
    fill(named(slackTexts.THREAD_DELETE_REFUSED, NAMES), { count: 2 }),
  ],
  [
    { reason: "failed", error: "ratelimited" },
    fill(slackTexts.THREAD_DELETE_FAILED, { error: "ratelimited" }),
  ],
];

for (const [refusal, line] of REFUSALS) {
  test(`a delete that stopped (${refusal.reason}) says why, for the owner alone, in the thread`, async (t) => {
    respondedTo(t);
    const world = worldOf(t);
    world.threadDeleteRefusal = refusal;
    await world.dispatch(ephemeralClick(DELETE_THREAD_CONFIRM, THREAD));
    await world.settle();
    assert.deepEqual(world.threadDeletes, [[CHANNEL, THREAD]]);
    assert.ok(world.ephemerals().at(-1)?.includes(line), world.ephemerals().at(-1));
    const told = world.slack.callsTo("chat.postEphemeral").at(-1) as Body;
    assert.equal(told.thread_ts, THREAD);
  });
}

test("a question Slack would not take away still lets the thread be deleted", async (t) => {
  const responses = respondedTo(t, 404);
  const world = worldOf(t);
  await world.dispatch(ephemeralClick(DELETE_THREAD_CONFIRM, THREAD));
  await world.settle();
  assert.deepEqual(responses, [{ delete_original: true }]);
  assert.deepEqual(world.threadDeletes, [[CHANNEL, THREAD]]);
});

test("Cancel takes the question away and deletes nothing", async (t) => {
  const responses = respondedTo(t);
  const world = worldOf(t);
  await world.dispatch(ephemeralClick(DELETE_THREAD_CANCEL, THREAD));
  await world.settle();
  assert.deepEqual(responses, [{ delete_original: true }]);
  assert.deepEqual(world.threadDeletes, []);
  assert.deepEqual(world.ephemerals(), []);
});

test("a question left from a run with the owner's token stays, and says the thread cannot be deleted", async (t) => {
  const responses = respondedTo(t);
  const world = worldFor(t)({ noThreadDelete: true });
  await world.dispatch(ephemeralClick(DELETE_THREAD_CONFIRM, THREAD));
  await world.settle();
  assert.deepEqual(responses, []);
  assert.deepEqual(world.threadDeletes, []);
  assert.equal(world.ephemerals().at(-1), named(texts.DELETE_THREAD_UNAVAILABLE, NAMES));
});
