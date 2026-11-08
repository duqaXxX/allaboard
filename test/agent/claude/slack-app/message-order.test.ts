/**
 * The order of the messages of one thread through the channel check. The listener of each runs
 * the check (`conversations.info`, `conversations.members`) before it hands the message to the
 * core, and a check can take longer for one message than for the one sent after it: the second
 * must still not pass the first. The first message's `conversations.info` is held at the fake's
 * gate while the second is sent; what the core got is read at rest.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as slackTexts from "../../../../src/chat/slack/texts.ts";
import { fill } from "../../../../src/core/texts.ts";
import { AsyncEvent, CHANNEL, OWNER, STRANGER, THREAD } from "../../../support/fake-slack.ts";
import { inAThread, message, reply, type World, worldOf } from "../../../support/slack-app.ts";

const ack = async (): Promise<void> => {};

/** The prompt `text` never reached the agent: the stop dropped it, on its way or in the queue. */
function neverSent(world: World, text: string): boolean {
  return !world.clients.some((client) => JSON.stringify(client.queries).includes(text));
}

/** What reaches the thread's session, in order: the prompts it is given and its stops. */
function reached(world: World): string[] {
  const session = world.sessions.get(CHANNEL, THREAD);
  assert.ok(session !== null);
  const seen: string[] = [];
  const submit = session.submit.bind(session);
  session.submit = async (prompt) => {
    seen.push(String(prompt));
    return submit(prompt);
  };
  const stop = session.stop.bind(session);
  session.stop = async () => {
    seen.push("!stop");
    return stop();
  };
  return seen;
}

/** Holds the next `conversations.info`, and returns what lets it go once it is out. */
async function holdNextCheck(world: World, sendFirst: () => unknown): Promise<AsyncEvent> {
  const hold = new AsyncEvent();
  world.slack.gated = new AsyncEvent();
  world.slack.gate = hold;
  world.slack.gateMethod = "conversations.info";
  sendFirst();
  await world.slack.gated.wait();
  world.slack.gate = null; // every later call answers at once
  return hold;
}

const send = (world: World, body: ReturnType<typeof reply>) =>
  world.app.processEvent({ body, ack });

test("two messages of one thread reach the queue in the order they were sent, the first check held", async (t) => {
  const world = worldOf(t);
  await inAThread(world);
  const seen = reached(world);
  const hold = await holdNextCheck(world, () => void send(world, reply("first", THREAD)));
  void send(world, reply("second", THREAD));
  await world.idle();
  assert.deepEqual(seen, []); // the second waits for the first's place
  hold.set();
  await world.settle();
  assert.deepEqual(seen, ["first", "second"]);
});

// A stop acts on every message handed over before it: the prompt is handed over first (its check
// is held), the stop second, and the prompt is dropped on its way (#200).
test("a stop typed right after a prompt drops the prompt and posts no Nothing is running", async (t) => {
  const world = worldOf(t);
  await inAThread(world);
  const seen = reached(world);
  const hold = await holdNextCheck(world, () => void send(world, reply("first", THREAD)));
  void send(world, reply("!stop", THREAD));
  await world.idle();
  assert.deepEqual(seen, []);
  hold.set();
  await world.settle();
  // Handed over in order; whether the prompt reaches `submit` before the stop aborts it is the
  // core's: either way it is not sent, by its ticket (`Not sent.`) or by the session's own stop.
  // Had the stop been handed over first, the prompt would have gone: `neverSent` is the order.
  assert.ok(["first,!stop", "!stop"].includes(seen.join()), seen.join());
  assert.ok(neverSent(world, "first"));
  assert.equal(
    world.slack
      .callsTo("chat.postMessage")
      .some((call) => String(call.text ?? "").includes("Nothing is running")),
    false,
  );
});

