/**
 * `!next` through the message flow, with the plain agent and the memory chat: the agent's guess at
 * the next prompt is offered with Send and Cancel, held in memory only, dropped when a message, a
 * turn or a close comes first, and sent as a typed prompt by Send (#151, design
 * `2026-11-08-next-command-design.md`).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ThreadRef } from "../../../src/chat/seam.ts";
import * as texts from "../../../src/core/texts.ts";
import { AsyncEvent } from "../../support/fake-clock.ts";
import { hold, PlainAgent, say, suggest } from "../../support/plain-agent.ts";
import { type Gates, MessagesWorld } from "./messages-world.ts";

const GUESS = "run the tests";
const NONE =
  "No suggestion yet: Plain suggests a next prompt after a turn ends, and forgets it when the session closes.";

/** A thread whose first turn ended with the agent's guess `GUESS`. */
async function threadOf(
  t: Parameters<typeof MessagesWorld.make>[0],
  options: { readonly gates?: Gates } = {},
) {
  const agent = new PlainAgent({ suggestions: true });
  const world = await MessagesWorld.make(t, { agent, lists: true, ...options });
  agent.next(say("done"), suggest(GUESS));
  const ref = await world.opened("add the feature");
  return { world, agent, ref };
}

function offerIn(world: MessagesWorld, ref: ThreadRef) {
  const open = world.chat.threadLists().findLast((list) => list.ref.thread === ref.thread);
  assert.ok(open, "an offer is open in the thread");
  return open;
}

function lastLine(world: MessagesWorld, ref: ThreadRef): string | undefined {
  return world.shown(ref).at(-1);
}

/** The click of Send as an offer made earlier carries it, handed straight to the core. */
function sends(world: MessagesWorld, ref: ThreadRef, offer: ReturnType<typeof offerIn>) {
  if (offer.list.type !== "suggestion") throw new Error("no suggestion offer");
  return world.inbound.picked({
    type: "suggestion",
    ref,
    session: offer.list.session,
    id: offer.list.id,
    send: true,
    list: offer.message,
  });
}

test("!next offers the suggestion the last turn ended with, and the text is shown nowhere else", async (t) => {
  const { world, ref } = await threadOf(t);
  assert.ok(!world.shown(ref).join("\n").includes(GUESS), "nothing shows the guess unasked");
  await world.says("!next", ref.thread);
  await world.settle();
  const offer = offerIn(world, ref);
  assert.equal(offer.list.type === "suggestion" && offer.list.text, GUESS);
  assert.equal(offer.title, texts.NEXT_TITLE);
  // In memory only: never in state.json.
  assert.ok(!readFileSync(join(world.folder, "state.json"), "utf8").includes(GUESS));
});

test("!next with no suggestion says so, naming the author", async (t) => {
  const agent = new PlainAgent({ suggestions: true });
  const world = await MessagesWorld.make(t, { agent, lists: true });
  agent.next(say("done"));
  const ref = await world.opened("add the feature");
  await world.says("!next", ref.thread);
  await world.settle();
  assert.equal(lastLine(world, ref), NONE);
  assert.equal(world.chat.threadLists().length, 0);
});

test("!next takes no argument, and is refused in the channel", async (t) => {
  const { world, ref } = await threadOf(t);
  await world.says("!next now", ref.thread);
  await world.settle();
  assert.equal(world.chat.threadLists().length, 0);
  await world.says("!next");
  await world.settle();
  assert.ok(world.inChannel().includes(texts.NEXT_TOP_LEVEL));
});

test("!next is not offered when the agent suggests nothing", async (t) => {
  const world = await MessagesWorld.make(t, { lists: true });
  const ref = await world.opened("hello");
  await world.says("!next", ref.thread);
  await world.settle();
  assert.match(lastLine(world, ref) ?? "", /`!next` is not offered here/);
});

test("Send sends the shown text as the owner's prompt and rewrites the offer to it", async (t) => {
  const { world, agent, ref } = await threadOf(t);
  agent.next(say("tests pass"));
  await world.says("!next", ref.thread);
  await world.settle();
  const offer = offerIn(world, ref);
  assert.equal(await world.chat.as("alice").picksSuggested(offer.message, true), true);
  await world.settle();
  assert.deepEqual(await world.prompts(), ["add the feature", GUESS]);
  assert.ok(world.shown(ref).some((line) => line === `> ${GUESS}`));
  // Gone from the thread's held state: a second `!next` has nothing.
  await world.says("!next", ref.thread);
  await world.settle();
  assert.equal(lastLine(world, ref), NONE);
});

