/**
 * The Send click of a `!next` offer takes its place among the channel's messages before it is
 * acknowledged, as a typed message does (#151): a message typed before it is handed over first,
 * one typed after it later. The gate is a channel check held at the fake Slack.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NEXT_SEND_ACTION, suggestionValue } from "../../../../src/chat/slack/lists.ts";
import { AsyncEvent, CHANNEL, THREAD } from "../../../support/fake-slack.ts";
import { clickIn, inAThread, reply, worldOf } from "../../../support/slack-app.ts";

const ack = async (): Promise<void> => {};
const SESSION = "68da9311-0000-4000-8000-00000000000a";

/** A thread with a held suggestion; what the session was given to submit is collected. */
async function held(t: Parameters<typeof worldOf>[0]) {
  const world = worldOf(t);
  await inAThread(world);
  await world.settle();
  const ref = { channel: CHANNEL, thread: THREAD };
  world.state.setSession(CHANNEL, THREAD, SESSION);
  world.sessions.suggestions.hold(ref, "run the tests");
  const suggestion = world.sessions.suggestions.held(ref);
  assert.ok(suggestion);
  const session = world.sessions.get(CHANNEL, THREAD);
  assert.ok(session);
  const seen: string[] = [];
  const submit = session.submit.bind(session);
  session.submit = async (...args: Parameters<typeof submit>) => {
    seen.push(String(args[0]));
    return submit(...args);
  };
  const click = clickIn(
    NEXT_SEND_ACTION,
    suggestionValue(SESSION, suggestion.id),
    CHANNEL,
    THREAD,
    {
      messageTs: "1700000000.999999",
    },
  );
  return { world, seen, click };
}

/** The next channel check is held until the returned event is set. */
async function holdNextCheck(world: Awaited<ReturnType<typeof held>>["world"]) {
  const hold = new AsyncEvent();
  world.slack.gated = new AsyncEvent();
  world.slack.gate = hold;
  world.slack.gateMethod = "conversations.info";
  return hold;
}

test("a message typed before Send is handed over first, and Send then finds the suggestion gone", async (t) => {
  const { world, seen, click } = await held(t);
  const hold = await holdNextCheck(world);
  void world.app.processEvent({ body: reply("typed first", THREAD), ack });
  await world.slack.gated?.wait();
  world.slack.gate = null;
  void world.app.processEvent({ body: click, ack });
  await world.idle();
  hold.set();
  await world.settle();
  assert.deepEqual(seen, ["typed first"]);
});

test("Send clicked before a message is typed is handed over first", async (t) => {
  const { world, seen, click } = await held(t);
  const hold = await holdNextCheck(world);
  void world.app.processEvent({ body: click, ack });
  await world.slack.gated?.wait();
  world.slack.gate = null;
  void world.app.processEvent({ body: reply("typed after", THREAD), ack });
  await world.idle();
  hold.set();
  await world.settle();
  assert.deepEqual(seen, ["run the tests", "typed after"]);
});
