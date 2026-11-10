/**
 * A bare `!fork` copy (#141): it starts no process and shows no status until its first turn, and
 * the first prompt with text names it through the live session, once.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Capabilities } from "../../../src/agent/seam.ts";
import type { ThreadRef } from "../../../src/chat/seam.ts";
import * as texts from "../../../src/core/texts.ts";
import { PLAIN_CAPABILITIES, PlainAgent, say } from "../../support/plain-agent.ts";
import { MessagesWorld } from "./messages-world.ts";

/** A world with an original thread and its bare copy, and the copy's thread. */
async function bareCopy(t: Parameters<typeof MessagesWorld.make>[0], agent = new PlainAgent()) {
  // A chat with reactions, so that the root's status is drawn and kept.
  const world = await MessagesWorld.make(t, { agent, reactions: true });
  const origin = await world.opened("the first task");
  await world.says("!fork", origin.thread);
  await world.settle();
  const other = world.state.threads().find(([, thread]) => thread !== origin.thread);
  assert.ok(other, "a second thread holds the copy");
  const ref: ThreadRef = { channel: other[0], thread: other[1] };
  return { world, agent, origin, ref };
}

/** What the root shows, as the entry keeps it: a running status, else the one a turn ended with. */
const shownStatus = (world: MessagesWorld, ref: ThreadRef) => {
  const entry = stored(world, ref);
  return entry.status ?? entry.ended;
};

function stored(world: MessagesWorld, ref: ThreadRef) {
  const entry = world.state.thread(ref.channel, ref.thread);
  assert.ok(entry);
  return entry;
}

/** Every name the agent's sessions were given, in order. */
const renames = (agent: PlainAgent): string[] => agent.sessions.flatMap((s) => s.renames);

test("a bare fork starts no process and the copy's root shows no status", async (t) => {
  const { world, agent, ref } = await bareCopy(t);
  assert.equal(agent.sessions.length, 1, "only the original's process is live");
  const copy = stored(world, ref);
  assert.equal(copy.forkRan, false);
  assert.equal(copy.forkNamed, false);
  assert.equal(shownStatus(world, ref), null);
});

test("a fork with a prompt is born ran and named", async (t) => {
  const agent = new PlainAgent();
  const world = await MessagesWorld.make(t, { agent });
  const origin = await world.opened("the first task");
  agent.next(say("On it."));
  await world.says("!fork look into it", origin.thread);
  await world.settle();
  const other = world.state.threads().find(([, thread]) => thread !== origin.thread);
  assert.ok(other);
  const copy = stored(world, { channel: other[0], thread: other[1] });
  assert.equal(copy.forkRan, true);
  assert.equal(copy.forkNamed, true);
  assert.deepEqual(renames(agent), [], "named by the fork itself");
});

test("a word first connects the copy, then the first prompt renames it once", async (t) => {
  const { world, agent, ref } = await bareCopy(t);
  await world.says("!status", ref.thread);
  await world.settle();
  assert.equal(agent.sessions.length, 2, "the word started the copy's process");
  assert.equal(shownStatus(world, ref), null, "no status for a copy that has not run");
  assert.deepEqual(renames(agent), []);

  agent.next(say("Done."));
  await world.says("fix the timeout", ref.thread);
  await world.settle();
  assert.deepEqual(renames(agent), ["fix the timeout"]);
  const copy = stored(world, ref);
  assert.equal(copy.forkRan, true);
  assert.equal(copy.forkNamed, true);

  agent.next(say("Again."));
  await world.says("and the retry", ref.thread);
  await world.settle();
  assert.deepEqual(renames(agent), ["fix the timeout"], "named once");
});

test("the title is the plain text, not the chat's markup", async (t) => {
  const { world, agent, ref } = await bareCopy(t);
  agent.next(say("Done."));
  await world.send({
    ref,
    id: "msg-title",
    text: "ask <@U1> about *the* timeout",
    plain: "ask @alice about the timeout",
  });
  await world.settle();
  assert.deepEqual(renames(agent), ["ask @alice about the timeout"]);
});

