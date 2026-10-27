/**
 * A session open in a terminal on the host (`flows/terminal.ts`): a terminal's running turn is
 * waited out, a terminal left open is asked about once, what it wrote is shown before the reply,
 * and `!terminal` gives the line to run there.
 */
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { SessionHolder } from "../../../src/agent/seam.ts";
import type { TerminalRequest, ThreadRef } from "../../../src/chat/seam.ts";
import { TERMINAL_POLL_SECONDS } from "../../../src/core/flows/terminal.ts";
import * as texts from "../../../src/core/texts.ts";
import { fill } from "../../../src/core/texts.ts";
import { shellQuote } from "../../../src/text.ts";
import { PlainAgent } from "../../support/plain-agent.ts";
import { settledTurn } from "../../support/sessions.ts";
import { AskingWorld } from "./asking-world.ts";

const SESSION = "plain-terminal-1";

async function makeWorld(t: TestContext) {
  const agent = new PlainAgent({ terminal: true });
  const made = await AskingWorld.make(t, { agent });
  const { ref, session } = made.thread();
  made.state.setSession(ref.channel, ref.thread, SESSION);
  return { world: made, agent, ref, session };
}

/** What the thread shows below its first message. */
function after(world: AskingWorld, ref: ThreadRef): readonly string[] {
  return world.shown(ref).slice(1);
}

const idle = (id: string): SessionHolder => ({ id, own: false, busy: false });
const busy = (id: string): SessionHolder => ({ id, own: false, busy: true });
const own: SessionHolder = { id: "1", own: true, busy: false };

test("with no terminal the message goes on and nothing is asked", async (t) => {
  const { world, agent, ref, session } = await makeWorld(t);
  agent.holders.set(SESSION, [own]);
  assert.equal(await world.flows.terminal.beforeSending(ref, session), true);
  assert.deepEqual(world.open(ref), []);
  assert.deepEqual(after(world, ref), []);
});

test("a terminal left open is asked about once, and Send here sends", async (t) => {
  const { world, agent, ref, session } = await makeWorld(t);
  agent.holders.set(SESSION, [own, idle("77")]);
  const sent = world.flows.terminal.beforeSending(ref, session);
  const open = await world.asked(ref, "terminal");
  const command = fill(agent.words.terminal, {
    directory: shellQuote(world.folder),
    session: SESSION,
  });
  assert.deepEqual(open.request, {
    type: "terminal",
    requestId: open.requestId,
    state: "open",
    running: null,
    command,
  } satisfies TerminalRequest);
  assert.equal(open.title, texts.TERMINAL_OPEN_TITLE);
  // withdrawn by the crash repair, as the same-folder hold
  assert.deepEqual(world.state.thread(ref.channel, ref.thread)?.requestKinds, {
    [open.message]: "hold",
  });
  assert.equal(await world.answers(open.requestId, { type: "terminal", go: true }), true);
  assert.equal(await sent, true);
  assert.ok(world.shown(ref).includes(texts.TERMINAL_SENT), "the question says it was sent");
  assert.deepEqual(world.state.thread(ref.channel, ref.thread)?.requests, []);
  assert.ok(!world.shown(ref).includes(texts.NOT_SENT));

  // the same terminal again: not asked
  assert.equal(await world.flows.terminal.beforeSending(ref, session), true);
  assert.deepEqual(world.open(ref), []);
  // another terminal process: asked again
  agent.holders.set(SESSION, [idle("78")]);
  const again = world.flows.terminal.beforeSending(ref, session);
  const second = await world.asked(ref, "terminal");
  assert.equal(await world.answers(second.requestId, { type: "terminal", go: false }), true);
  assert.equal(await again, false);
});

test("Cancel beside an open terminal sends nothing, and the question says so", async (t) => {
  const { world, agent, ref, session } = await makeWorld(t);
  agent.holders.set(SESSION, [idle("77")]);
  const sent = world.flows.terminal.beforeSending(ref, session);
  const open = await world.asked(ref, "terminal");
  assert.equal(await world.answers(open.requestId, { type: "terminal", go: false }), true);
  assert.equal(await sent, false);
  assert.equal(world.shown(ref).filter((line) => line === texts.NOT_SENT).length, 1);
  assert.deepEqual(world.open(ref), []);
});

