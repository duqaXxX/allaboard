// A prompt sent while a turn runs goes to the agent at once (#185), over an agent that declares
// `promptDuringTurn` and takes prompts in or announces them.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { RequestHandler, StartOptions } from "../../../src/agent/seam.ts";
import { INJECTED_TURN_WAIT } from "../../../src/core/sessions/constants.ts";
import { SessionClosed } from "../../../src/core/sessions/errors.ts";
import * as texts from "../../../src/core/texts.ts";
import { hold, PlainAgent, type PlainSession, say } from "../../support/plain-agent.ts";
import { settledTurn } from "../../support/settle.ts";
import { AskingWorld } from "../flows/asking-world.ts";

async function until(what: string, test: () => boolean): Promise<void> {
  for (let round = 0; round < 200 && !test(); round += 1) await settledTurn();
  assert.ok(test(), what);
}

const sent = (agent: PlainAgent): string[] =>
  agent.sessions.flatMap((s: PlainSession) =>
    s.prompts.map((p) => (typeof p.content === "string" ? p.content : "")),
  );

const TAKEN = texts.fill(texts.named(texts.TAKEN_INTO_REPLY_ONE, { agent: "Plain" } as never), {
  count: 1,
});

function root(world: AskingWorld, ref: { channel: string; thread: string }) {
  const stored = world.state.thread(ref.channel, ref.thread);
  return stored?.status ?? stored?.ended ?? null;
}

test("a prompt sent during a turn reaches the agent before the turn ends", async (t) => {
  const agent = new PlainAgent({ promptDuringTurn: true });
  const world = await AskingWorld.make(t, { agent });
  const { session } = world.thread();
  agent.next(say("a"), hold(), say("b"));
  await session.submit("first");
  await until("the first runs", () => sent(agent).length === 1);
  await session.submit("second");
  await until("the second is sent at once", () => sent(agent).length === 2);
  agent.sessions[0]?.release();
  await until("idle", () => !session.busy);
});

test("a prompt taken into the turn is released with the note and opens no reply", async (t) => {
  const agent = new PlainAgent({ promptDuringTurn: true });
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  agent.next(say("a"), hold(), say("b"));
  agent.next(say("never played"));
  await session.submit("first");
  await until("the first runs", () => sent(agent).length === 1);
  await session.submit("second");
  await until("sent", () => sent(agent).length === 2);
  agent.sessions[0]?.release();
  await until("idle", () => !session.busy);
  await settledTurn();
  assert.equal(agent.turns.length, 1, "the second prompt played no turn");
  assert.ok(
    world.shown(ref).some((line) => line.includes(TAKEN.slice(0, 20))),
    "the taken note",
  );
});

test("a prompt the turn does not reach gets its own turn", async (t) => {
  const agent = new PlainAgent({ promptDuringTurn: true });
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  agent.next(say("a"), hold());
  agent.next(say("answer two"));
  await session.submit("first");
  await until("the first runs", () => sent(agent).length === 1);
  await session.submit("second");
  await until("sent", () => sent(agent).length === 2);
  agent.sessions[0]?.release();
  await until("idle", () => !session.busy);
  assert.equal(agent.turns.length, 0, "the second prompt played its own turn");
  assert.ok(world.shown(ref).some((line) => line.includes("answer two")));
});

test("a !!command waits for the prompts sent before it", async (t) => {
  const agent = new PlainAgent({ promptDuringTurn: true, shell: {} });
  const world = await AskingWorld.make(t, { agent });
  const { session } = world.thread();
  const marker = join(world.folder, "ran");
  agent.next(say("a"), hold());
  await session.submit("first");
  await until("the first runs", () => sent(agent).length === 1);
  await session.submit("", `touch ${marker}`);
  await settledTurn();
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(marker), false, "the command waits for the running turn");
  agent.sessions[0]?.release();
  await until("the command ran", () => existsSync(marker));
});

test("!stop between a send and its turn: the turn that follows ends the root on done", async (t) => {
  const agent = new PlainAgent({ promptDuringTurn: true });
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  agent.next(say("a"));
  agent.next(say("b"));
  await session.submit("first");
  await until("the first ran", () => sent(agent).length === 1);
  await until("idle", () => !session.busy);
  await settledTurn();
  let open!: () => void;
  const [plain] = agent.sessions;
  assert.ok(plain);
  plain.playGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  await session.submit("second");
  await until("sent", () => sent(agent).length === 2);
  // The prompt is sent and its turn has not started: the stop interrupts, and the turn that
  // starts afterwards is cut by it.
  assert.equal(await session.stop(), true);
  open();
  await until("idle", () => !session.busy);
  await settledTurn();
  assert.equal(root(world, ref), "done");
  // The agent never took the prompt in: the owner is told it was not sent, under no `Stopped.`.
  const lines = world.shown(ref);
  assert.ok(lines.some((line) => line.includes("was not sent because you stopped it")));
  assert.ok(!lines.some((line) => line.includes(texts.STOPPED)));
});

