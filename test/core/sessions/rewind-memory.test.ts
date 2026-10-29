/**
 * What `!rewind` remembers of a thread: the messages of each prompt's replies, kept in memory.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Reply } from "../../../src/chat/seam.ts";
import { REPLIES_KEPT, RewindMemory } from "../../../src/core/sessions/rewind-memory.ts";

/** A reply that has posted `ids`; more can be added as it goes on. */
function replyWith(ids: string[]): Reply & { ids: string[] } {
  return { ids, posted: () => ids } as unknown as Reply & { ids: string[] };
}

test("the messages from a prompt on are those of its replies and of every later one's", () => {
  const memory = new RewindMemory();
  memory.begin("p1", replyWith(["m1"]));
  memory.begin("p2", replyWith(["m2", "m3"]));
  memory.begin("p3", replyWith(["m4"]));
  assert.deepEqual(memory.messagesOf(["p2", "p3"]), ["m2", "m3", "m4"]);
  assert.deepEqual(memory.messagesOf(["p1", "p2", "p3"]), ["m1", "m2", "m3", "m4"]);
});

test("a reply the agent started belongs to the prompt before it, and a continued reply counts once", () => {
  const memory = new RewindMemory();
  const first = replyWith(["m1"]);
  memory.begin("p1", first);
  const report = replyWith(["m2"]);
  memory.add(report);
  memory.add(report);
  memory.add(first);
  memory.begin("p2", replyWith(["m3"]));
  assert.deepEqual(memory.messagesOf(["p1", "p2"]), ["m1", "m2", "m3"]);
  assert.deepEqual(memory.messagesOf(["p2"]), ["m3"]);
});

test("messages a reply posts after the prompt began are read when they are needed", () => {
  const memory = new RewindMemory();
  const reply = replyWith(["m1"]);
  memory.begin("p1", reply);
  reply.ids.push("m2");
  assert.deepEqual(memory.messagesOf(["p1"]), ["m1", "m2"]);
});

test("a prompt that was not remembered has no messages and is not known", () => {
  const memory = new RewindMemory();
  memory.begin("p1", replyWith(["m1"]));
  assert.equal(memory.knows(["p1"]), true);
  assert.equal(memory.knows(["older"]), false);
  assert.equal(memory.knows(["older", "p1"]), true);
  assert.deepEqual(memory.messagesOf(["older"]), []);
});

test("the messages of the dropped prompts are found when the picked one was not remembered", () => {
  const memory = new RewindMemory();
  memory.begin("p2", replyWith(["m2"]));
  memory.begin("p3", replyWith(["m3"]));
  assert.deepEqual(memory.messagesOf(["p1", "p2", "p3", "p4"]), ["m2", "m3"]);
});

test("forgetting the dropped prompts leaves the others", () => {
  const memory = new RewindMemory();
  memory.begin("p1", replyWith(["m1"]));
  memory.begin("p2", replyWith(["m2"]));
  memory.begin("p3", replyWith(["m3"]));
  memory.forgetIds(["p2", "p3", "p9"]);
  assert.equal(memory.knows(["p2"]), false);
  assert.deepEqual(memory.messagesOf(["p1", "p2"]), ["m1"]);
});

test("a memory with nothing in it and no cut waiting is empty", () => {
  const memory = new RewindMemory();
  assert.equal(memory.empty, true);
  memory.begin("p1", replyWith(["m1"]));
  assert.equal(memory.empty, false);
  memory.forgetIds(["p1"]);
  assert.equal(memory.empty, true);
  memory.cutAt = "p1";
  assert.equal(memory.empty, false);
});

test("settling keeps the messages and lets go of the replies", () => {
  const memory = new RewindMemory();
  const reply = replyWith(["m1"]);
  memory.begin("p1", reply);
  memory.settle();
  reply.ids.push("late");
  assert.deepEqual(memory.messagesOf(["p1"]), ["m1"]);
});

test("only the newest prompts are kept", () => {
  const memory = new RewindMemory();
  for (let n = 0; n < REPLIES_KEPT + 3; n += 1) memory.begin(`p${n}`, replyWith([`m${n}`]));
  assert.equal(memory.knows(["p0"]), false);
  assert.equal(memory.knows(["p3"]), true);
});

test("a chat whose replies list no messages remembers nothing", () => {
  const memory = new RewindMemory();
  memory.begin("p1", {} as Reply);
  assert.equal(memory.knows(["p1"]), false);
});
