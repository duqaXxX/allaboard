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

// The command touches a file, which Windows has no `touch` for.
const POSIX_SHELL = { skip: process.platform === "win32" && "the command needs a POSIX shell" };

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

test("a !!command waits for the prompts sent before it", POSIX_SHELL, async (t) => {
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

test(
  "a send the agent refuses as closed leaves nothing sent: a !!command still runs",
  POSIX_SHELL,
  async (t) => {
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
  },
);

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
  await until("the goal is dropped after the queued turn", () => agent.cleared === 1);
});

/** Every status the session sets, with whether the owner's own act made it (no push then). */
function statuses(session: object): [string | null, boolean][] {
  const seen: [string | null, boolean][] = [];
  const spied = session as {
    setStatus(state: string | null, change?: { byOwner?: boolean }): Promise<unknown>;
  };
  const original = spied.setStatus.bind(session);
  spied.setStatus = (state, change = {}) => {
    seen.push([state, change.byOwner === true]);
    return original(state, change);
  };
  return seen;
}

/** Two prompts sent in the gap of a session that is idle, a `!stop` in it, the gate then opened. */
async function twoInTheGap(
  t: Parameters<typeof AskingWorld.make>[0],
  leavesRest: boolean,
  declaredState = false,
): Promise<{
  world: AskingWorld;
  session: ReturnType<AskingWorld["thread"]>["session"];
  ref: { channel: string; thread: string };
  open: () => void;
  agent: PlainAgent;
}> {
  const agent = new PlainAgent({
    promptDuringTurn: true,
    ...(declaredState && { declaredState: true as const }),
  });
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  agent.next(say("a"));
  agent.next(say("b"));
  agent.next(say("third answer"));
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
    world.shown(ref).some((line) => line.split("\n")[0] === "third answer"),
    "the third prompt answered",
  );
  assert.equal(root(world, ref), "done");
});

test("!stop in the gap of two prompts: a cut that took both leaves nothing stuck in sent", async (t) => {
  const { world, session, ref, open } = await twoInTheGap(t, false);
  const seen = statuses(session);
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
  assert.deepEqual(seen.at(-1), ["done", true], "the owner's stop ended the work: no push");
});

test("!stop in the gap of two prompts: a prompt the cut took is dropped even when a later turn runs at the wait's end", async (t) => {
  const agent = new PlainAgent({ promptDuringTurn: true });
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  agent.next(say("a"));
  agent.next(say("b"));
  agent.next(say("fourth answer"), hold());
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
  assert.equal(await session.stop(), true);
  const seen = statuses(session);
  open();
  await settledTurn();
  // A new prompt's turn is still running when the wait for the cut prompts ends.
  await session.submit("fourth");
  await until("fourth sent", () => sent(agent).length === 4);
  await settledTurn();
  await world.clock.advance(INJECTED_TURN_WAIT);
  await settledTurn();
  // The cut turn's own prompt is told at once; the one it took with it only when the wait ends.
  const notSent = (line: string) =>
    line.includes("was not sent because you stopped it") && line.includes('"third"');
  assert.ok(!world.shown(ref).some(notSent), "nothing is dropped while the later turn runs");
  plain.release();
  await settledTurn();
  await world.clock.advance(INJECTED_TURN_WAIT);
  await until("idle", () => !session.busy);
  await settledTurn();
  assert.ok(world.shown(ref).some(notSent), "the prompt the cut took is said not to be sent");
  assert.ok(
    world.shown(ref).some((line) => line.split("\n")[0] === "fourth answer"),
    "the fourth prompt answered",
  );
  assert.equal(root(world, ref), "done");
  // The fourth prompt's work ended while the cut prompt held the status back: the owner is told.
  assert.deepEqual(seen.at(-1), ["done", false]);
});

test("!stop in the gap of two prompts: a turn the agent starts behind the cut prompt tells the owner of its end", async (t) => {
  const { world, session, ref, open, agent } = await twoInTheGap(t, false);
  const seen = statuses(session);
  open();
  await settledTurn();
  const plain = agent.sessions[0];
  assert.ok(plain);
  plain.emit({ type: "peer_message", text: "a note" });
  plain.emit({
    type: "turn_ended",
    sessionId: world.state.thread(ref.channel, ref.thread)?.sessionId ?? "",
    startedBy: "agent",
    finalText: "Noted.",
    ending: "done",
    steps: 1,
    tokens: {},
  });
  await settledTurn();
  await world.clock.advance(INJECTED_TURN_WAIT);
  await until("idle", () => !session.busy);
  await settledTurn();
  assert.equal(root(world, ref), "done");
  // The agent's turn ended while the cut prompt held the status back: the owner is told.
  assert.deepEqual(seen.at(-1), ["done", false]);
});

