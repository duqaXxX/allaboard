/**
 * A top-level message whose root is already gone when the daemon reads it (a redelivered event
 * of a message the owner deleted, #221): the listener asks Slack for the root before it opens
 * anything, and drops the message when `conversations.replies` says the thread is not found.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOT_LOOKUP_SECONDS } from "../../../../src/chat/slack/app/app.ts";
import { AsyncEvent, CHANNEL, THREAD } from "../../../support/fake-slack.ts";
import { message, type World, worldOf } from "../../../support/slack-app.ts";

const gone = { ok: false, error: "thread_not_found" };

/** The calls that would put something in the channel or the thread. */
function posts(world: World): number {
  return world.slack.callsTo("chat.postMessage").length;
}

test("a top-level message whose root is gone opens nothing and posts nothing", async (t) => {
  const world = worldOf(t);
  world.slack.responses["conversations.replies"] = gone;
  await world.dispatch(message("hello", { ts: THREAD }));
  assert.equal(world.state.thread(CHANNEL, THREAD), null);
  assert.equal(posts(world), 0);
  assert.equal(world.slack.callsTo("conversations.replies").length, 1);
});

test("a top-level message whose lookup is rate limited goes through", async (t) => {
  const world = worldOf(t);
  world.slack.responses["conversations.replies"] = { ok: false, error: "ratelimited" };
  await world.dispatch(message("hello", { ts: THREAD }));
  assert.notEqual(world.state.thread(CHANNEL, THREAD), null);
});

test("a top-level message whose root is there goes through", async (t) => {
  const world = worldOf(t);
  await world.dispatch(message("hello", { ts: THREAD }));
  assert.notEqual(world.state.thread(CHANNEL, THREAD), null);
});

test("a `!` word asks nothing about the root", async (t) => {
  const world = worldOf(t);
  world.slack.responses["conversations.replies"] = gone;
  await world.dispatch(message("!status", { ts: THREAD }));
  assert.equal(world.slack.callsTo("conversations.replies").length, 0);
});

test("a lookup that takes longer than its deadline lets the message through", async (t) => {
  const world = worldOf(t);
  world.slack.responses["conversations.replies"] = gone;
  const hold = new AsyncEvent();
  world.slack.gated = new AsyncEvent();
  world.slack.gate = hold;
  world.slack.gateMethod = "conversations.replies";
  const sent = world.dispatch(message("hello", { ts: THREAD }));
  await world.slack.gated.wait();
  await world.appClock.advance(ROOT_LOOKUP_SECONDS + 1);
  await sent;
  assert.notEqual(world.state.thread(CHANNEL, THREAD), null);
  hold.set();
});