test("a passthrough command first runs the copy but names nothing; the next prompt names it", async (t) => {
  const { world, agent, ref } = await bareCopy(t);
  agent.next(say("hi"));
  await world.says("!echo hi", ref.thread);
  await world.settle();
  assert.deepEqual(renames(agent), []);
  const after = stored(world, ref);
  assert.equal(after.forkRan, true, "a turn of any kind ends the wait for a status");
  assert.equal(after.forkNamed, false);

  agent.next(say("Done."));
  await world.says("now the real task", ref.thread);
  await world.settle();
  assert.deepEqual(renames(agent), ["now the real task"]);
  assert.equal(stored(world, ref).forkNamed, true);
});

test("a message with files and no text names nothing; the next text prompt does", async (t) => {
  const { world, agent, ref } = await bareCopy(t);
  agent.next(say("Seen."));
  await world.send({
    ref,
    id: "msg-files",
    text: "",
    plain: "",
    literal: true,
    content: async () => "Attached files: /tmp/a.txt",
  });
  await world.settle();
  assert.deepEqual(renames(agent), []);
  assert.equal(stored(world, ref).forkRan, true);
  assert.equal(stored(world, ref).forkNamed, false);

  agent.next(say("Done."));
  await world.says("read it", ref.thread);
  await world.settle();
  assert.deepEqual(renames(agent), ["read it"]);
});

test("the prompt that names the copy waits until every prompt sent before it is answered", async (t) => {
  // An agent that takes a prompt in at once hides the records of a prompt sent before a rename,
  // and the prompt may be sent while its turn has not begun.
  const agent = new PlainAgent({ promptDuringTurn: true });
  const { world, ref } = await bareCopy(t, agent);
  await world.says("!status", ref.thread); // connects the copy
  await world.settle();
  const copy = agent.sessions.at(-1);
  assert.ok(copy);
  let begin!: () => void;
  copy.playGate = new Promise<void>((resolve) => {
    begin = resolve;
  });
  agent.next(say("Seen."));
  await world.send({
    ref,
    id: "msg-files",
    text: "",
    plain: "",
    literal: true,
    content: async () => "Attached files: /tmp/a.txt",
  });
  await world.settle();
  assert.equal(copy.prompts.length, 1, "the first prompt is sent, its turn not begun");

  await world.says("read it", ref.thread);
  await world.settle();
  assert.deepEqual(renames(agent), [], "no rename behind a prompt that is not answered");
  assert.equal(copy.prompts.length, 1, "nor the prompt that carries the title");

  begin();
  await world.settle();
  assert.deepEqual(renames(agent), ["read it"]);
  assert.equal(copy.prompts.length, 2);
});

test("a hold cancelled before any turn leaves the root with no status", async (t) => {
  const { world, ref } = await bareCopy(t);
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session);
  session.holdStart();
  await session.holdEnd({ continued: false });
  assert.equal(shownStatus(world, ref), null);
  await session.reactHoldAbandoned({ error: false });
  assert.equal(shownStatus(world, ref), null);
});

test("a turn the agent opens in a copy that never ran ends with its status", async (t) => {
  const { world, agent, ref } = await bareCopy(t);
  await world.says("!status", ref.thread);
  await world.settle();
  assert.equal(shownStatus(world, ref), null);
  const process = agent.sessions.at(-1);
  assert.ok(process);
  process.emit({ type: "peer_message", text: "a note" });
  process.emit({
    type: "turn_ended",
    sessionId: stored(world, ref).sessionId,
    startedBy: "agent",
    finalText: "Noted.",
    ending: "done",
    steps: 1,
    answers: [],
    tokens: {},
  });
  await world.settle();
  const copy = stored(world, ref);
  assert.equal(copy.forkRan, true);
  assert.equal(shownStatus(world, ref), "done");
});

