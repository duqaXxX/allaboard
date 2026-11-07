/**
 * Which drops of an agent's client let its process exit on its own (`close({ awaitExit })`), and
 * that a client's report is posted once. The plain agent's session records the options of each
 * close and returns the report a test sets.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession } from "../../../src/agent/seam.ts";
import { PlainAgent, PlainStore, say } from "../../support/plain-agent.ts";
import { MessagesWorld } from "./messages-world.ts";

async function threadOf(t: Parameters<typeof MessagesWorld.make>[0]) {
  const agent = new PlainAgent({
    store: new PlainStore(),
    rewind: { files: true, conversation: true },
  });
  const world = await MessagesWorld.make(t, { agent, rewind: true });
  agent.next(say("first answer"));
  const ref = await world.opened("add the first feature");
  await world.settle();
  const [first] = world.agentSession().prompts.map((prompt) => prompt.id);
  assert.ok(first);
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session);
  return { world, agent, ref, first, session };
}

test("a rewind's drop lets the process exit on its own", async (t) => {
  const { agent, session, first } = await threadOf(t);
  await session.rewindConversation(first, [first]);
  assert.deepEqual(agent.sessions[0]?.closeCalls, [{ awaitExit: true }]);
});

test("the move to a terminal closes without waiting", async (t) => {
  const { agent, session } = await threadOf(t);
  await session.moveToTerminal();
  assert.deepEqual(agent.sessions[0]?.closeCalls, [{ awaitExit: false }]);
});

test("deleting a thread closes its session without waiting", async (t) => {
  const { world, agent, ref } = await threadOf(t);
  assert.equal(await world.sessions.release(ref.channel, ref.thread), true);
  assert.deepEqual(agent.sessions[0]?.closeCalls, [{ awaitExit: false }]);
});

test("a client that is disconnected twice is reported once", async (t) => {
  const { world, agent, ref, session } = await threadOf(t);
  const plain = agent.sessions[0];
  assert.ok(plain);
  plain.report = { unsaved: { conversation: true, settings: false, cause: "quota" } };
  const inner = session as unknown as {
    disconnect(client: AgentSession, awaitExit: boolean): Promise<void>;
    announceUnsaved(): Promise<void>;
  };
  await inner.disconnect(plain, false);
  await inner.disconnect(plain, false);
  await inner.announceUnsaved();
  const shown = world.shown(ref).filter((line) => line.includes("could not save"));
  assert.equal(shown.length, 1);
});

test("the drop that undoes a setup closes without waiting", async (t) => {
  const { agent, session } = await threadOf(t);
  // The thread ran a turn; the setup's undo is for one that did not, which these two stand for.
  Object.defineProperty(session, "neverRan", { get: () => true });
  (session as unknown as { setupApplied: boolean }).setupApplied = true;
  await session.forgetSetup();
  assert.deepEqual(agent.sessions[0]?.closeCalls, [{ awaitExit: false }]);
});
