/**
 * The Stop control of a thread's session in Agents & tools (`agent_session_stopped`, issue #57):
 * the listener checks the owner and the workspace on its own, then asks the core to stop. The
 * app's Messages tab (`message.im`) and the hidden `message_changed` each `setStatus` fires on
 * the root are dropped before anything acts on them.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThreadRef } from "../../../../src/chat/seam.ts";
import {
  AsyncEvent,
  CHANNEL,
  OTHER_TEAM,
  OWNER,
  STRANGER,
  THREAD,
} from "../../../support/fake-slack.ts";
import {
  agentSessionStopped,
  type Body,
  message,
  recorded,
  reply,
  type World,
  worldOf,
} from "../../../support/slack-app.ts";

const REF: ThreadRef = { channel: CHANNEL, thread: THREAD };

/** The world with a kept thread, whose inbound `stop` and `message` are recorded. */
function arranged(world: World, stopAnswer = true) {
  world.state.openThread(CHANNEL, THREAD);
  const stops: ThreadRef[] = [];
  const messages: unknown[] = [];
  const gone: ThreadRef[] = [];
  const inbound = world.inbound as unknown as Record<string, unknown>;
  inbound.stop = async (ref: ThreadRef) => {
    stops.push(ref);
    return stopAnswer;
  };
  inbound.message = async (m: unknown) => {
    messages.push(m);
  };
  inbound.rootGone = async (ref: ThreadRef) => {
    gone.push(ref);
  };
  world.slack.apiCalls = [];
  return { stops, messages, gone };
}

const sessionCalls = (world: World) => world.slack.callsTo("agents.sessions.setStatus");

test("the owner's Stop asks the core to stop, and a session with nothing to stop is set active", async (t) => {
  const world = worldOf(t);
  const seen = arranged(world, false);
  const response = await world.dispatch(agentSessionStopped(CHANNEL, THREAD, OWNER));
  await world.settle();
  assert.equal(response.status, 200);
  assert.deepEqual(seen.stops, [REF]);
  assert.deepEqual(sessionCalls(world), [
    { channel_id: CHANNEL, thread_ts: THREAD, status: "active" },
  ]);
});

test("a Stop that stopped work sends the wanted status again", async (t) => {
  const world = worldOf(t);
  const seen = arranged(world, true);
  world.chat.agentSessions.root(REF, "working");
  await world.settle();
  assert.equal(sessionCalls(world).length, 1);
  await world.dispatch(agentSessionStopped(CHANNEL, THREAD, OWNER));
  await world.settle();
  assert.deepEqual(seen.stops, [REF]);
  assert.deepEqual(
    sessionCalls(world).map((call) => call.status),
    ["processing", "processing"],
  );
});

test("a Stop that found nothing sets a stale processing session active", async (t) => {
  const world = worldOf(t);
  arranged(world, false);
  world.chat.agentSessions.root(REF, "working");
  await world.settle();
  await world.dispatch(agentSessionStopped(CHANNEL, THREAD, OWNER));
  await world.settle();
  assert.deepEqual(
    sessionCalls(world).map((call) => call.status),
    ["processing", "active"],
  );
});

test("a stop that failed and was told resends the wanted status, never active", async (t) => {
  const world = worldOf(t);
  arranged(world);
  // What the core answers after a failure it told the owner of: work may have been cut.
  (world.inbound as unknown as Record<string, unknown>).stop = async () => true;
  world.chat.agentSessions.root(REF, "working");
  await world.settle();
  await world.dispatch(agentSessionStopped(CHANNEL, THREAD, OWNER));
  await world.settle();
  assert.deepEqual(
    sessionCalls(world).map((call) => call.status),
    ["processing", "processing"],
  );
});

const REFUSED: ReadonlyArray<[string, (body: Body) => void]> = [
  [
    "somebody else",
    (body) => {
      body.event.user = STRANGER;
    },
  ],
  [
    "the owner's id from another workspace",
    (body) => {
      body.team_id = OTHER_TEAM;
    },
  ],
  [
    "an envelope that does not say the channel is unshared",
    (body) => {
      delete body.is_ext_shared_channel;
    },
  ],
  [
    "an envelope that says the channel is shared",
    (body) => {
      body.is_ext_shared_channel = true;
    },
  ],
  [
    "a thread the core does not keep",
    (body) => {
      body.event.thread_ts = "1780000000.999999";
    },
  ],
];