test("a rename cut by a close keeps the copy waiting for its name, across a restart", async (t) => {
  const { world, agent, ref } = await bareCopy(t);
  await world.says("!status", ref.thread);
  await world.settle();
  const process = agent.sessions.at(-1);
  assert.ok(process);
  process.renameGate = new Promise(() => {});
  await world.says("first words", ref.thread);
  await world.settle();
  assert.deepEqual(process.renames, ["first words"], "the rename is in flight");

  await world.sessions.closeAll();
  const copy = stored(world, ref);
  assert.equal(copy.forkNamed, false, "no result arrived");
  assert.equal(copy.forkRan, true);

  const restarted = await MessagesWorld.make(t, { agent, reactions: true, restartOf: world });
  assert.equal(stored(restarted, ref).forkNamed, false, "the flags survive a restart");
  agent.next(say("Done."));
  await restarted.says("second words", ref.thread);
  await restarted.settle();
  assert.deepEqual(renames(agent), ["first words", "second words"]);
  assert.equal(stored(restarted, ref).forkNamed, true);
});

test("a restart before the first message keeps a bare copy bare", async (t) => {
  const { world, agent, ref } = await bareCopy(t);
  await world.sessions.closeAll();
  const restarted = await MessagesWorld.make(t, { agent, reactions: true, restartOf: world });
  const copy = stored(restarted, ref);
  assert.equal(copy.forkRan, false);
  assert.equal(copy.forkNamed, false);
  agent.next(say("Done."));
  await restarted.says("name me", ref.thread);
  await restarted.settle();
  assert.deepEqual(renames(agent), ["name me"]);
});

test("an agent with no rename names nothing and the copy still works", async (t) => {
  class NoRename extends PlainAgent {
    override readonly capabilities: Capabilities = { ...PLAIN_CAPABILITIES, sessionRename: false };
  }
  const { world, agent, ref } = await bareCopy(t, new NoRename());
  agent.next(say("Done."));
  await world.says("hello there", ref.thread);
  await world.settle();
  assert.deepEqual(renames(agent), []);
});

test("an original with no title is linked as the original thread", async (t) => {
  const agent = new PlainAgent();
  const world = await MessagesWorld.make(t, { agent });
  const origin = await world.opened("the first task");
  // The memory chat gives no link; for this test its thread writes the label it was asked for.
  const proto = Object.getPrototypeOf(world.provider.thread(origin));
  const real = proto.link;
  proto.link = async (label: string) => `[${label}]`;
  t.after(() => {
    proto.link = real;
  });
  await world.says("!fork", origin.thread);
  await world.settle();
  const root = world.inChannel().find((line) => line.startsWith("Fork of "));
  assert.equal(root, `Fork of [${texts.FORK_ORIGINAL_LABEL}]`);
});

test("the rename waits for a turn the agent opened, and runs on an idle session", async (t) => {
  class During extends PlainAgent {
    override readonly capabilities: Capabilities = {
      ...PLAIN_CAPABILITIES,
      promptDuringTurn: true,
    };
  }
  const { world, agent, ref } = await bareCopy(t, new During());
  await world.says("!status", ref.thread);
  await world.settle();
  const process = agent.sessions.at(-1);
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(process && session);
  const busyAtRename: boolean[] = [];
  const rename = process.rename.bind(process);
  process.rename = async (title) => {
    busyAtRename.push(session.busy);
    await rename(title);
  };
  process.emit({ type: "peer_message", text: "a note" });
  await world.settle();
  assert.equal(session.busy, true, "the agent's own turn is running");

  agent.next(say("Done."));
  await world.says("fix the timeout", ref.thread);
  await world.settle();
  assert.deepEqual(busyAtRename, [], "no rename while the turn runs");

  process.emit({
    type: "turn_ended",
    sessionId: stored(world, ref).sessionId,
    startedBy: "agent",
    finalText: "Noted.",
    ending: "done",
    steps: 1,
    answers: [],
    tokens: {},
  });
  await world.settle();
  assert.deepEqual(busyAtRename, [false]);
  assert.deepEqual(renames(agent), ["fix the timeout"]);
  assert.equal(stored(world, ref).forkNamed, true);
});

