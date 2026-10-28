/**
 * `!terminal` through the message flow, and a message that meets a terminal on the way to its
 * session: the word cuts a running turn without an interrupt, ends its reply and gives the line
 * that continues it; the next message resumes the same session id.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as texts from "../../../src/core/texts.ts";
import { fill } from "../../../src/core/texts.ts";
import { shellQuote } from "../../../src/text.ts";
import { OWNER } from "../../support/memory-chat.ts";
import { hold, PlainAgent, saved, say } from "../../support/plain-agent.ts";
import { settledTurn } from "../../support/settle.ts";
import { MessagesWorld } from "./messages-world.ts";

test("!terminal during a turn cuts it with no interrupt and gives the continuing line", async (t) => {
  const agent = new PlainAgent({ terminal: true });
  const world = await MessagesWorld.make(t, { agent });
  const ref = await world.opened();
  agent.next(say("Working"), hold());
  await world.says("a long job", ref.thread);
  await world.settle();
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.equal(session?.busy, true);
  const live = agent.sessions.at(-1);
  assert.ok(live !== undefined);
  let interrupts = 0;
  live.interrupt = async () => {
    interrupts += 1;
  };

  await world.says("!terminal", ref.thread);
  await world.settle();
  assert.equal(session?.busy, false);
  assert.equal(live.closed, true, "the process is closed");
  assert.equal(interrupts, 0, "the turn is cut by the close, never interrupted");
  const shown = world.shown(ref);
  assert.ok(
    shown.some((line) => line.includes(texts.MOVED_TO_TERMINAL)),
    shown.join("\n"),
  );
  const id = world.state.thread(ref.channel, ref.thread)?.sessionId;
  assert.ok(id);
  const continuing = agent.words.terminalContinue ?? "";
  const command = fill(continuing, { directory: shellQuote(world.folder), session: id });
  const answer = shown.at(-1) ?? "";
  assert.ok(answer.startsWith("Stopped here."), answer);
  assert.ok(answer.endsWith(`\`${command}\``), answer);

  // the next message resumes the same session
  agent.next(say("Back here."));
  await world.says("and now?", ref.thread);
  await world.settle();
  assert.equal(agent.starts.at(-1)?.resume, id);
  assert.ok(world.shown(ref).some((line) => line.includes("Back here.")));
});

test("a message beside a terminal that runs a turn waits under the notice", async (t) => {
  const agent = new PlainAgent({ terminal: true });
  const world = await MessagesWorld.make(t, { agent });
  const ref = await world.opened();
  const id = world.state.thread(ref.channel, ref.thread)?.sessionId;
  assert.ok(id);
  agent.holders.set(id, [{ id: "77", own: false, busy: true }]);
  void world.says("written meanwhile", ref.thread);
  await world.settle();
  const open = world.chat.requests().find((request) => request.ref.thread === ref.thread);
  assert.equal(open?.request.type, "terminal");
  assert.ok(world.shown(ref).includes(texts.TERMINAL_BUSY_TITLE), world.shown(ref).join("\n"));
  assert.equal(agent.sessions.at(-1)?.prompts.length, 1, "only the first message reached it");
  // Cancel: nothing is sent, and the wait ends
  assert.ok(open !== undefined);
  await world.chat.as(OWNER).answers(open.requestId, { type: "terminal", go: false });
  await world.settle();
  assert.equal(agent.sessions.at(-1)?.prompts.length, 1);
  assert.ok(world.shown(ref).includes(texts.NOT_SENT));
});

test("a turn the agent opens while the terminal's turns are read is never cut", async (t) => {
  const agent = new PlainAgent({ terminal: true });
  const world = await MessagesWorld.make(t, { agent });
  agent.next(saved("m1", 1), say("first done"));
  const ref = await world.opened();
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.deepEqual(session?.saved, { id: "m1", at: 1 });
  const first = agent.sessions.at(-1);
  agent.next(say("report going"), hold());
  agent.next(say("answer to the owner"));
  agent.turnsAfter = async () => {
    // a turn of the agent's own (a report) starts during the read
    void session?.submit("stand-in for a turn the agent opened");
    for (let round = 0; round < 300 && !session?.busy; round += 1) await settledTurn();
    return {
      changed: true,
      turns: [{ prompt: "typed there", reply: "done there" }],
      last: { id: "m9", at: 9 },
    };
  };
  const sending = world.says("hello again", ref.thread);
  await world.settle();
  assert.equal(first?.closed, false, "the process running a turn is not closed");
  assert.equal(agent.sessions.length, 1);
  first?.release();
  await sending;
  await world.settle();
  assert.ok(world.shown(ref).some((line) => line.includes("answer to the owner")));
  assert.ok(world.shown(ref).some((line) => line.includes("done there")));
});
