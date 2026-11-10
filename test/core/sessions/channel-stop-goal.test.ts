// A channel `!stop` drops the goal once the messages sent before it have run (#251; design
// `2026-11-10-251-goal-drop-after-queued-design.md`): a debt raised at the stop's start, paid when
// the session is idle, which no prompt passes.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { RequestHandler, StartOptions } from "../../../src/agent/seam.ts";
import {
  hold,
  PLAIN_CAPABILITIES,
  PlainAgent,
  type PlainSession,
  say,
} from "../../support/plain-agent.ts";
import { settledTurn } from "../../support/settle.ts";
import { AskingWorld } from "../flows/asking-world.ts";

async function until(what: string, test: () => boolean): Promise<void> {
  for (let round = 0; round < 200 && !test(); round += 1) await settledTurn();
  assert.ok(test(), what);
}

// The command touches a file, which Windows has no `touch` for.
const POSIX_SHELL = { skip: process.platform === "win32" && "the command needs a POSIX shell" };

const sent = (agent: PlainAgent): string[] =>
  agent.sessions.flatMap((s: PlainSession) =>
    s.prompts.map((p) => (typeof p.content === "string" ? p.content : "")),
  );

/** A plain agent with goals that takes prompts during a turn and runs background tasks. */
class Goals extends PlainAgent {
  override readonly capabilities = {
    ...PLAIN_CAPABILITIES,
    promptDuringTurn: true,
    backgroundTasks: true,
    goals: true,
  };
  /** The prompts sent so far when each clear arrived. */
  clearedAt: number[] = [];
  /** Runs inside each clear, before it answers. */
  onClear: ((session: PlainSession) => Promise<void>) | null = null;

  override async start(options: StartOptions, requests: RequestHandler) {
    const session = await super.start(options, requests);
    session.clearGoal = async () => {
      await this.onClear?.(session as PlainSession);
      this.clearedAt.push(sent(this).length);
    };
    return session;
  }
}

/** Two prompts sent, the second behind the first's turn, then the channel stopped. */
async function busyChannelStop(t: Parameters<typeof AskingWorld.make>[0]) {
  const agent = new Goals({ promptDuringTurn: true });
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  agent.next(say("a"), hold());
  agent.next(say("b"), hold());
  await session.submit("first");
  await until("the first runs", () => sent(agent).length === 1);
  await session.submit("second");
  await until("the second is sent", () => sent(agent).length === 2);
  return { agent, world, ref, session };
}

test("a channel !stop answers at once and clears the goal after the queued turn", async (t) => {
  const { agent, world, ref, session } = await busyChannelStop(t);
  assert.equal(await world.sessions.stopChannel(ref.channel), true);
  assert.deepEqual(agent.clearedAt, [], "no command into a turn that runs");
  agent.sessions[0]?.release();
  await until("the goal is cleared", () => agent.clearedAt.length === 1);
  await until("idle", () => !session.busy);
  assert.deepEqual(agent.clearedAt, [2], "cleared once, after both prompts");
});

test("a message written while the queued turn runs is sent after the clear", async (t) => {
  const { agent, world, ref, session } = await busyChannelStop(t);
  await world.sessions.stopChannel(ref.channel);
  await session.submit("third");
  for (let round = 0; round < 20; round += 1) await settledTurn();
  assert.equal(sent(agent).length, 2, "the third waits for the clear");
  agent.next(say("c"));
  agent.sessions[0]?.release();
  await until("the third is sent", () => sent(agent).length === 3);
  assert.deepEqual(agent.clearedAt, [2], "the clear came before the third prompt");
  await until("idle", () => !session.busy);
});

test("a message written while the stop still awaits its stops waits for the clear", async (t) => {
  const { agent, world, ref, session } = await busyChannelStop(t);
  const stopping = world.sessions.stopChannel(ref.channel);
  await session.submit("third");
  await stopping;
  for (let round = 0; round < 20; round += 1) await settledTurn();
  assert.equal(sent(agent).length, 2, "the debt was raised before the stop's first await");
  agent.next(say("c"));
  agent.sessions[0]?.release();
  await until("the third is sent", () => sent(agent).length === 3);
  assert.deepEqual(agent.clearedAt, [2]);
  await until("idle", () => !session.busy);
});