test("a message from someone else takes no place and delays nothing", async (t) => {
  const world = worldOf(t);
  await inAThread(world);
  const seen = reached(world);
  const hold = await holdNextCheck(world, () => void send(world, reply("first", THREAD)));
  const asked = world.slack.callsTo("conversations.info").length;
  // Answered while the owner's check is still held: it queued behind nothing.
  let answered = false;
  void send(world, reply("from a stranger", THREAD, { user: STRANGER })).then(() => {
    answered = true;
  });
  await world.idle();
  assert.equal(answered, true);
  assert.equal(world.slack.callsTo("conversations.info").length, asked);
  assert.equal(world.slack.callsTo("conversations.members").length, asked);
  hold.set();
  await world.settle();
  assert.deepEqual(seen, ["first"]);
});

test("the messages of two threads of one channel are handed over in the order they were sent", async (t) => {
  const world = worldOf(t);
  await inAThread(world);
  const hold = await holdNextCheck(world, () => void send(world, reply("first", THREAD)));
  void world.dispatch(message("elsewhere", { ts: "1790000200.000100" }));
  await world.idle();
  // The other thread's message waits for the first's channel check: the order is the channel's.
  assert.equal(world.clients.length, 1);
  hold.set();
  await world.settle();
  assert.equal(world.clients.length, 2);
});

test("a top-level stop is handed over after a thread's message sent before it", async (t) => {
  const world = worldOf(t);
  await inAThread(world);
  const seen = reached(world);
  const hold = await holdNextCheck(world, () => void send(world, reply("first", THREAD)));
  void send(world, message("!stop", { ts: "1790000200.000100" }));
  await world.idle();
  assert.deepEqual(seen, []);
  hold.set();
  await world.settle();
  // Handed over in order; whether the prompt reaches `submit` before the stop aborts it is the
  // core's: either way it is not sent, by its ticket (`Not sent.`) or by the session's own stop.
  // Had the stop been handed over first, the prompt would have gone: `neverSent` is the order.
  assert.ok(["first,!stop", "!stop"].includes(seen.join()), seen.join());
  assert.ok(neverSent(world, "first"));
});

test("a message whose channel check refuses releases the next one", async (t) => {
  const world = worldOf(t);
  await inAThread(world);
  const seen = reached(world);
  let members = 0;
  world.slack.responses["conversations.members"] = () => ({
    ok: true,
    members: members++ === 0 ? [OWNER, STRANGER] : [OWNER, world.identity.botUserId],
  });
  const hold = await holdNextCheck(world, () => void send(world, reply("first", THREAD)));
  void send(world, reply("second", THREAD));
  await world.idle();
  hold.set();
  await world.settle();
  assert.deepEqual(seen, ["second"]); // the first was refused, and said so
  assert.ok(
    world
      .ephemerals()
      .includes(fill(slackTexts.CHANNEL_REFUSED, { reason: slackTexts.REASON_MEMBERS })),
  );
});

test("a setup the owner has not answered does not hold the next message's check", async (t) => {
  const world = worldOf(t);
  world.autoStart = false;
  await world.dispatch(message("hello", { ts: THREAD })); // its setup waits for Start
  const checks = world.slack.callsTo("conversations.info").length;
  await world.dispatch(reply("second", THREAD));
  assert.equal(world.slack.callsTo("conversations.info").length, checks + 1);
});

// The lookup of a new thread's root (#221) overlaps the wait for the place; it must not reorder.
test("a top-level stop is still handed over after a prompt whose root lookup answers last", async (t) => {
  const world = worldOf(t);
  const handed: string[] = [];
  const message_ = world.inbound.message.bind(world.inbound);
  world.inbound.message = async (inbound) => {
    handed.push(inbound.text);
    return message_(inbound);
  };
  const hold = new AsyncEvent();
  world.slack.gated = new AsyncEvent();
  world.slack.gate = hold;
  world.slack.gateMethod = "conversations.replies";
  void send(world, message("a new prompt", { ts: "1790000200.000100" }));
  await world.slack.gated.wait();
  world.slack.gate = null;
  void send(world, message("!stop", { ts: "1790000300.000100" }));
  await world.idle();
  assert.deepEqual(handed, []);
  hold.set();
  await world.settle();
  assert.deepEqual(handed, ["a new prompt", "!stop"]);
});
