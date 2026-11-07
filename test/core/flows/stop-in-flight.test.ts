/**
 * A stop acts on every prompt handed over before it that has not reached the agent (#200): a
 * prompt still reading its files, waiting behind another prompt, connecting its session or asking
 * its setup is dropped with `Not sent.`, and the stop says nothing more.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession, RequestHandler, StartOptions } from "../../../src/agent/seam.ts";
import * as texts from "../../../src/core/texts.ts";
import { AsyncEvent } from "../../support/fake-clock.ts";
import { OWNER } from "../../support/memory-chat.ts";
import { hold, PlainAgent, say } from "../../support/plain-agent.ts";
import { MessagesWorld } from "./messages-world.ts";

const LIMIT = { timeout: 8000 };

/** A prompt whose files are still being read: `done` lets `content()` return. */
function slowPrompt(text: string, done: AsyncEvent) {
  return {
    content: async () => {
      await done.wait();
      return text;
    },
  };
}

const notSent = (lines: readonly string[]) =>
  lines.filter((line) => line === texts.NOT_SENT).length;

test(
  "a prompt reading its files, then !stop: Not sent., nothing submitted, no Nothing is running",
  LIMIT,
  async (t) => {
    const world = await MessagesWorld.make(t);
    const ref = await world.opened();
    const done = new AsyncEvent();
    const sending = world.send({ ref, id: "m-2", text: "second", ...slowPrompt("second", done) });
    await world.settle();
    await world.says("!stop", ref.thread);
    done.set();
    await sending;
    await world.settle();
    assert.equal(notSent(world.shown(ref)), 1);
    assert.ok(!world.shown(ref).includes(texts.NOTHING_TO_STOP_THREAD));
    assert.deepEqual(await world.prompts(), ["first"]);
    // A prompt sent after the stop runs.
    (world.agent as PlainAgent).next(say("fine"));
    await world.says("third", ref.thread);
    assert.deepEqual(await world.prompts(), ["first", "third"]);
  },
);

test("ChatInbound.stop drops the prompt on its way too, and answers true", LIMIT, async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  const done = new AsyncEvent();
  const sending = world.send({ ref, id: "m-2", text: "second", ...slowPrompt("second", done) });
  await world.settle();
  assert.equal(await world.inbound.stop(ref), true);
  done.set();
  await sending;
  assert.equal(notSent(world.shown(ref)), 1);
  assert.ok(!world.shown(ref).includes(texts.NOTHING_TO_STOP_THREAD));
  assert.deepEqual(await world.prompts(), ["first"]);
});

test("a top-level !stop drops the prompts of every thread of the channel", LIMIT, async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  const done = new AsyncEvent();
  const sending = world.send({ ref, id: "m-2", text: "second", ...slowPrompt("second", done) });
  await world.settle();
  await world.says("!stop");
  done.set();
  await sending;
  assert.equal(notSent(world.shown(ref)), 1);
  assert.ok(!world.inChannel().includes(texts.NOTHING_TO_STOP));
  assert.deepEqual(await world.prompts(), ["first"]);
});

test(
  "a prompt waiting behind an earlier one leaves the line at once on a stop",
  LIMIT,
  async (t) => {
    const world = await MessagesWorld.make(t);
    const ref = await world.opened();
    const first = new AsyncEvent();
    const second = new AsyncEvent();
    const a = world.send({ ref, id: "m-2", text: "a", ...slowPrompt("a", first) });
    const b = world.send({ ref, id: "m-3", text: "b", ...slowPrompt("b", second) });
    await world.settle();
    await world.says("!stop", ref.thread);
    await world.settle();
    // The second said so while the first still reads its files.
    assert.equal(notSent(world.shown(ref)), 1);
    first.set();
    second.set();
    await Promise.all([a, b]);
    assert.equal(notSent(world.shown(ref)), 2);
    assert.deepEqual(await world.prompts(), ["first"]);
  },
);