test("!stop whose interrupt missed a turn that began meanwhile leaves the root working", async (t) => {
  const agent = new PlainAgent({ promptDuringTurn: true });
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  agent.next(say("a"));
  agent.next(say("b"), hold());
  await session.submit("first");
  await until("the first ran", () => sent(agent).length === 1);
  await until("idle", () => !session.busy);
  await settledTurn();
  let open!: () => void;
  const [plain] = agent.sessions;
  assert.ok(plain);
  plain.playGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  await session.submit("second");
  await until("sent", () => sent(agent).length === 2);
  // The turn begins while the stop awaits its interrupt, and the interrupt does not cut it.
  plain.interrupt = async () => {
    open();
    await until("the turn runs", () => session.busy && plain.prompts.length === 2);
    await settledTurn();
  };
  assert.equal(await session.stop(), true);
  await settledTurn();
  assert.equal(root(world, ref), "working", "the stop's ✅ does not cover the turn that runs");
  plain.release();
  await until("idle", () => !session.busy);
  await settledTurn();
  assert.equal(root(world, ref), "done");
});

/** A plain agent that takes prompts during a turn and drops a goal, counting the drops. */
class GoalsDuringTurn extends PlainAgent {
  override readonly capabilities = {
    ...new PlainAgent({ promptDuringTurn: true }).capabilities,
    goals: true,
  };
  cleared = 0;

  override async start(options: StartOptions, requests: RequestHandler) {
    const session = await super.start(options, requests);
    session.clearGoal = async () => {
      this.cleared += 1;
    };
    return session;
  }
}

test("a channel !stop between a send and its turn still drops the goal", async (t) => {
  const agent = new GoalsDuringTurn({ promptDuringTurn: true });
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  agent.next(say("a"));
  agent.next(say("b"));
  await session.submit("first");
  await until("the first ran", () => sent(agent).length === 1);
  await until("idle", () => !session.busy);
  await settledTurn();
  let open!: () => void;
  const [plain] = agent.sessions;
  assert.ok(plain);
  plain.playGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  await session.submit("second");
  await until("sent", () => sent(agent).length === 2);
  const stopping = world.sessions.stopChannel(ref.channel);
  open();
  assert.equal(await stopping, true);
  await until("idle", () => !session.busy);
  assert.equal(agent.cleared, 1, "the goal is dropped once the turn the stop cut is over");
});

test("a command of the agent waits for the running turn and is not sent into it", async (t) => {
  const agent = new PlainAgent({ promptDuringTurn: true });
  const world = await AskingWorld.make(t, { agent });
  const { session } = world.thread();
  agent.next(say("a"), hold());
  await session.submit("first");
  await until("the first runs", () => sent(agent).length === 1);
  await session.submit(":echo hello");
  for (let round = 0; round < 20; round += 1) await settledTurn();
  assert.deepEqual(sent(agent), ["first"], "the command waits for the turn");
  agent.sessions[0]?.release();
  await until("the command is sent", () => sent(agent).length === 2);
  await until("idle", () => !session.busy);
});

test("a stop while a command waits for the turn drops it", async (t) => {
  const agent = new PlainAgent({ promptDuringTurn: true });
  const world = await AskingWorld.make(t, { agent });
  const { session } = world.thread();
  agent.next(say("a"), hold());
  await session.submit("first");
  await until("the first runs", () => sent(agent).length === 1);
  await session.submit(":echo hello");
  await settledTurn();
  assert.equal(await session.stop(), true);
  await until("idle", () => !session.busy);
  await settledTurn();
  assert.deepEqual(sent(agent), ["first"], "the command was never sent");
});

test("two prompts announced before one turn: the second is taken into the first's turn", async (t) => {
  const agent = new PlainAgent({ promptDuringTurn: true });
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  agent.next(say("a"));
  agent.next(say("b"));
  agent.next(say("never played"));
  await session.submit("first");
  await until("the first ran", () => sent(agent).length === 1);
  await until("idle", () => !session.busy);
  await settledTurn();
  let open!: () => void;
  const [plain] = agent.sessions;
  assert.ok(plain);
  plain.playGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  await session.submit("second");
  await until("second sent", () => sent(agent).length === 2);
  await session.submit("third");
  await until("third sent", () => sent(agent).length === 3);
  open();
  await until("idle", () => !session.busy);
  await settledTurn();
  assert.equal(agent.turns.length, 1, "one turn answered both");
  assert.ok(world.shown(ref).some((line) => line.includes("b")));
  assert.ok(
    world.shown(ref).some((line) => line.includes(TAKEN.slice(0, 20))),
    "the third prompt is said to be taken in",
  );
  assert.equal(root(world, ref), "done");
});

test("a command waiting behind a turn whose process dies goes to the new process", async (t) => {
  const agent = new PlainAgent({ promptDuringTurn: true });
  const world = await AskingWorld.make(t, { agent });
  const { session } = world.thread();
  agent.next(say("a"), hold());
  await session.submit("first");
  await until("the first runs", () => sent(agent).length === 1);
  await session.submit(":echo hello");
  for (let round = 0; round < 20; round += 1) await settledTurn();
  agent.sessions[0]?.kill();
  await until("the command reaches a new process", () => sent(agent).length === 2);
  assert.equal(agent.sessions.length, 2);
  assert.deepEqual(sent(agent), ["first", ":echo hello"]);
});

