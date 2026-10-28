/**
 * `!fork` through the message flow: a copy of the thread's session in a new thread of the
 * channel, which inherits the effort and the bypass and starts on the prompt, while the original
 * goes on; made once a running turn has ended.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { Capabilities } from "../../../src/agent/seam.ts";
import type { ThreadRef } from "../../../src/chat/seam.ts";
import * as texts from "../../../src/core/texts.ts";
import { hold, PLAIN_CAPABILITIES, PlainAgent, say } from "../../support/plain-agent.ts";
import { MessagesWorld, PLAIN_NAMES, WithBypass } from "./messages-world.ts";

/** The thread of the channel that is not `origin`, once the fork made it. */
function copyOf(world: MessagesWorld, origin: ThreadRef): ThreadRef {
  const other = world.state.threads().find(([, thread]) => thread !== origin.thread);
  assert.ok(other, "a second thread holds the copy");
  return { channel: other[0], thread: other[1] };
}

test("!fork <prompt> opens a thread whose session is a copy and starts it on the prompt", async (t) => {
  const agent = new WithBypass();
  const world = await MessagesWorld.make(t, { agent });
  const origin = await world.opened("the first task");
  world.state.setEffort(origin.channel, origin.thread, "full");
  world.state.setBypass(origin.channel, origin.thread, true);
  const original = world.state.thread(origin.channel, origin.thread)?.sessionId;
  assert.ok(original);

  agent.next(say("Looking into it."));
  await world.says("!fork look into the timeout", origin.thread);
  await world.settle();

  const ref = copyOf(world, origin);
  const copied = world.state.thread(ref.channel, ref.thread);
  assert.ok(copied?.sessionId && copied.sessionId !== original, "a session of its own");
  assert.equal(copied.effort, "full");
  assert.equal(copied.bypass, true);
  assert.equal(world.state.thread(origin.channel, origin.thread)?.sessionId, original);
  const root = world.inChannel().find((line) => line.startsWith("Fork of "));
  assert.ok(root?.endsWith(": look into the timeout"), String(root));
  assert.equal(agent.starts.at(-1)?.resume, copied.sessionId, "the copy is what starts");
  const sent = await world.prompts();
  assert.ok(
    sent.includes("look into the timeout"),
    `${JSON.stringify(sent)} ${JSON.stringify(world.shown(ref))}`,
  );
  assert.ok(world.shown(ref).some((line) => line.includes("Looking into it.")));
  assert.equal(
    world.chat.requests().filter((r) => r.ref.thread === ref.thread).length,
    0,
    "no setup is asked in the copy's thread",
  );
  const line = world.shown(origin).at(-1) ?? "";
  assert.ok(line.startsWith("Forked into "), line);
  assert.ok(line.includes(" · running · ") && line.includes(copied.sessionId), line);
});

test("!fork alone opens the copy's thread and leaves it waiting", async (t) => {
  const agent = new PlainAgent();
  const world = await MessagesWorld.make(t, { agent });
  const origin = await world.opened("the first task");
  const starts = agent.starts.length;

  await world.says("!fork", origin.thread);
  await world.settle();

  const ref = copyOf(world, origin);
  assert.ok(world.inChannel().some((line) => line.startsWith("Fork of ") && !line.includes(": ")));
  assert.equal(agent.starts.length, starts, "nothing is sent to the copy");
  const line = world.shown(origin).at(-1) ?? "";
  assert.ok(line.includes("waiting for your first message there"), line);
  assert.ok(world.state.thread(ref.channel, ref.thread)?.sessionId);
});

test("!fork during a turn waits for it to end", async (t) => {
  const agent = new PlainAgent();
  const world = await MessagesWorld.make(t, { agent });
  const origin = await world.opened("the first task");
  agent.next(say("Working"), hold());
  await world.says("a long job", origin.thread);
  await world.settle();
  assert.equal(world.sessions.get(origin.channel, origin.thread)?.busy, true);

  const forking = world.says("!fork", origin.thread);
  await world.settle();
  assert.equal(world.state.threads().length, 1, "no copy while the turn runs");

  agent.sessions.at(-1)?.release();
  await forking;
  await world.settle();
  assert.equal(world.state.threads().length, 2);
});

test("!fork in the channel is refused", async (t) => {
  const world = await MessagesWorld.make(t);
  await world.says("!fork look into it");
  await world.settle();
  assert.ok(world.inChannel().includes(texts.FORK_TOP_LEVEL), world.inChannel().join("\n"));
  assert.equal(world.state.threads().length, 0);
});

class NoForks extends PlainAgent {
  override readonly capabilities: Capabilities = { ...PLAIN_CAPABILITIES, sessionForks: false };
}

test("!fork with an agent that cannot copy a session is refused, and nothing is opened", async (t) => {
  const agent = new NoForks();
  const world = await MessagesWorld.make(t, { agent });
  const origin = await world.opened("the first task");
  await world.says("!fork look into it", origin.thread);
  await world.settle();
  const refusal = texts.named(texts.FORK_UNAVAILABLE, PLAIN_NAMES);
  assert.ok(world.shown(origin).includes(refusal), world.shown(origin).join("\n"));
  assert.equal(world.state.threads().length, 1);
});

test("!fork of a session that works in an earlier folder of the channel is refused", async (t) => {
  const world = await MessagesWorld.make(t);
  const origin = await world.opened("the first task");
  world.state.bind(world.channel, join(world.folder, "elsewhere"));
  await world.says("!fork look into it", origin.thread);
  await world.settle();
  assert.ok(world.shown(origin).includes(texts.FORK_OLD_FOLDER), world.shown(origin).join("\n"));
  assert.equal(world.state.threads().length, 1, "no copy's thread");
});

test("!fork while allaboard waits to restart makes no copy", async (t) => {
  const agent = new PlainAgent();
  const world = await MessagesWorld.make(t, { agent });
  const origin = await world.opened("the first task");
  world.sessions.draining = true;
  await world.says("!fork look into it", origin.thread);
  await world.settle();
  assert.equal(world.state.threads().length, 1, "no copy's thread");
  assert.ok(!world.inChannel().some((line) => line.startsWith("Fork of ")));
});
