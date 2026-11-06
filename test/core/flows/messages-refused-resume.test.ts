/**
 * A thread whose stored session the agent refuses to resume (its transcript is gone): the thread
 * keeps its entry (#148), the owner is told once per attempt, and every flow that retries on a
 * closed session stops on the refusal instead of looping. The plain agent refuses through the
 * seam's `ResumeRefused`, as any agent would.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThreadRef } from "../../../src/chat/seam.ts";
import * as texts from "../../../src/core/texts.ts";
import { named } from "../../../src/core/texts.ts";
import { AsyncEvent } from "../../support/fake-clock.ts";
import type { PlainAgent } from "../../support/plain-agent.ts";
import { MessagesWorld, PLAIN_NAMES, WithSessionTags } from "./messages-world.ts";

const GONE = named(texts.SESSION_GONE, PLAIN_NAMES);

/** A thread that ran, its session closed, and the agent's transcript of it gone. */
async function refused(t: Parameters<typeof MessagesWorld.make>[0], agent?: PlainAgent) {
  const world = await MessagesWorld.make(t, agent === undefined ? {} : { agent, tags: true });
  const ref = await world.opened();
  const id = world.state.thread(ref.channel, ref.thread)?.sessionId;
  assert.ok(typeof id === "string");
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session !== null);
  await session.close();
  const store = (world.agent as PlainAgent).store;
  const transcript = store.forget(id);
  assert.ok(transcript !== undefined);
  return { world, ref, id, store, transcript };
}

/** The owner writes in the thread, and what that starts has ended. */
async function say(world: MessagesWorld, text: string, ref: ThreadRef): Promise<void> {
  await world.says(text, ref.thread);
  await world.settle();
}

const kept = (world: MessagesWorld, ref: ThreadRef) =>
  world.state.thread(ref.channel, ref.thread)?.sessionId;

test("a refused resume says session gone and keeps the thread's entry", async (t) => {
  const { world, ref, id } = await refused(t);
  await say(world, "more", ref);
  await world.settle();
  assert.equal(world.shown(ref).at(-1), GONE);
  assert.equal(kept(world, ref), id);
});

test("every start tries the resume again, and a transcript that came back is used", async (t) => {
  const { world, ref, id, store, transcript } = await refused(t);
  await say(world, "more", ref);
  await say(world, "and more", ref);
  assert.deepEqual(
    world.shown(ref).filter((line) => line === GONE),
    [GONE, GONE],
    "retried, refused again",
  );
  store.bring(transcript);
  await say(world, "third", ref);
  assert.equal(world.shown(ref).at(-1) === GONE, false);
  assert.ok((await world.prompts()).includes("third"));
  assert.equal(kept(world, ref), id);
});

test("a command in a refused thread ends with one answer", async (t) => {
  const { world, ref } = await refused(t);
  await say(world, "/echo hi", ref);
  assert.equal(world.shown(ref).at(-1), GONE);
  assert.deepEqual(await world.prompts(), ["first"], "nothing reached the agent");
});

test("a message whose submit lands after the first refusal closed the session is answered once", async (t) => {
  const { world, ref } = await refused(t);
  const slow = new AsyncEvent();
  const first = world.send({ ref, id: "one", text: "one", content: async () => "one" });
  // Held in its download while the first one's refusal closes the session it holds.
  const second = world.send({
    ref,
    id: "two",
    text: "two",
    content: async () => {
      await slow.wait();
      return "two";
    },
  });
  await first;
  await world.settle();
  slow.set();
  await second;
  await world.settle();
  assert.equal(world.shown(ref).filter((line) => line === GONE).length, 2, "one each");
  assert.deepEqual(await world.prompts(), ["first"], "nothing reached the agent");
});

test("a word that connects ends on the refusal and the thread stays", async (t) => {
  const { world, ref, id } = await refused(t);
  await say(world, "!status", ref);
  await say(world, "!fork look", ref);
  assert.equal(kept(world, ref), id);
  assert.equal(world.state.threads().length, 1, "no thread was opened for a copy");
});

test("!tag on a refused session tags the root and tells the agent failed", async (t) => {
  const agent = new WithSessionTags(true);
  const { world, ref } = await refused(t, agent);
  await say(world, "!tag devops", ref);
  assert.deepEqual(world.tagCalls, [[ref, "devops"]]);
  assert.equal(world.shown(ref).at(-1), named(texts.TAG_AGENT_FAILED, PLAIN_NAMES));
});