test("a send the agent refuses as closed leaves nothing sent: a !!command still runs", async (t) => {
  const agent = new PlainAgent({ promptDuringTurn: true, shell: {} });
  const world = await AskingWorld.make(t, { agent });
  const { session } = world.thread();
  const marker = join(world.folder, "ran-after-refusal");
  agent.next(say("a"));
  await session.submit("first");
  await until("the first ran", () => sent(agent).length === 1);
  await until("idle", () => !session.busy);
  const [plain] = agent.sessions;
  assert.ok(plain);
  plain.send = async () => {
    throw new SessionClosed();
  };
  await session.submit("second");
  await until("the refused prompt left", () => !session.busy);
  await session.submit("", `touch ${marker}`);
  const { existsSync } = await import("node:fs");
  await until("the command ran", () => existsSync(marker));
});

test("nothing is sent behind a command until its turn has ended", async (t) => {
  const agent = new PlainAgent({ promptDuringTurn: true });
  const world = await AskingWorld.make(t, { agent });
  const { session } = world.thread();
  agent.next(say("a"));
  agent.next(say("b"));
  await session.submit("first");
  await until("the first ran", () => sent(agent).length === 1);
  await until("idle", () => !session.busy);
  await settledTurn();
  let open!: () => void;
  const [plain] = agent.sessions;
  assert.ok(plain);
  plain.playGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  await session.submit(":echo hello");
  await until("the command is sent", () => sent(agent).length === 2);
  await session.submit("after");
  for (let round = 0; round < 20; round += 1) await settledTurn();
  assert.deepEqual(
    sent(agent),
    ["first", ":echo hello"],
    "the prompt waits for the command's turn",
  );
  open();
  await until("the prompt is sent", () => sent(agent).length === 3);
  await until("idle", () => !session.busy);
});

test("a channel !stop during a turn with a prompt sent sends no goal command into its turn", async (t) => {
  const agent = new GoalsDuringTurn({ promptDuringTurn: true });
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  agent.next(say("a"), hold());
  agent.next(say("b"), hold());
  await session.submit("first");
  await until("the first runs", () => sent(agent).length === 1);
  await session.submit("second");
  await until("the second is sent", () => sent(agent).length === 2);
  assert.equal(await world.sessions.stopChannel(ref.channel), true);
  // The prompt runs after the stop (the terminal's Esc does the same). A command sent into its
  // turn would hide that turn's records (round 4 review): the goal is kept instead.
  assert.equal(agent.cleared, 0, "no goal command reaches a session at work");
  agent.sessions[0]?.release();
  await until("idle", () => !session.busy);
});

/** Two prompts sent in the gap of a session that is idle, a `!stop` in it, the gate then opened. */
async function twoInTheGap(
  t: Parameters<typeof AskingWorld.make>[0],
  leavesRest: boolean,
): Promise<{
  world: AskingWorld;
  session: ReturnType<AskingWorld["thread"]>["session"];
  ref: { channel: string; thread: string };
  open: () => void;
  agent: PlainAgent;
}> {
  const agent = new PlainAgent({ promptDuringTurn: true });
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  agent.next(say("a"));
  agent.next(say("b"));
  agent.next(say("c"));
  await session.submit("first");
  await until("the first ran", () => sent(agent).length === 1);
  await until("idle", () => !session.busy);
  await settledTurn();
  let open!: () => void;
  const [plain] = agent.sessions;
  assert.ok(plain);
  plain.gapCutLeavesRest = leavesRest;
  plain.playGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  await session.submit("second");
  await until("second sent", () => sent(agent).length === 2);
  await session.submit("third");
  await until("third sent", () => sent(agent).length === 3);
  assert.equal(await session.stop(), true);
  return { world, session, ref, open, agent };
}

test("!stop in the gap of two prompts: the cut leaves the second, which runs as its own turn", async (t) => {
  const { world, session, ref, open } = await twoInTheGap(t, true);
  open();
  await until("idle", () => !session.busy);
  await settledTurn();
  assert.ok(
    world.shown(ref).some((line) => line.includes("c")),
    "the third prompt answered",
  );
  assert.equal(root(world, ref), "done");
});

test("!stop in the gap of two prompts: a cut that took both leaves nothing stuck in sent", async (t) => {
  const { world, session, ref, open } = await twoInTheGap(t, false);
  open();
  await settledTurn();
  await world.clock.advance(INJECTED_TURN_WAIT);
  await until("idle", () => !session.busy);
  await settledTurn();
  assert.ok(
    world.shown(ref).some((line) => line.includes("was not sent because you stopped it")),
    "the prompt the cut took is said not to be sent",
  );
  assert.equal(root(world, ref), "done");
});
