/**
 * A first message the chat no longer has (#221): a form asked into such a thread posts nothing
 * and leaves no entry, and a root that goes while a setup or a hold waits cancels the question
 * first (the form is deleted, the asker answers nothing) and forgets the thread after.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThreadRef } from "../../../src/chat/seam.ts";
import { logger } from "../../../src/core/flows/talk.ts";
import { AsyncEvent } from "../../support/fake-clock.ts";
import { OWNER } from "../../support/memory-chat.ts";
import { hold, type PlainAgent } from "../../support/plain-agent.ts";
import { MessagesWorld } from "./messages-world.ts";

/** What the thread forgot and froze: no entry, no hold, no request, and nothing reached the agent. */
async function assertForgotten(world: MessagesWorld, ref: ThreadRef): Promise<void> {
  assert.equal(world.state.thread(ref.channel, ref.thread), null, "entry forgotten");
  assert.equal(world.sessions.held(ref.channel, ref.thread), false, "hold freed");
  assert.deepEqual(world.chat.requests(), [], "no request left");
  assert.deepEqual(await world.prompts(), [], "nothing sent");
}

/** The root is deleted by the owner: gone for the chat, then told to the core. */
async function deleteRoot(world: MessagesWorld, ref: ThreadRef): Promise<void> {
  world.chat.keepThread(ref);
  await world.chat.as(OWNER).deletes({ id: ref.thread, ref });
}

test("a setup asked into a root that is already gone posts nothing and leaves no entry", async (t) => {
  t.mock.method(logger, "info", () => {});
  const world = await MessagesWorld.make(t);
  const ref = world.chat.openThread(world.channel);
  const before = world.shown(ref);
  const inChannel = world.inChannel();
  world.chat.removeThread(ref);
  await world.send({ ref, id: ref.thread, topLevel: true, text: "hello" });
  await world.settle();
  assert.deepEqual(world.shown(ref), before);
  assert.deepEqual(world.inChannel(), inChannel);
  await assertForgotten(world, ref);
});

test("rootGone while a setup waits deletes the form, answers the asker with nothing and forgets the thread", async (t) => {
  t.mock.method(logger, "info", () => {});
  const world = await MessagesWorld.make(t);
  const sending = world.says("hello");
  const { ref } = await world.asked("setup");
  await deleteRoot(world, ref);
  await sending;
  await world.settle();
  assert.ok(!world.shown(ref).some((line) => line.includes("Not sent")), "says nothing");
  assert.deepEqual(world.chat.dropped, [], "not even a line the chat would drop");
  await assertForgotten(world, ref);
});

test("rootGone while a hold waits does the same", async (t) => {
  t.mock.method(logger, "info", () => {});
  const world = await MessagesWorld.make(t);
  const ref = await world.opened("one");
  const neighbour = await world.opened("two");
  (world.agent as PlainAgent).next(hold());
  await world.says("a long job", neighbour.thread);
  await world.settle();
  const sending = world.says("and this", ref.thread);
  await world.asked("hold", ref);
  await deleteRoot(world, ref);
  await sending;
  await world.settle();
  assert.equal(world.state.thread(ref.channel, ref.thread), null);
  assert.equal(world.sessions.held(ref.channel, ref.thread), false);
  assert.deepEqual(
    world.chat.requests().filter((r) => r.ref.thread === ref.thread),
    [],
  );
  assert.equal((await world.prompts()).includes("and this"), false);
});

test("a reply queued behind the cancelled setup is dropped while the thread is marked gone", async (t) => {
  const lines: string[] = [];
  t.mock.method(logger, "info", (line: string) => lines.push(line));
  const world = await MessagesWorld.make(t);
  const closing = new AsyncEvent();
  const closeHeld = world.sessions.closeHeld.bind(world.sessions);
  // The session stays open and the thread marked gone while the queued reply runs.
  t.mock.method(world.sessions, "closeHeld", async (channel: string, thread: string) => {
    await closing.wait();
    return closeHeld(channel, thread);
  });
  const first = world.says("hello");
  const { ref } = await world.asked("setup");
  const second = world.says("and this", ref.thread);
  await world.settle();
  const gone = deleteRoot(world, ref);
  await world.settle();
  assert.ok(
    lines.some((line) => line.includes("dropped a message")),
    "the queued reply was dropped by the check",
  );
  assert.deepEqual(world.chat.requests(), [], "no second form");
  closing.set();
  await Promise.all([first, second, gone]);
  await world.settle();
  await assertForgotten(world, ref);
});

test("a thread held by a delete is not marked gone; a gone one is, until freed", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  assert.equal(world.sessions.hold(ref.channel, ref.thread), true);
  assert.equal(world.sessions.gone(ref.channel, ref.thread), false);
  world.sessions.free(ref.channel, ref.thread);
  assert.equal(world.sessions.holdGone(ref.channel, ref.thread), true);
  assert.equal(world.sessions.gone(ref.channel, ref.thread), true);
  world.sessions.free(ref.channel, ref.thread);
  assert.equal(world.sessions.gone(ref.channel, ref.thread), false);
});

test("Start, then a stop, then rootGone: the thread stays until the asker discarded the hold", async (t) => {
  t.mock.method(logger, "info", () => {});
  const rewrite = new AsyncEvent();
  const world = await MessagesWorld.make(t, { gates: { rewrite } });
  const sending = world.says("hello");
  const open = await world.asked("setup");
  const ref = open.ref;
  const clicked = world.chat.as(OWNER).answers(open.requestId, {
    type: "setup",
    selection: { model: "default", effort: "default", bypass: false },
  });
  await world.settle();
  await world.chat.as(OWNER).stops(ref);
  await world.settle();
  const gone = deleteRoot(world, ref);
  await world.settle();
  assert.notEqual(
    world.state.thread(ref.channel, ref.thread),
    null,
    "not removed before the asker ended",
  );
  rewrite.set();
  await Promise.all([sending, clicked, gone]);
  await world.settle();
  await assertForgotten(world, ref);
});

test("rootGone while the form's ask is in flight deletes the form once it is posted", async (t) => {
  t.mock.method(logger, "info", () => {});
  const ask = new AsyncEvent();
  const world = await MessagesWorld.make(t, { gates: { ask } });
  const sending = world.says("hello");
  const { ref } = await world.asked("setup");
  // The form is posted; `ask` has not returned, so the core does not know its message yet.
  const gone = deleteRoot(world, ref);
  await world.settle();
  assert.equal(world.sessions.held(ref.channel, ref.thread), true, "the thread is taken first");
  ask.set();
  await Promise.all([sending, gone]);
  await world.settle();
  await assertForgotten(world, ref);
});

test("Start clicked as the root goes sends nothing, and the thread is forgotten", async (t) => {
  t.mock.method(logger, "info", () => {});
  const rewrite = new AsyncEvent();
  const world = await MessagesWorld.make(t, { gates: { rewrite } });
  const sending = world.says("hello");
  const open = await world.asked("setup");
  const ref = open.ref;
  const clicked = world.chat.as(OWNER).answers(open.requestId, {
    type: "setup",
    selection: { model: "default", effort: "default", bypass: false },
  });
  await world.settle();
  const gone = deleteRoot(world, ref);
  await world.settle();
  rewrite.set();
  await Promise.all([sending, clicked, gone]);
  await world.settle();
  await assertForgotten(world, ref);
});
