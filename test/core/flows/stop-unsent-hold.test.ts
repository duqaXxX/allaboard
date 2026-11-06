// A stop with one turn taken while the process starts and another in a same-folder hold (#200):
// the hold ending must not put the root back to working over the dropped turn.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RequestHandler, StartOptions } from "../../../src/agent/seam.ts";
import * as texts from "../../../src/core/texts.ts";
import { AsyncEvent } from "../../support/fake-clock.ts";
import { hold, PlainAgent } from "../../support/plain-agent.ts";
import { settledTurn } from "../../support/settle.ts";
import { AskingWorld } from "./asking-world.ts";

class GatedAgent extends PlainAgent {
  gate: AsyncEvent | null = null;

  override async start(options: StartOptions, requests: RequestHandler) {
    await this.gate?.wait();
    return super.start(options, requests);
  }
}

test("a stop with a turn taken and another in a hold ends the root done", async (t) => {
  const agent = new GatedAgent();
  const world = await AskingWorld.make(t, { agent });
  const neighbour = world.thread();
  agent.next(hold());
  await neighbour.session.submit("long job");
  for (let round = 0; round < 50 && !neighbour.session.busy; round += 1) await settledTurn();
  assert.ok(neighbour.session.busy, "the neighbour works");

  const { ref, session } = world.thread();
  agent.gate = new AsyncEvent();
  await session.submit("first");
  await settledTurn();
  assert.ok((session as unknown as { taken: unknown }).taken !== null, "P1 is taken");
  const second = world.flows.hold.beforeSending(ref, session, neighbour.session);
  await world.asked(ref, "hold");
  assert.equal(world.state.thread(ref.channel, ref.thread)?.status, "waiting");

  await session.stop();
  assert.equal(await second, false);
  agent.gate.set();
  const note = texts.fill(texts.NOT_SENT_ONE, { count: 1, because: texts.BECAUSE_OWNER_STOPPED });
  for (let round = 0; round < 200; round += 1) {
    const stored = world.state.thread(ref.channel, ref.thread);
    if (stored?.ended === "done" && stored.status === null) break;
    await settledTurn();
  }
  const shown = world.shown(ref);
  assert.ok(shown.includes(texts.NOT_SENT), "the hold says Not sent.");
  assert.ok(shown.some((line) => line.includes(note)));
  assert.equal(world.state.thread(ref.channel, ref.thread)?.status, null);
  assert.equal(world.state.thread(ref.channel, ref.thread)?.ended, "done");
  assert.deepEqual(
    agent.sessions.flatMap((s) => s.prompts.map((p) => p.content)),
    ["long job"],
  );
});
