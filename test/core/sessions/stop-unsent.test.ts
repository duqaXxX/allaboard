// `session.stop()` and the turns of its session not yet sent to the agent: queued behind the
// running turn, or taken by the worker while the process starts (#200).
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { RequestHandler, StartOptions } from "../../../src/agent/seam.ts";
import type { Mutex } from "../../../src/core/sessions/tasks.ts";
import * as texts from "../../../src/core/texts.ts";
import { AsyncEvent } from "../../support/fake-clock.ts";
import { hold, PlainAgent, type PlainSession, say } from "../../support/plain-agent.ts";
import { settledTurn } from "../../support/settle.ts";
import { AskingWorld } from "../flows/asking-world.ts";

/** A plain agent whose starts wait for the test while `gate` is set to an event. */
class GatedAgent extends PlainAgent {
  gate: AsyncEvent | null = null;

  override async start(options: StartOptions, requests: RequestHandler) {
    await this.gate?.wait();
    return super.start(options, requests);
  }
}

const NOT_SENT_ONE = texts.fill(texts.NOT_SENT_ONE, {
  count: 1,
  because: texts.BECAUSE_OWNER_STOPPED,
});

async function until(what: string, test: () => boolean): Promise<void> {
  for (let round = 0; round < 200 && !test(); round += 1) await settledTurn();
  assert.ok(test(), what);
}