test("!stop in the gap of two prompts: an empty turn of the agent behind the cut prompt does not tell the owner", async (t) => {
  const { world, session, ref, open, agent } = await twoInTheGap(t, false);
  const seen = statuses(session);
  open();
  await settledTurn();
  const plain = agent.sessions[0];
  assert.ok(plain);
  plain.emit({
    type: "turn_ended",
    sessionId: world.state.thread(ref.channel, ref.thread)?.sessionId ?? "",
    startedBy: "agent",
    finalText: "",
    ending: "done",
    steps: 0,
    tokens: {},
  });
  await settledTurn();
  await world.clock.advance(INJECTED_TURN_WAIT);
  await until("idle", () => !session.busy);
  await settledTurn();
  assert.equal(root(world, ref), "done");
  // No work started after the stop: the done is the owner's own act, and pushes nothing.
  assert.deepEqual(seen.at(-1), ["done", true]);
});

test("!stop in the gap of two prompts: a hold cancelled behind the cut prompt does not tell the owner", async (t) => {
  const { world, session, ref, open } = await twoInTheGap(t, false);
  const seen = statuses(session);
  open();
  await settledTurn();
  // A `!!command`'s confirmation, or a terminal's `Send here`, that the owner cancels.
  session.holdStart();
  await session.holdEnd({ continued: false });
  await settledTurn();
  await world.clock.advance(INJECTED_TURN_WAIT);
  await until("idle", () => !session.busy);
  await settledTurn();
  assert.equal(root(world, ref), "done");
  // A status written is no work: his stop and his cancel are the last acts.
  assert.deepEqual(seen.at(-1), ["done", true]);
});

test("!stop in the gap of two prompts: a hold continued behind the cut prompt tells the owner once its work ends", async (t) => {
  const { world, session, ref, open } = await twoInTheGap(t, false);
  const seen = statuses(session);
  open();
  await settledTurn();
  session.holdStart();
  await session.holdEnd({ continued: true });
  await session.submit("fourth");
  await settledTurn();
  await world.clock.advance(INJECTED_TURN_WAIT);
  await until("idle", () => !session.busy);
  await settledTurn();
  assert.equal(root(world, ref), "done");
  assert.deepEqual(seen.at(-1), ["done", false]);
});

// The agent says its state (#252): the cut's prompts are dropped at its `idle`, with no clock.

const notSentOf = (text: string) => (line: string) =>
  /messages? w(as|ere) not sent because you stopped it/.test(line) && line.includes(`"${text}"`);

test("!stop in the gap, an agent that says idle: the prompt the cut took is dropped at the idle, with no clock", async (t) => {
  const { world, session, ref, open } = await twoInTheGap(t, false, true);
  const seen = statuses(session);
  open();
  await until("idle", () => !session.busy);
  await settledTurn();
  assert.ok(world.shown(ref).some(notSentOf("third")), "the prompt the cut took is told");
  assert.equal(root(world, ref), "done");
  assert.deepEqual(seen.at(-1), ["done", true], "the owner's stop ended the work: no push");
});

test("!stop in the gap, an agent that says idle: a prompt the cut left runs and nothing is dropped", async (t) => {
  const { world, session, ref, open } = await twoInTheGap(t, true, true);
  open();
  await until("idle", () => !session.busy);
  await settledTurn();
  assert.ok(!world.shown(ref).some(notSentOf("third")), "nothing dropped");
  assert.ok(world.shown(ref).some((line) => line.split("\n")[0] === "third answer"));
  assert.equal(root(world, ref), "done");
});

test("!stop in the gap, an agent that says idle: a prompt written after the stop is never dropped by an early idle", async (t) => {
  const agent = new PlainAgent({ promptDuringTurn: true, declaredState: true });
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  agent.next(say("a"));
  agent.next(say("b"));
  agent.next(say("after the stop"));
  await session.submit("first");
  await until("the first ran", () => sent(agent).length === 1);
  await until("idle", () => !session.busy);
  await settledTurn();
  const [plain] = agent.sessions;
  assert.ok(plain);
  plain.gapCutLeavesRest = true;
  let open!: () => void;
  plain.playGate = new Promise<void>((resolve) => {
    open = resolve;
  });
  await session.submit("second");
  await until("second sent", () => sent(agent).length === 2);
  assert.equal(await session.stop(), true);
  await session.submit("third");
  await until("third sent", () => sent(agent).length === 3);
  let openThird!: () => void;
  open();
  // The third prompt's play waits for this gate: the cut ends first and the agent has not read it.
  plain.playGate = new Promise<void>((resolve) => {
    openThird = resolve;
  });
  await settledTurn();
  plain.emit({ type: "state_changed", state: "idle" });
  await settledTurn();
  const told = world.shown(ref).some(notSentOf("third"));
  openThird(); // before asserting: a failure must fail, not leave the gate shut
  assert.ok(!told, "the third is not told as not sent");
  await until("idle", () => !session.busy);
  await settledTurn();
  assert.ok(world.shown(ref).some((line) => line.split("\n")[0] === "after the stop"));
  assert.equal(root(world, ref), "done");
});