for (const [who, change] of REFUSED) {
  test(`a Stop from ${who} reaches nothing`, async (t) => {
    const world = worldOf(t);
    const seen = arranged(world);
    const body = agentSessionStopped(CHANNEL, THREAD, OWNER);
    change(body);
    const response = await world.dispatch(body);
    await world.settle();
    assert.equal(response.status, 200);
    assert.deepEqual(seen.stops, []);
    assert.deepEqual(world.slack.apiCalls, []);
  });
}

test("a Stop that arrives once the daemon is stopping reaches nothing", async (t) => {
  const world = worldOf(t);
  const seen = arranged(world);
  world.chat.halt();
  await world.dispatch(agentSessionStopped(CHANNEL, THREAD, OWNER));
  await world.settle();
  assert.deepEqual(seen.stops, []);
  assert.deepEqual(world.slack.apiCalls, []);
});

test("a message of the app's Messages tab is dropped before anything acts on it", async (t) => {
  const world = worldOf(t);
  const seen = arranged(world);
  await world.dispatch(message("!stop", { channel_type: "im", user: OWNER }));
  await world.settle();
  assert.deepEqual(seen.messages, []);
  assert.deepEqual(world.slack.apiCalls, []);
});

test("the hidden message_changed of a root setStatus touched is acted on by no listener", async (t) => {
  const world = worldOf(t);
  const seen = arranged(world);
  const body = recorded("event_callback-message_changed");
  body.event = {
    type: "message",
    subtype: "message_changed",
    hidden: true,
    channel: CHANNEL,
    ts: "1790192500.000100",
    event_ts: "1790192500.000100",
    channel_type: "group",
    message: { type: "message", user: OWNER, text: "build it", ts: THREAD, thread_ts: THREAD },
    previous_message: { type: "message", user: OWNER, text: "build it", ts: THREAD },
  };
  await world.dispatch(body);
  await world.settle();
  assert.deepEqual(seen.messages, []);
  assert.deepEqual(seen.gone, []);
  assert.notEqual(world.state.thread(CHANNEL, THREAD), null);
  assert.deepEqual(world.slack.apiCalls, []);
});

/** Holds the next channel check of the world, and returns what lets it go. */
async function holdNextCheck(world: World, sendFirst: () => unknown): Promise<AsyncEvent> {
  const hold = new AsyncEvent();
  world.slack.gated = new AsyncEvent();
  world.slack.gate = hold;
  world.slack.gateMethod = "conversations.info";
  sendFirst();
  await world.slack.gated.wait();
  world.slack.gate = null;
  return hold;
}

test("a Stop is handed over after a message whose channel check is still out", {
  timeout: 8000,
}, async (t) => {
  const world = worldOf(t);
  arranged(world);
  const log: string[] = [];
  const inbound = world.inbound as unknown as Record<string, unknown>;
  inbound.message = async () => {
    log.push("message");
  };
  inbound.stop = async () => {
    log.push("stop");
    return true;
  };
  const hold = await holdNextCheck(world, () => void world.dispatch(reply("first", THREAD)));
  void world.dispatch(agentSessionStopped(CHANNEL, THREAD, OWNER));
  await world.idle();
  assert.deepEqual(log, []);
  hold.set();
  await world.settle();
  assert.deepEqual(log, ["message", "stop"]);
});

test("a message sent after a Stop is not held by the stop's interrupt", {
  timeout: 8000,
}, async (t) => {
  const world = worldOf(t);
  arranged(world);
  const log: string[] = [];
  const inbound = world.inbound as unknown as Record<string, unknown>;
  const interrupt = new AsyncEvent();
  inbound.message = async () => {
    log.push("message");
  };
  inbound.stop = async () => {
    log.push("stop");
    await interrupt.wait(); // an interrupt that takes a while
    return true;
  };
  void world.dispatch(agentSessionStopped(CHANNEL, THREAD, OWNER));
  await world.idle();
  await world.dispatch(reply("after", THREAD));
  assert.deepEqual(log, ["stop", "message"]);
  interrupt.set();
  await world.settle();
});