/** A plain agent whose process start waits for `gate`. */
class SlowStart extends PlainAgent {
  readonly gate = new AsyncEvent();
  override async start(options: StartOptions, requests: RequestHandler): Promise<AgentSession> {
    await this.gate.wait();
    return super.start(options, requests);
  }
}

test("a stop during the connect of a new thread's setup opens no form", LIMIT, async (t) => {
  const agent = new SlowStart();
  const world = await MessagesWorld.make(t, { agent });
  const sending = world.says("hello");
  await world.settle();
  const [thread] = world.state.threads();
  assert.ok(thread);
  const ref = { channel: thread[0], thread: thread[1] };
  await world.says("!stop", ref.thread);
  agent.gate.set();
  await sending;
  await world.settle();
  assert.equal(world.chat.requests().length, 0);
  assert.equal(notSent(world.shown(ref)), 1);
  assert.ok(!world.shown(ref).includes(texts.NOTHING_TO_STOP_THREAD));
});

test(
  "a !stop in a new thread whose prompt waits to start says nothing but Not sent.",
  LIMIT,
  async (t) => {
    const world = await MessagesWorld.make(t);
    const ref = { channel: world.channel, thread: "m-new" };
    const release = new AsyncEvent();
    world.sessions.refusesStarts = async () => {
      await release.wait();
      return false;
    };
    const sending = world.send({ ref, id: ref.thread, topLevel: true, text: "hello" });
    await world.settle();
    await world.send({ ref, id: "m-stop", text: "!stop" });
    release.set();
    await sending;
    await world.settle();
    assert.ok(!world.shown(ref).includes(texts.STOP_OUTSIDE_SESSION));
    assert.equal(notSent(world.shown(ref)), 1);
    assert.equal(world.chat.requests().length, 0);
  },
);

test("!fork waiting on a busy original is cancelled by a stop of the thread", LIMIT, async (t) => {
  const agent = new PlainAgent();
  const world = await MessagesWorld.make(t, { agent });
  const origin = await world.opened("the first task");
  agent.next(say("Working"), hold());
  await world.says("a long job", origin.thread);
  await world.settle();
  const forking = world.says("!fork", origin.thread);
  await world.settle();
  await world.says("!stop", origin.thread);
  await forking;
  await world.settle();
  assert.equal(world.state.threads().length, 1, "no copy");
  assert.equal(notSent(world.shown(origin)), 1);
});

test(
  "a stop while refusesStarts waits, which then refuses, says Not sent. once and writes no entry",
  LIMIT,
  async (t) => {
    const world = await MessagesWorld.make(t);
    const ref = { channel: world.channel, thread: "m-new" };
    const release = new AsyncEvent();
    world.sessions.refusesStarts = async () => {
      await release.wait();
      return true;
    };
    const sending = world.send({ ref, id: ref.thread, topLevel: true, text: "hello" });
    await world.settle();
    await world.send({ ref, id: "m-stop", text: "!stop" });
    release.set();
    await sending;
    await world.settle();
    assert.equal(notSent(world.shown(ref)), 1);
    assert.ok(!world.shown(ref).includes(texts.RESTARTING));
    assert.equal(world.state.thread(ref.channel, ref.thread), null);
  },
);

// A stop that lands after a Start or a Continue left the thread's mark waiting must not leave it
// so: the prompt is dropped, and the mark it was waiting on is put back.
const waiting = (world: MessagesWorld, ref: { channel: string; thread: string }) =>
  world.state.thread(ref.channel, ref.thread)?.status === "waiting";

/** The stop of `ref`, sent from inside whatever `target[method]` is, once. */
function stopWhen<T extends object>(
  world: MessagesWorld,
  ref: { channel: string; thread: string },
  target: T,
  method: keyof T,
): void {
  const original = (target[method] as (...args: unknown[]) => unknown).bind(target);
  let fired = false;
  (target as Record<keyof T, unknown>)[method] = (...args: unknown[]) => {
    if (!fired) {
      fired = true;
      void world.send({ ref, id: "m-stop", text: "!stop" });
    }
    return original(...args);
  };
}