test("a channel !stop on an idle session clears the goal before the answer", async (t) => {
  const agent = new Goals({ promptDuringTurn: true });
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  agent.next(say("a"));
  await session.submit("first");
  await until("idle", () => sent(agent).length === 1 && !session.busy);
  await world.sessions.stopChannel(ref.channel);
  assert.deepEqual(agent.clearedAt, [1]);
});

test("a close settles the debt: no clear goes out and a message after it is sent", async (t) => {
  const { agent, world, ref, session } = await busyChannelStop(t);
  await world.sessions.stopChannel(ref.channel);
  await session.close("test");
  assert.deepEqual(agent.clearedAt, []);
  agent.next(say("c"));
  await world.session(ref).submit("third");
  await until("the message is sent", () => sent(agent).length === 3);
});

test("a lost process settles the debt: a message that waits reaches a new process", async (t) => {
  const { agent, world, ref, session } = await busyChannelStop(t);
  await world.sessions.stopChannel(ref.channel);
  await session.submit("third");
  for (let round = 0; round < 20; round += 1) await settledTurn();
  assert.equal(sent(agent).length, 2, "the third waits on the debt");
  agent.next(say("c"));
  agent.sessions[0]?.kill();
  await until("the third reaches a new process", () => agent.sessions.length === 2);
  await until("sent", () => sent(agent).length === 3);
  assert.deepEqual(agent.clearedAt, []);
});

/** A command taken while the queued turn runs must not pass the idle check before the clear. */
async function commandAfterQueued(t: Parameters<typeof AskingWorld.make>[0], shell: boolean) {
  const agent = new Goals({ promptDuringTurn: true, shell: {} });
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  agent.next(say("a"), hold());
  agent.next(say("b"), hold());
  await session.submit("first");
  await until("first", () => sent(agent).length === 1);
  await session.submit("second");
  await until("second", () => sent(agent).length === 2);
  const marker = join(world.folder, "ran");
  agent.onClear = async (process) => {
    process.emit({ type: "peer_message", text: "a note" });
    await until("the report turn runs", () => session.busy);
  };
  await world.sessions.stopChannel(ref.channel);
  if (shell) await session.submit("", `touch ${marker}`);
  else await session.submit(":echo hi");
  for (let round = 0; round < 20; round += 1) await settledTurn();
  agent.sessions[0]?.release(); // the queued turn ends: the command passes the old idle check
  await until("cleared", () => agent.clearedAt.length === 1);
  for (let round = 0; round < 20; round += 1) await settledTurn();
  assert.ok(session.busy, "the report turn still runs");
  if (shell) assert.equal(existsSync(marker), false, "no command while a turn runs");
  else assert.equal(sent(agent).length, 2, "no command while a turn runs");
  // The report turn ends: the command it held back runs.
  agent.sessions[0]?.emit({
    type: "turn_ended",
    sessionId: world.state.thread(ref.channel, ref.thread)?.sessionId ?? "",
    startedBy: "agent",
    finalText: "Noted.",
    ending: "done",
    steps: 1,
    tokens: {},
  });
  if (shell) await until("the command ran", () => existsSync(marker));
  else await until("the command is sent", () => sent(agent).length === 3);
}

test(
  "a !!command taken during the queued turn waits for the turn the clear met",
  POSIX_SHELL,
  (t) => commandAfterQueued(t, true),
);

test("an agent command taken during the queued turn waits for the turn the clear met", (t) =>
  commandAfterQueued(t, false));

test("a channel !stop that closes the process for background tasks does not hang the next message", async (t) => {
  const agent = new Goals({ promptDuringTurn: true });
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  agent.next(say("a"), hold());
  await session.submit("first");
  await until("the first runs", () => sent(agent).length === 1);
  const [process] = agent.sessions;
  assert.ok(process);
  process.emit({
    type: "task_started",
    taskId: "task-1",
    kind: "command",
    taskType: null,
    description: "watch",
    callId: null,
    agentType: null,
    background: true,
    parentTaskId: null,
  });
  process.release();
  await until("idle", () => !session.busy);
  assert.equal(await world.sessions.stopChannel(ref.channel), true);
  assert.ok(process.closed, "the stop closed the process, which a clear is not started again for");
  agent.next(say("b"));
  await session.submit("second");
  await until("the message is sent", () => sent(agent).length === 2);
  await until("idle", () => !session.busy);
});