test("!stop in the gap, an agent that says idle: work that ran before the idle makes the end push", async (t) => {
  const { world, session, ref, open, agent } = await twoInTheGap(t, false, true);
  const plain = agent.sessions[0];
  assert.ok(plain);
  plain.autoIdle = false;
  const seen = statuses(session);
  open();
  await settledTurn();
  plain.emit({ type: "peer_message", text: "a note" });
  plain.emit({
    type: "turn_ended",
    sessionId: world.state.thread(ref.channel, ref.thread)?.sessionId ?? "",
    startedBy: "agent",
    finalText: "Noted.",
    ending: "done",
    steps: 1,
    tokens: {},
  });
  await settledTurn();
  assert.ok(!world.shown(ref).some(notSentOf("third")), "nothing is dropped before the idle");
  plain.emit({ type: "state_changed", state: "idle" });
  await until("idle", () => !session.busy);
  await settledTurn();
  assert.ok(world.shown(ref).some(notSentOf("third")));
  assert.equal(root(world, ref), "done");
  assert.deepEqual(seen.at(-1), ["done", false]);
});

test("!stop in the gap, an agent that says idle: an idle already said before the cut still ends the wait", async (t) => {
  const { world, session, ref, open, agent } = await twoInTheGap(t, false, true);
  const plain = agent.sessions[0];
  assert.ok(plain);
  plain.autoIdle = false;
  plain.emit({ type: "state_changed", state: "idle" });
  await settledTurn();
  open();
  await settledTurn();
  assert.ok(!world.shown(ref).some(notSentOf("third")));
  plain.emit({ type: "state_changed", state: "idle" });
  await until("idle", () => !session.busy);
  await settledTurn();
  assert.ok(world.shown(ref).some(notSentOf("third")), "dropped at the repeated idle");
  assert.equal(root(world, ref), "done");
});

/** The first gap's cut is over (no idle said yet); a second stop in a new gap with two prompts. */
async function secondGap(t: Parameters<typeof AskingWorld.make>[0]) {
  const made = await twoInTheGap(t, false, true);
  const plain = made.agent.sessions[0];
  assert.ok(plain);
  plain.autoIdle = false;
  made.open();
  await settledTurn();
  let openSecond!: () => void;
  plain.playGate = new Promise<void>((resolve) => {
    openSecond = resolve;
  });
  await made.session.submit("fifth");
  await until("fifth sent", () => sent(made.agent).length === 4);
  await made.session.submit("sixth");
  await until("sixth sent", () => sent(made.agent).length === 5);
  assert.equal(await made.session.stop(), true);
  return { ...made, plain, openSecond };
}

test("!stop twice in the gap before the idle: the second cut's prompt joins the first wait, once", async (t) => {
  const { world, session, ref, plain, openSecond } = await secondGap(t);
  const seen = statuses(session);
  openSecond();
  await settledTurn();
  plain.emit({ type: "state_changed", state: "idle" });
  await until("idle", () => !session.busy);
  await settledTurn();
  assert.equal(world.shown(ref).filter(notSentOf("third")).length, 1, "third told once");
  assert.equal(world.shown(ref).filter(notSentOf("sixth")).length, 1, "sixth told once");
  assert.equal(root(world, ref), "done");
  // The fifth prompt's turn started after the first cut: work, so the end tells the owner.
  assert.deepEqual(seen.at(-1), ["done", false]);
});

test("!stop twice in the gap: an idle between the second stop and its cut leaves the second record for the cut", async (t) => {
  const { world, session, ref, plain, openSecond } = await secondGap(t);
  plain.emit({ type: "state_changed", state: "idle" });
  await settledTurn();
  openSecond();
  await settledTurn();
  plain.emit({ type: "state_changed", state: "idle" });
  await until("idle", () => !session.busy);
  await settledTurn();
  assert.equal(world.shown(ref).filter(notSentOf("sixth")).length, 1, "sixth told once");
  assert.equal(root(world, ref), "done");
});