test("Send goes by the path of a typed prompt: a daemon that is restarting refuses it", async (t) => {
  const { world, ref } = await threadOf(t);
  await world.says("!next", ref.thread);
  await world.settle();
  const offer = offerIn(world, ref);
  world.sessions.draining = true;
  await sends(world, ref, offer);
  await world.settle();
  assert.deepEqual(await world.prompts(), ["add the feature"]);
  assert.match(lastLine(world, ref) ?? "", new RegExp(texts.RESTARTING.slice(0, 20)));
});

test("a message of the owner's clears the suggestion: a later Send says the suggestion is out of date", async (t) => {
  const { world, agent, ref } = await threadOf(t);
  await world.says("!next", ref.thread);
  await world.settle();
  const offer = offerIn(world, ref);
  agent.next(say("on it"));
  await world.says("something else first", ref.thread);
  await world.settle();
  await sends(world, ref, offer);
  await world.settle();
  assert.deepEqual(await world.prompts(), ["add the feature", "something else first"]);
  assert.ok(world.shown(ref).includes(texts.NEXT_NOT_SENT), world.shown(ref).join("|"));
});

test("a message still waiting on its content has cleared it already", async (t) => {
  const { world, ref } = await threadOf(t);
  await world.says("!next", ref.thread);
  await world.settle();
  const offer = offerIn(world, ref);
  const read = new AsyncEvent();
  const typed = world.send({
    ref,
    id: "msg-typed",
    text: "with a file",
    content: async () => {
      await read.wait();
      return "with a file";
    },
  });
  await world.settle();
  const click = sends(world, ref, offer);
  await world.settle();
  assert.ok(world.shown(ref).includes(texts.NEXT_NOT_SENT), world.shown(ref).join("|"));
  read.set();
  await Promise.all([typed, click]);
  await world.settle();
  assert.deepEqual(await world.prompts(), ["add the feature", "with a file"]);
});

test("an offer made before a close and a resume is refused, the new suggestion kept", async (t) => {
  const { world, agent, ref } = await threadOf(t);
  await world.says("!next", ref.thread);
  await world.settle();
  const old = offerIn(world, ref);
  // The idle close: the process that made the guess is gone.
  await world.sessions.get(ref.channel, ref.thread)?.close();
  assert.equal(world.sessions.suggestions.held(ref), null);
  agent.next(say("resumed"), suggest("second guess"));
  await world.says("and now?", ref.thread);
  await world.settle();
  const fresh = world.sessions.suggestions.held(ref);
  assert.equal(fresh?.text, "second guess");
  await sends(world, ref, old);
  await world.settle();
  assert.ok(world.shown(ref).includes(texts.NEXT_NOT_SENT), world.shown(ref).join("|"));
  assert.equal(world.sessions.suggestions.held(ref)?.id, fresh?.id, "the new one is still held");
  assert.deepEqual(await world.prompts(), ["add the feature", "and now?"]);
});

test("a second click finds nothing", async (t) => {
  const { world, agent, ref } = await threadOf(t);
  agent.next(say("done again"));
  await world.says("!next", ref.thread);
  await world.settle();
  const offer = offerIn(world, ref);
  await Promise.all([sends(world, ref, offer), sends(world, ref, offer)]);
  await world.settle();
  assert.deepEqual(await world.prompts(), ["add the feature", GUESS]);
});

test("a double click on Send sends once and leaves the offer showing the sent words", async (t) => {
  const { world, agent, ref } = await threadOf(t);
  agent.next(say("done again"));
  await world.says("!next", ref.thread);
  await world.settle();
  const offer = offerIn(world, ref);
  const first = sends(world, ref, offer);
  await world.settle();
  const second = sends(world, ref, offer);
  await Promise.all([first, second]);
  await world.settle();
  assert.deepEqual(await world.prompts(), ["add the feature", GUESS]);
  assert.ok(world.shown(ref).includes(`> ${GUESS}`));
  assert.ok(!world.shown(ref).includes(texts.NEXT_NOT_SENT));
});

test("a word the core answers itself leaves the suggestion standing", async (t) => {
  const agent = new PlainAgent({ suggestions: true });
  const world = await MessagesWorld.make(t, { agent, lists: true, suggests: true });
  agent.next(say("done"), suggest(GUESS));
  const ref = await world.opened("add the feature");
  await world.says("!nosuchword", ref.thread);
  await world.settle();
  assert.equal(world.sessions.suggestions.held(ref)?.text, GUESS);
});

