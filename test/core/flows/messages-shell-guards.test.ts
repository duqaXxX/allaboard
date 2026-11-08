/**
 * `!!command` passes the guards a typed prompt passes before it can wake its session (#240): the
 * same-folder hold and the terminal that holds the session are asked before the command's own
 * confirmation, and a Cancel there runs nothing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as texts from "../../../src/core/texts.ts";
import { OWNER } from "../../support/memory-chat.ts";
import { hold, PlainAgent, say } from "../../support/plain-agent.ts";
import { MessagesWorld } from "./messages-world.ts";

/** The types of the requests open in the thread, oldest first. */
function openTypes(world: MessagesWorld, thread: string): string[] {
  return world.chat
    .requests()
    .filter((open) => open.ref.thread === thread)
    .map((open) => open.request.type);
}

test("!! beside a terminal that holds the session asks about the terminal first", async (t) => {
  const agent = new PlainAgent({ terminal: true, shell: {} });
  const world = await MessagesWorld.make(t, { agent });
  const ref = await world.opened();
  const id = world.state.thread(ref.channel, ref.thread)?.sessionId;
  assert.ok(id);
  agent.holders.set(id, [{ id: "77", own: false, busy: false }]);
  const sending = world.says("!!ls", ref.thread);
  const terminal = await world.asked("terminal", ref);
  assert.deepEqual(openTypes(world, ref.thread), ["terminal"]);
  await world.chat.as(OWNER).answers(terminal.requestId, { type: "terminal", go: true });
  const shell = await world.asked("shell", ref);
  agent.next(say("listed"));
  await world.chat.as(OWNER).answers(shell.requestId, { type: "shell", run: true });
  await sending;
  await world.settle();
  assert.ok((await world.prompts()).some((told) => told.startsWith("ran ls (")));
});

test("!! with Cancel on the terminal question runs nothing", async (t) => {
  const agent = new PlainAgent({ terminal: true, shell: {} });
  const world = await MessagesWorld.make(t, { agent });
  const ref = await world.opened();
  const id = world.state.thread(ref.channel, ref.thread)?.sessionId;
  assert.ok(id);
  agent.holders.set(id, [{ id: "77", own: false, busy: false }]);
  const before = (await world.prompts()).length;
  const sending = world.says("!!ls", ref.thread);
  const terminal = await world.asked("terminal", ref);
  await world.chat.as(OWNER).answers(terminal.requestId, { type: "terminal", go: false });
  await sending;
  await world.settle();
  assert.deepEqual(openTypes(world, ref.thread), []);
  assert.equal((await world.prompts()).length, before);
  assert.ok(world.shown(ref).includes(texts.NOT_SENT));
});

test("!! beside a busy session of the same folder asks the hold first", async (t) => {
  const agent = new PlainAgent({ shell: {} });
  const world = await MessagesWorld.make(t, { agent });
  const ref = await world.opened("one");
  const neighbour = await world.opened("two");
  agent.next(hold());
  await world.says("a long job", neighbour.thread);
  await world.settle();
  const sending = world.says("!!ls", ref.thread);
  const asked = await world.asked("hold", ref);
  assert.deepEqual(openTypes(world, ref.thread), ["hold"]);
  await world.chat.as(OWNER).answers(asked.requestId, { type: "hold", send: true });
  const shell = await world.asked("shell", ref);
  agent.next(say("listed"));
  await world.chat.as(OWNER).answers(shell.requestId, { type: "shell", run: true });
  await sending;
  await world.settle();
  assert.ok((await world.prompts()).some((told) => told.startsWith("ran ls (")));
});

/** A thread beside another of the same folder that works on a turn held open. */
async function besideBusy(t: Parameters<typeof MessagesWorld.make>[0]) {
  const agent = new PlainAgent({ shell: {} });
  const world = await MessagesWorld.make(t, { agent });
  const ref = await world.opened("one");
  const neighbour = await world.opened("two");
  agent.next(hold());
  await world.says("a long job", neighbour.thread);
  await world.settle();
  return { agent, world, ref };
}

const waiting = (world: MessagesWorld, ref: { channel: string; thread: string }) =>
  world.state.thread(ref.channel, ref.thread)?.status === "waiting";

test("!! after Send anyway is not asked the hold again for the same busy session", async (t) => {
  const { agent, world, ref } = await besideBusy(t);
  const sending = world.says("!!ls", ref.thread);
  const asked = await world.asked("hold", ref);
  await world.chat.as(OWNER).answers(asked.requestId, { type: "hold", send: true });
  const shell = await world.asked("shell", ref);
  agent.next(say("listed"));
  await world.chat.as(OWNER).answers(shell.requestId, { type: "shell", run: true });
  await world.settle();
  assert.deepEqual(openTypes(world, ref.thread), [], "no second hold question");
  await sending;
  assert.ok((await world.prompts()).some((told) => told.startsWith("ran ls (")));
});

test("!! with Cancel on the hold asks no Run and runs nothing", async (t) => {
  const { world, ref } = await besideBusy(t);
  const before = (await world.prompts()).length;
  const sending = world.says("!!ls", ref.thread);
  const asked = await world.asked("hold", ref);
  await world.chat.as(OWNER).answers(asked.requestId, { type: "hold", send: false });
  await sending;
  await world.settle();
  assert.deepEqual(openTypes(world, ref.thread), []);
  assert.equal((await world.prompts()).length, before);
  assert.equal(waiting(world, ref), false);
});

test("!! with Cancel on Run after Send anyway runs nothing and leaves no waiting mark", async (t) => {
  const { world, ref } = await besideBusy(t);
  const before = (await world.prompts()).length;
  const sending = world.says("!!ls", ref.thread);
  const asked = await world.asked("hold", ref);
  await world.chat.as(OWNER).answers(asked.requestId, { type: "hold", send: true });
  const shell = await world.asked("shell", ref);
  await world.chat.as(OWNER).answers(shell.requestId, { type: "shell", run: false });
  await sending;
  await world.settle();
  assert.equal((await world.prompts()).length, before);
  assert.equal(waiting(world, ref), false);
});

test("a terminal turn started while Run waits is waited out before the command goes", async (t) => {
  const agent = new PlainAgent({ terminal: true, shell: {} });
  const world = await MessagesWorld.make(t, { agent });
  const ref = await world.opened();
  const id = world.state.thread(ref.channel, ref.thread)?.sessionId;
  assert.ok(id);
  agent.holders.set(id, [{ id: "77", own: false, busy: false }]);
  const before = (await world.prompts()).length;
  const sending = world.says("!!ls", ref.thread);
  const terminal = await world.asked("terminal", ref);
  await world.chat.as(OWNER).answers(terminal.requestId, { type: "terminal", go: true });
  const shell = await world.asked("shell", ref);
  // the owner starts a turn in the terminal before clicking Run
  agent.holders.set(id, [{ id: "77", own: false, busy: true }]);
  await world.chat.as(OWNER).answers(shell.requestId, { type: "shell", run: true });
  const busy = await world.asked("terminal", ref);
  assert.equal((await world.prompts()).length, before, "nothing reached the session");
  await world.chat.as(OWNER).answers(busy.requestId, { type: "terminal", go: false });
  await sending;
  await world.settle();
  assert.equal((await world.prompts()).length, before);
  assert.ok(world.shown(ref).includes(texts.NOT_SENT));
});