/** `until` with bare turns of the loop: `settledTurn` waits out a running child process. */
async function untilSoon(what: string, test: () => boolean): Promise<void> {
  for (let round = 0; round < 500 && !test(); round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(test(), what);
}

/** The root's last status as a word: `ended` once done or error was asked. */
function root(world: AskingWorld, ref: { channel: string; thread: string }) {
  const stored = world.state.thread(ref.channel, ref.thread);
  return stored?.status ?? stored?.ended ?? null;
}

function sentTo(agent: PlainAgent): string[] {
  return agent.sessions.flatMap((session: PlainSession) =>
    session.prompts.map((prompt) => (typeof prompt.content === "string" ? prompt.content : "")),
  );
}

test("a turn queued behind a running one is dropped by a stop, with the note", async (t) => {
  const agent = new GatedAgent();
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  agent.next(hold());
  await session.submit("first");
  await until("the first turn runs", () => session.busy);
  await session.submit("second");

  assert.equal(await session.stop(), true);
  // Busy: the note ends the interrupted reply.
  await until("the note", () => world.shown(ref).some((line) => line.includes(NOT_SENT_ONE)));
  assert.deepEqual(sentTo(agent), ["first"]);
});

test("a turn taken while the process starts is dropped: null, the note, the root done", async (t) => {
  const agent = new GatedAgent();
  agent.gate = new AsyncEvent();
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  await session.submit("first");
  await settledTurn();

  assert.equal(await session.stop(), null);
  agent.gate.set();
  await until("the note", () => world.shown(ref).some((line) => line.startsWith(NOT_SENT_ONE)));
  await until("the root is done", () => root(world, ref) === "done");
  assert.deepEqual(sentTo(agent), []);
  assert.equal(session.idle, true, "the session can close for idle");
});

test("a !!command taken while the process starts never runs", async (t) => {
  const agent = new GatedAgent({ shell: {} });
  agent.gate = new AsyncEvent();
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  const marker = join(world.folder, "ran");
  await session.submit("", `touch ${marker}`);
  await settledTurn();

  assert.equal(await session.stop(), null);
  agent.gate.set();
  await until("the note", () => world.shown(ref).some((line) => line.startsWith(NOT_SENT_ONE)));
  await settledTurn();
  assert.equal(existsSync(marker), false);
  assert.deepEqual(sentTo(agent), []);
});

// The command runs in a real Bash (`src/core/shell.ts`), as in `test/core/shell.test.ts`.
const POSIX_ONLY = { skip: process.platform === "win32" && "a real Bash", timeout: 20_000 };

test(
  "a !!command that ran and waits to be sent is shown with the stop, never sent",
  POSIX_ONLY,
  async (t) => {
    const agent = new GatedAgent({ shell: {} });
    const world = await AskingWorld.make(t, { agent });
    const { ref, session } = world.thread();
    const release = join(world.folder, "release");
    await session.submit("", `while [ ! -f ${release} ]; do sleep 0.02; done; echo $((6*7))`);
    await untilSoon(
      "the command runs",
      () => (session as unknown as { shellStop: unknown }).shellStop !== null,
    );
    // The worker waits for the connect lock once the command is over.
    const lock = (session as unknown as { connectLock: Mutex }).connectLock;
    const free = await lock.acquire();
    writeFileSync(release, "");
    await untilSoon(
      "the command ended",
      () => (session as unknown as { shellStop: unknown }).shellStop === null,
    );

    assert.equal(await session.stop(), null);
    free();
    await until("the stop line", () =>
      world.shown(ref).some((line) => line.includes(texts.SHELL_NOT_TOLD_STOPPED)),
    );
    const shown = world.shown(ref).join("\n");
    assert.match(shown, /^42$/m);
    assert.doesNotMatch(shown, /send it again/);
    assert.deepEqual(sentTo(agent), []);
  },
);

test("a turn taken and another queued behind it: after the stop the root ends done", async (t) => {
  const agent = new GatedAgent();
  agent.gate = new AsyncEvent();
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  await session.submit("first");
  await settledTurn();
  await session.submit("second");

  assert.equal(await session.stop(), null);
  agent.gate.set();
  await until("the root is done", () => root(world, ref) === "done");
  assert.deepEqual(sentTo(agent), []);
});

test("a turn submitted after the stop runs normally", async (t) => {
  const agent = new GatedAgent();
  agent.gate = new AsyncEvent();
  const world = await AskingWorld.make(t, { agent });
  const { session } = world.thread();
  await session.submit("first");
  await settledTurn();
  await session.stop();
  await session.submit("after");
  agent.gate.set();
  await until("the later turn is sent", () => sentTo(agent).includes("after"));
  assert.deepEqual(sentTo(agent), ["after"]);
});

test("a connect failure of a stopped turn gives the note, not an error", async (t) => {
  const agent = new GatedAgent();
  agent.gate = new AsyncEvent();
  agent.failNextStart(new Error("no process"));
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  await session.submit("first");
  await settledTurn();
  await session.stop();
  agent.gate.set();
  await until("the note", () => world.shown(ref).some((line) => line.startsWith(NOT_SENT_ONE)));
  assert.ok(!world.shown(ref).some((line) => line.includes("no process")));
  assert.notEqual(root(world, ref), "error");
});

test("a stop while the ending turn's reply closes still posts the note", async (t) => {
  const agent = new GatedAgent();
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  // The close of the first reply is held: its end notes were read, and `busy` is still true.
  const inner = session as unknown as {
    closeReply: (...args: unknown[]) => Promise<unknown>;
    endNotes: string[];
  };
  const closing = new AsyncEvent();
  const entered = new AsyncEvent();
  const original = inner.closeReply.bind(session);
  let first = true;
  t.mock.method(inner, "closeReply", async (...args: unknown[]) => {
    if (first) {
      first = false;
      entered.set();
      await closing.wait();
    }
    return original(...args);
  });
  await session.submit("first");
  await entered.wait();
  await session.submit("second");

  t.after(() => closing.set());
  assert.equal(await session.stop(), true);
  closing.set();
  await until("the note", () => world.shown(ref).some((line) => line.includes(NOT_SENT_ONE)));
  assert.deepEqual(inner.endNotes, []);
  assert.deepEqual(sentTo(agent), ["first"]);
});

test("a taken turn and queued ones are named in one note, in the order sent", async (t) => {
  const agent = new GatedAgent();
  agent.gate = new AsyncEvent();
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  await session.submit("one");
  await settledTurn();
  await session.submit("two");
  await session.submit("three");

  await session.stop();
  agent.gate.set();
  const note = texts.fill(texts.NOT_SENT_MANY, {
    count: 3,
    because: texts.BECAUSE_OWNER_STOPPED,
  });
  await until("the note", () => world.shown(ref).some((line) => line.startsWith(note)));
  const shown = world.shown(ref).filter((line) => line.startsWith(note));
  assert.equal(shown.length, 1);
  const lines = (shown[0] as string).split("\n");
  assert.deepEqual(lines.slice(1), ['- "one"', '- "two"', '- "three"']);
});

test("a note that cannot be posted is logged and never fails the stop or the turn", async (t) => {
  const agent = new GatedAgent();
  agent.gate = new AsyncEvent();
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  await session.submit("one");
  await settledTurn();
  await session.submit("two");
  const inner = session as unknown as { post: (text: string) => Promise<void> };
  t.mock.method(inner, "post", async () => {
    throw new Error("refused");
  });

  assert.equal(await session.stop(), null, "a failed note does not fail the stop");
  agent.gate.set();
  await until("the root is done", () => root(world, ref) === "done");
  assert.ok(!world.shown(ref).some((line) => line.includes("reported an error")));
  assert.notEqual(root(world, ref), "error");
});

test("a stop with nothing taken posts its note itself, and a failed post does not fail it", async (t) => {
  const agent = new GatedAgent();
  const world = await AskingWorld.make(t, { agent });
  const { session } = world.thread();
  agent.next(hold());
  await session.submit("first");
  await until("the first turn runs", () => session.busy);
  await session.submit("second");
  const inner = session as unknown as { drop: () => Promise<void> };
  t.mock.method(inner, "drop", async () => {
    throw new Error("refused");
  });
  assert.equal(await session.stop(), true);
});

test("a stop while the end notes are fed still gets its note", async (t) => {
  const agent = new GatedAgent();
  const world = await AskingWorld.make(t, { agent });
  const { ref, session } = world.thread();
  const inner = session as unknown as {
    endNotes: string[];
    active: { renderer: { feedError: (text: string) => Promise<void> } } | null;
  };
  agent.next(say("x"), hold());
  await session.submit("first");
  await until("the first turn runs", () => inner.active !== null);
  await session.submit("second");
  // A note owed to this reply already (a taken-in prompt's, or a drain's).
  inner.endNotes.push("an earlier note");
  const renderer = inner.active?.renderer as { feedError: (text: string) => Promise<void> };
  const fed = new AsyncEvent();
  const feeding = new AsyncEvent();
  const original = renderer.feedError.bind(renderer);
  let first = true;
  t.mock.method(renderer, "feedError", async (text: string) => {
    if (first) {
      first = false;
      feeding.set();
      await fed.wait();
    }
    return original(text);
  });
  t.after(() => fed.set());
  agent.sessions[0]?.release();
  await feeding.wait();

  await session.stop();
  fed.set();
  await until("the note", () => world.shown(ref).some((line) => line.includes(NOT_SENT_ONE)));
  assert.deepEqual(inner.endNotes, []);
  assert.deepEqual(sentTo(agent), ["first"]);
});