test("Send's prompt takes its place before a message typed while the offer is rewritten", async (t) => {
  // Open until the thread exists: its setup form is rewritten through the same gate.
  const rewrite = new AsyncEvent();
  rewrite.set();
  const { world, agent, ref } = await threadOf(t, { gates: { rewrite } });
  rewrite.clear();
  await world.says("!next", ref.thread);
  await world.settle();
  const offer = offerIn(world, ref);
  agent.next(say("one"), say("two"));
  const click = sends(world, ref, offer);
  const typed = world.says("typed during the rewrite", ref.thread);
  await world.settle();
  rewrite.set();
  await Promise.all([click, typed]);
  await world.settle();
  assert.deepEqual(await world.prompts(), ["add the feature", GUESS, "typed during the rewrite"]);
});

test("a thread with no session tells nothing when its first message is gone", async (t) => {
  const { world, ref } = await threadOf(t);
  const held = world.sessions.suggestions.held(ref);
  assert.ok(held);
  const session = world.state.thread(ref.channel, ref.thread)?.sessionId;
  assert.ok(session);
  assert.equal(world.sessions.hold(ref.channel, ref.thread), true);
  world.sessions.suggestions.hold(ref, GUESS);
  const again = world.sessions.suggestions.held(ref);
  assert.ok(again);
  world.chat.removeThread(ref);
  const before = world.shown(ref).length;
  await world.inbound.picked({
    type: "suggestion",
    ref,
    session,
    id: again.id,
    send: true,
    list: "msg-gone",
  });
  await world.settle();
  assert.equal(world.shown(ref).length, before);
  assert.deepEqual(await world.prompts(), ["add the feature"]);
  // The ticket was released: a stop of the thread finds nothing on its way.
  assert.equal(await world.inbound.stop(ref), false);
});

test("Cancel removes the offer and says nothing", async (t) => {
  const { world, ref } = await threadOf(t);
  await world.says("!next", ref.thread);
  await world.settle();
  const offer = offerIn(world, ref);
  const lines = world.shown(ref).length;
  assert.equal(await world.chat.as("alice").picksSuggested(offer.message, false), true);
  await world.settle();
  assert.equal(world.chat.threadLists().length, 0);
  assert.equal(world.shown(ref).length, lines - 1, "the offer's own message left, none came");
  assert.deepEqual(await world.prompts(), ["add the feature"]);
});

test("a suggestion that arrives while a prompt is owed is dropped", async (t) => {
  const agent = new PlainAgent({ suggestions: true });
  const world = await MessagesWorld.make(t, { agent, lists: true });
  const store = world.sessions.suggestions;
  const offered: string[] = [];
  const real = store.hold.bind(store);
  store.hold = (ref, text) => {
    offered.push(text);
    real(ref, text);
  };
  agent.next(say("first answer"), hold(), suggest("too early"));
  const ref = await world.opened("first prompt");
  // Queued behind the turn that runs: owed its answer when the first turn ends.
  agent.next(say("second answer"));
  await world.says("second prompt", ref.thread);
  await world.settle();
  world.agentSession().release();
  await world.settle();
  assert.deepEqual(offered, []);
  assert.deepEqual(await world.prompts(), ["first prompt", "second prompt"]);
});

test("a suggestion that arrives while a prompt of the thread is in flight is dropped", async (t) => {
  const agent = new PlainAgent({ suggestions: true });
  const world = await MessagesWorld.make(t, { agent, lists: true });
  agent.next(say("first answer"), hold(), suggest("too early"));
  const ref = await world.opened("first prompt");
  // Handed over, its content still being read: no prompt is owed yet, but one is on its way.
  const read = new AsyncEvent();
  const typed = world.send({
    ref,
    id: "msg-typed",
    text: "with a file",
    content: async () => {
      await read.wait();
      return "with a file";
    },
  });
  await world.settle();
  world.agentSession().release();
  await world.settle();
  // The owner stops it: it is never sent, and the guess made before it must not outlive it.
  await world.says("!stop", ref.thread);
  await world.settle();
  read.set();
  await typed;
  await world.settle();
  assert.equal(world.sessions.suggestions.held(ref), null);
  assert.deepEqual(await world.prompts(), ["first prompt"]);
});