test("a terminal's running turn is waited out, then the open terminal is asked about", async (t) => {
  const { world, agent, ref, session } = await makeWorld(t);
  agent.holders.set(SESSION, [busy("77")]);
  const sent = world.flows.terminal.beforeSending(ref, session);
  const waiting = await world.asked(ref, "terminal");
  assert.equal((waiting.request as TerminalRequest).state, "busy");
  assert.equal(waiting.title, texts.TERMINAL_BUSY_TITLE);
  // still busy at the first look
  await world.clock.advance(TERMINAL_POLL_SECONDS);
  await settledTurn();
  assert.equal(world.open(ref).length, 1);
  agent.holders.set(SESSION, [idle("77")]);
  await world.clock.advance(TERMINAL_POLL_SECONDS);
  const open = await (async () => {
    for (let round = 0; round < 200; round += 1) {
      const found = world.open(ref).find((r) => (r.request as TerminalRequest).state === "open");
      if (found !== undefined) return found;
      await settledTurn();
    }
    throw new Error("the open terminal was not asked about");
  })();
  assert.ok(world.shown(ref).includes(texts.TERMINAL_TURN_ENDED));
  assert.equal(await world.answers(open.requestId, { type: "terminal", go: true }), true);
  assert.equal(await sent, true);
});

test("a cancelled wait for a terminal's turn sends nothing", async (t) => {
  const { world, agent, ref, session } = await makeWorld(t);
  agent.holders.set(SESSION, [busy("77")]);
  const sent = world.flows.terminal.beforeSending(ref, session);
  const waiting = await world.asked(ref, "terminal");
  assert.equal(await world.answers(waiting.requestId, { type: "terminal", go: false }), true);
  assert.equal(await sent, false);
  assert.ok(world.shown(ref).includes(texts.NOT_SENT));
});

test("the turns a terminal wrote come first, one message each", async (t) => {
  const { world, agent, ref, session } = await makeWorld(t);
  session.saved = { id: "m1", at: 1 };
  agent.foreign.set(SESSION, {
    changed: true,
    turns: [
      { prompt: "Rename the helper", reply: "Renamed it." },
      { prompt: "Still there?", reply: null },
    ],
    last: { id: "m9", at: 9 },
  });
  assert.equal(await world.flows.terminal.beforeSending(ref, session), true);
  assert.deepEqual(agent.foreignAsked, [`${SESSION} m1`]);
  assert.deepEqual(after(world, ref), [
    fill(texts.TERMINAL_TURN, { prompt: "Rename the helper", reply: "Renamed it." }),
    fill(texts.TERMINAL_TURN_UNANSWERED, { prompt: "Still there?" }),
  ]);
  assert.deepEqual(session.saved, { id: "m9", at: 9 });
});

test("!terminal on a session that has not started says so", async (t) => {
  const { world, ref } = await makeWorld(t);
  const fresh = world.thread();
  await world.flows.terminal.move(fresh.ref, fresh.session);
  assert.deepEqual(after(world, fresh.ref), [texts.TERMINAL_NOT_STARTED]);
  assert.deepEqual(after(world, ref), []);
});

test("!terminal on an idle session gives the line that continues it", async (t) => {
  const { world, agent, ref, session } = await makeWorld(t);
  await world.flows.terminal.move(ref, session);
  const command = fill(agent.words.terminal, {
    directory: shellQuote(world.folder),
    session: SESSION,
  });
  assert.deepEqual(after(world, ref), [fill(texts.TERMINAL_IDLE, { command: `\`${command}\`` })]);
});

test("a stop during a terminal's question removes it and says Not sent.", async (t) => {
  const { world, agent, ref, session } = await makeWorld(t);
  agent.holders.set(SESSION, [busy("77")]);
  const sent = world.flows.terminal.beforeSending(ref, session);
  await world.asked(ref, "terminal");
  await session.stop();
  assert.equal(await sent, false);
  assert.deepEqual(world.open(ref), []);
  assert.ok(world.shown(ref).includes(texts.NOT_SENT));
});

test("a list that cannot be read keeps a wait going", async (t) => {
  const { world, agent, ref, session } = await makeWorld(t);
  agent.holders.set(SESSION, [busy("77")]);
  const sent = world.flows.terminal.beforeSending(ref, session);
  const waiting = await world.asked(ref, "terminal");
  agent.holders.set(SESSION, null);
  await world.clock.advance(TERMINAL_POLL_SECONDS);
  await settledTurn();
  assert.equal(world.open(ref).length, 1, "still waiting");
  assert.equal(await world.answers(waiting.requestId, { type: "terminal", go: false }), true);
  assert.equal(await sent, false);
});