test("a stop right after the Start leaves no waiting mark", LIMIT, async (t) => {
  const world = await MessagesWorld.make(t);
  const sending = world.says("hello");
  const { ref } = await world.asked("setup");
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session !== null);
  stopWhen(world, ref, session, "holdEnd");
  await world.start(ref);
  await sending;
  await world.settle();
  assert.equal(notSent(world.shown(ref)), 1);
  assert.equal(waiting(world, ref), false);
});

test(
  "a stop right after a Continue on the same-folder hold leaves no waiting mark",
  LIMIT,
  async (t) => {
    const agent = new PlainAgent();
    const world = await MessagesWorld.make(t, { agent });
    const ref = await world.opened("one");
    const neighbour = await world.opened("two");
    agent.next(hold());
    await world.says("a long job", neighbour.thread);
    await world.settle();
    const session = world.sessions.get(ref.channel, ref.thread);
    assert.ok(session !== null);
    stopWhen(world, ref, session, "holdEnd");
    const sending = world.says("again", ref.thread);
    const open = await world.asked("hold", ref);
    await world.chat.as(OWNER).answers(open.requestId, { type: "hold", send: true });
    await sending;
    await world.settle();
    assert.equal(notSent(world.shown(ref)), 1);
    assert.equal(waiting(world, ref), false);
  },
);

test(
  "a stop that lands before the hold opens, after a Start, leaves no waiting mark",
  LIMIT,
  async (t) => {
    const agent = new PlainAgent();
    const world = await MessagesWorld.make(t, { agent });
    const neighbour = await world.opened("two");
    agent.next(hold());
    await world.says("a long job", neighbour.thread);
    await world.settle();
    const sending = world.says("hello");
    const { ref } = await world.asked("setup");
    stopWhen(world, ref, world.sessions, "workingIn");
    await world.start(ref);
    await sending;
    await world.settle();
    assert.equal(notSent(world.shown(ref)), 1);
    assert.equal(waiting(world, ref), false);
  },
);

test(
  "a !!command waiting behind a prompt is dropped by a stop before its confirmation is asked",
  LIMIT,
  async (t) => {
    const world = await MessagesWorld.make(t, { agent: new PlainAgent({ shell: {} }) });
    const ref = await world.opened();
    const done = new AsyncEvent();
    const a = world.send({ ref, id: "m-2", text: "a", ...slowPrompt("a", done) });
    const b = world.send({ ref, id: "m-3", text: "!!ls" });
    await world.settle();
    await world.says("!stop", ref.thread);
    done.set();
    await Promise.all([a, b]);
    await world.settle();
    assert.equal(notSent(world.shown(ref)), 2);
    assert.equal(world.chat.requests().length, 0);
  },
);

/** A world with an idle terminal holding the thread's session that the owner has not allowed. */
async function terminalAsked(t: Parameters<typeof MessagesWorld.make>[0]) {
  const agent = new PlainAgent({ terminal: true });
  const world = await MessagesWorld.make(t, { agent });
  const ref = await world.opened();
  const id = world.state.thread(ref.channel, ref.thread)?.sessionId;
  assert.ok(id);
  agent.holders.set(id, [{ id: "77", own: false, busy: false }]);
  return { agent, world, ref };
}

test("a stop right after Send here leaves no waiting mark", LIMIT, async (t) => {
  const { world, ref } = await terminalAsked(t);
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session !== null);
  const sending = world.says("written meanwhile", ref.thread);
  const open = await world.asked("terminal", ref);
  stopWhen(world, ref, session, "holdEnd");
  await world.chat.as(OWNER).answers(open.requestId, { type: "terminal", go: true });
  await sending;
  await world.settle();
  assert.equal(notSent(world.shown(ref)), 1);
  assert.equal(waiting(world, ref), false);
});