test("an unknown word sent as a prompt still names the copy; a copy of another session does not wait", async (t) => {
  const { world, agent, ref } = await bareCopy(t);
  agent.next(say("Done."));
  await world.says("!nosuchword and more", ref.thread);
  await world.settle();
  assert.deepEqual(renames(agent), ["!nosuchword and more"]);
  world.state.setSession(ref.channel, ref.thread, "another-session");
  assert.equal(stored(world, ref).forkNamed, true);
  assert.equal(stored(world, ref).forkRan, true);
});

/** A plain agent that takes a prompt during a turn and runs background tasks. */
class Background extends PlainAgent {
  override readonly capabilities: Capabilities = {
    ...PLAIN_CAPABILITIES,
    promptDuringTurn: true,
    backgroundTasks: true,
  };
}

const agentTurnEnd = (sessionId: string | null) =>
  ({
    type: "turn_ended",
    sessionId,
    startedBy: "agent",
    finalText: "Noted.",
    ending: "done",
    steps: 1,
    answers: [],
    tokens: {},
  }) as const;

test("the rename waits for a report turn the core already expects", async (t) => {
  const { world, agent, ref } = await bareCopy(t, new Background());
  await world.says("!status", ref.thread);
  await world.settle();
  const process = agent.sessions.at(-1);
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(process && session);
  const inside = session as unknown as {
    settled: { isSet: boolean };
    injectedExpected: boolean;
    active: unknown;
  };
  const at: Array<{ settled: boolean; expected: boolean; active: boolean }> = [];
  const rename = process.rename.bind(process);
  process.rename = async (title) => {
    at.push({
      settled: inside.settled.isSet,
      expected: inside.injectedExpected,
      active: inside.active !== null,
    });
    await rename(title);
  };
  const id = stored(world, ref).sessionId;
  process.emit({ type: "peer_message", text: "a note" });
  await world.settle();
  agent.next(say("Done."));
  await world.says("fix the timeout", ref.thread);
  await world.settle();
  assert.deepEqual(at, [], "no rename while the agent's turn runs");

  // The turn ends and a task's notification follows in the same breath: a report turn is expected.
  process.emit(agentTurnEnd(id));
  process.emit({
    type: "task_ended",
    taskId: "task-1",
    status: "completed",
    summary: "done",
    durationMs: null,
    callId: null,
    report: null,
    reportSent: false,
    foldNamed: false,
  });
  await world.settle();
  assert.deepEqual(at, [], "no rename while a report turn is expected");

  process.emit({ type: "text", text: "The task finished." });
  process.emit(agentTurnEnd(id));
  await world.settle();
  assert.deepEqual(at, [{ settled: true, expected: false, active: false }]);
  assert.deepEqual(renames(agent), ["fix the timeout"]);
});

test("a stop during the wait for the agent's turn renames nothing", async (t) => {
  const { world, agent, ref } = await bareCopy(t, new Background());
  await world.says("!status", ref.thread);
  await world.settle();
  const process = agent.sessions.at(-1);
  assert.ok(process);
  process.emit({ type: "peer_message", text: "a note" });
  await world.settle();
  await world.says("fix the timeout", ref.thread);
  await world.settle();
  const stopping = world.says("!stop", ref.thread);
  await world.settle();
  process.emit(agentTurnEnd(stored(world, ref).sessionId));
  await stopping;
  await world.settle();
  assert.deepEqual(renames(agent), []);
  assert.equal(stored(world, ref).forkNamed, false);
});