test("without a stop, Send here sends the prompt", LIMIT, async (t) => {
  const { agent, world, ref } = await terminalAsked(t);
  agent.next(say("done"));
  const sending = world.says("written meanwhile", ref.thread);
  const open = await world.asked("terminal", ref);
  await world.chat.as(OWNER).answers(open.requestId, { type: "terminal", go: true });
  await sending;
  assert.ok((await world.prompts()).includes("written meanwhile"));
  assert.equal(waiting(world, ref), false);
});

test(
  "a !!command stopped while starts are refused says Not sent. once and no refusal",
  LIMIT,
  async (t) => {
    const world = await MessagesWorld.make(t, { agent: new PlainAgent({ shell: {} }) });
    const ref = await world.opened();
    Object.defineProperty(world.sessions, "draining", { get: () => true });
    // Sent in one tick: the command holds the line and its ticket, then the stop aborts it before
    // the command's first check runs.
    const sending = world.send({ ref, id: "m-2", text: "!!ls" });
    await world.send({ ref, id: "m-stop", text: "!stop" });
    await sending;
    await world.settle();
    assert.equal(notSent(world.shown(ref)), 1);
    assert.ok(!world.shown(ref).includes(texts.RESTARTING));
    assert.equal(world.chat.requests().length, 0);
  },
);

/** A plain agent whose fork waits for `gate`. */
class SlowFork extends PlainAgent {
  readonly gate = new AsyncEvent();
  override async forkSession(folder: string, session: string, title: string | null) {
    await this.gate.wait();
    return super.forkSession(folder, session, title);
  }
}

test(
  "a top-level !stop while the fork is made drops the copy's prompt with Not sent. once",
  LIMIT,
  async (t) => {
    const agent = new SlowFork();
    const world = await MessagesWorld.make(t, { agent });
    const origin = await world.opened("the first task");
    const forking = world.says("!fork look into it", origin.thread);
    await world.settle();
    assert.equal(world.state.threads().length, 1, "the copy is not made yet");
    await world.says("!stop");
    agent.gate.set();
    await forking;
    await world.settle();
    const copy = world.state.threads().find(([, thread]) => thread !== origin.thread);
    assert.ok(copy, "the copy was made: the stop came after the fork was committed");
    const ref = { channel: copy[0], thread: copy[1] };
    assert.ok(!(await world.prompts()).includes("look into it"));
    assert.equal(notSent(world.shown(ref)), 1);
  },
);

test(
  "a stop of the original thread after the copy is made does not drop the fork",
  LIMIT,
  async (t) => {
    const agent = new SlowFork();
    const world = await MessagesWorld.make(t, { agent });
    const origin = await world.opened("the first task");
    const forking = world.says("!fork look into it", origin.thread);
    await world.settle();
    await world.says("!stop", origin.thread);
    agent.gate.set();
    await forking;
    await world.settle();
    assert.ok((await world.prompts()).includes("look into it"));
  },
);

// A fork that ends early gives its channel-stop bridge back: a later top-level stop with nothing
// running answers as such.
class FailingFork extends PlainAgent {
  override async forkSession(): Promise<string> {
    throw new Error("no fork");
  }
}

test(
  "a fork that fails leaves no ticket behind: a later top-level !stop answers",
  LIMIT,
  async (t) => {
    const world = await MessagesWorld.make(t, { agent: new FailingFork() });
    const origin = await world.opened("the first task");
    await world.says("!fork look into it", origin.thread);
    await world.settle();
    await world.says("!stop");
    await world.settle();
    assert.equal(world.inChannel().at(-1), texts.NOTHING_TO_STOP);
  },
);

test("a fork refused for an old folder leaves no ticket behind", LIMIT, async (t) => {
  const world = await MessagesWorld.make(t);
  const origin = await world.opened("the first task");
  world.state.bind(world.channel, join(world.folder, "elsewhere"));
  await world.says("!fork look into it", origin.thread);
  await world.settle();
  await world.says("!stop");
  await world.settle();
  assert.equal(world.inChannel().at(-1), texts.NOTHING_TO_STOP);
});

test(
  "a fork with no prompt holds no ticket: a top-level !stop during it answers as if none",
  LIMIT,
  async (t) => {
    const agent = new SlowFork();
    const world = await MessagesWorld.make(t, { agent });
    const origin = await world.opened("the first task");
    const forking = world.says("!fork", origin.thread);
    await world.settle();
    await world.says("!stop");
    await world.settle();
    assert.equal(world.inChannel().at(-1), texts.NOTHING_TO_STOP);
    agent.gate.set();
    await forking;
  },
);

test(
  "a stop of the copy's thread before its prompt is sent drops the prompt once",
  LIMIT,
  async (t) => {
    for (const viaInbound of [false, true]) {
      const agent = new PlainAgent();
      const world = await MessagesWorld.make(t, { agent });
      const origin = await world.opened("the first task");
      // The copy's thread exists once the fork opens it: stop it as soon as the copy is resumed.
      const resume = world.sessions.resume.bind(world.sessions);
      world.sessions.resume = async (channel, thread, id) => {
        const copied = await resume(channel, thread, id);
        void (viaInbound
          ? world.inbound.stop({ channel, thread })
          : world.send({ ref: { channel, thread }, id: "m-stop", text: "!stop" }));
        return copied;
      };
      await world.says("!fork look into it", origin.thread);
      await world.settle();
      const copy = world.state.threads().find(([, thread]) => thread !== origin.thread);
      assert.ok(copy);
      const ref = { channel: copy[0], thread: copy[1] };
      assert.ok(!(await world.prompts()).includes("look into it"), `inbound ${viaInbound}`);
      assert.equal(notSent(world.shown(ref)), 1, `inbound ${viaInbound}`);
    }
  },
);

/** The thread the fork opened, once it did. */
function copyOf(world: MessagesWorld, origin: { thread: string }) {
  const copy = world.state.threads().find(([, thread]) => thread !== origin.thread);
  assert.ok(copy, "the copy was made");
  return { channel: copy[0], thread: copy[1] };
}

test(
  "a stop of the copy's thread during its resume, which then fails, says Not sent. once",
  LIMIT,
  async (t) => {
    for (const viaInbound of [false, true]) {
      const world = await MessagesWorld.make(t);
      const origin = await world.opened("the first task");
      const resume = world.sessions.resume.bind(world.sessions);
      world.sessions.resume = async (channel, thread, id) => {
        await resume(channel, thread, id);
        const ref = { channel, thread };
        await (viaInbound
          ? world.inbound.stop(ref)
          : world.send({ ref, id: "m-stop", text: "!stop" }));
        return null;
      };
      await world.says("!fork do X", origin.thread);
      await world.settle();
      const all = [...world.shown(origin), ...world.shown(copyOf(world, origin))];
      assert.equal(notSent(all), 1, `inbound ${viaInbound}`);
    }
  },
);

test(
  "a second stop in the copy's thread after the channel stop dropped nothing more",
  LIMIT,
  async (t) => {
    const agent = new SlowFork();
    const world = await MessagesWorld.make(t, { agent });
    const origin = await world.opened("the first task");
    const resume = world.sessions.resume.bind(world.sessions);
    world.sessions.resume = async (channel, thread, id) => {
      const copied = await resume(channel, thread, id);
      await world.send({ ref: { channel, thread }, id: "m-stop-2", text: "!stop" });
      return copied;
    };
    const forking = world.says("!fork fix the bug", origin.thread);
    await world.settle();
    await world.says("!stop");
    agent.gate.set();
    await forking;
    await world.settle();
    assert.ok(world.shown(copyOf(world, origin)).includes(texts.NOTHING_TO_STOP_THREAD));
  },
);

test("a fork whose prompt a channel stop dropped does not say it is running", LIMIT, async (t) => {
  const agent = new SlowFork();
  const world = await MessagesWorld.make(t, { agent });
  const origin = await world.opened("the first task");
  const forking = world.says("!fork fix the bug", origin.thread);
  await world.settle();
  await world.says("!stop");
  agent.gate.set();
  await forking;
  await world.settle();
  assert.ok(!world.shown(origin).some((line) => line.includes("· running")));
});
