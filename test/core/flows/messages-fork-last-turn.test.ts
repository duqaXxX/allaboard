/**
 * `!fork` shows the original's last turn first in the copy's thread (#141): the owner's prompt
 * as a quote and the start of the final reply; nothing when the agent cannot read it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Capabilities, ForeignTurn } from "../../../src/agent/seam.ts";
import { FORK_LAST_TURN_LIMIT } from "../../../src/core/flows/fork.ts";
import * as texts from "../../../src/core/texts.ts";
import { PLAIN_CAPABILITIES, PlainAgent, say } from "../../support/plain-agent.ts";
import { MessagesWorld } from "./messages-world.ts";

async function forked(
  t: Parameters<typeof MessagesWorld.make>[0],
  agent: PlainAgent,
  last: ForeignTurn | Error | null,
  word: string,
) {
  const world = await MessagesWorld.make(t, { agent });
  const origin = await world.opened("the first task");
  agent.lastTurn = async () => {
    if (last instanceof Error) throw last;
    return last;
  };
  agent.next(say("Working."));
  await world.says(word, origin.thread);
  await world.settle();
  const other = world.state.threads().find(([, thread]) => thread !== origin.thread);
  assert.ok(other, "a second thread holds the copy");
  return world.shown({ channel: other[0], thread: other[1] });
}

const LAST: ForeignTurn = { prompt: "add rate limiting", reply: "Added a token bucket." };

for (const word of ["!fork", "!fork keep going"]) {
  test(`${word} shows the original's last turn first in the copy's thread`, async (t) => {
    const lines = await forked(t, new PlainAgent({ terminal: true }), LAST, word);
    const shown = lines.find((line) => line.startsWith("Last in the original:"));
    assert.ok(shown, JSON.stringify(lines));
    assert.equal(shown, "Last in the original:\n\n> add rate limiting\n\nAdded a token bucket.");
    assert.ok(!shown.includes(texts.FORK_LAST_TURN_MORE.trim()), "a short reply is whole");
    if (word !== "!fork")
      assert.ok(lines.indexOf(shown) < lines.findIndex((line) => line.includes("Working.")));
  });
}

test("a long reply is cut and says the rest is in the original", async (t) => {
  const reply = `${"word ".repeat(FORK_LAST_TURN_LIMIT)}end`;
  const lines = await forked(
    t,
    new PlainAgent({ terminal: true }),
    { prompt: "p", reply },
    "!fork",
  );
  const shown = lines.find((line) => line.startsWith("Last in the original:")) ?? "";
  assert.ok(shown.includes("…") && shown.includes("(open the original for more)"), shown);
  assert.ok(!shown.includes("end"), shown);
});

test("nothing is posted when the original has no turn", async (t) => {
  const lines = await forked(t, new PlainAgent({ terminal: true }), null, "!fork");
  assert.ok(!lines.some((line) => line.includes("Last in the original")));
});

test("nothing is posted, and the fork goes on, when the agent cannot read it", async (t) => {
  const lines = await forked(
    t,
    new PlainAgent({ terminal: true }),
    new Error("unreadable"),
    "!fork x",
  );
  assert.ok(!lines.some((line) => line.includes("Last in the original")));
  assert.ok(lines.some((line) => line.includes("Working.")));
});

test("an agent without foreignTurns is not asked", async (t) => {
  class Without extends PlainAgent {
    override capabilities: Capabilities = { ...PLAIN_CAPABILITIES, sessionForks: true };
  }
  const agent = new Without({ terminal: true });
  agent.capabilities = { ...agent.capabilities, foreignTurns: false };
  const lines = await forked(t, agent, LAST, "!fork");
  assert.ok(!lines.some((line) => line.includes("Last in the original")));
});

test("a turn the owner interrupted is marked stopped", async (t) => {
  const last: ForeignTurn = { prompt: "run it", reply: "Started", interrupted: true };
  const lines = await forked(t, new PlainAgent({ terminal: true }), last, "!fork");
  const shown = lines.find((line) => line.startsWith("Last in the original:"));
  assert.equal(shown, "Last in the original:\n\n> run it\n\nStarted\n\n(stopped)");
});

test("the copy is read, not the original", async (t) => {
  const agent = new PlainAgent({ terminal: true });
  const world = await MessagesWorld.make(t, { agent });
  const origin = await world.opened("the first task");
  const id = world.state.thread(origin.channel, origin.thread)?.sessionId;
  assert.ok(id);
  agent.lastTurn = async (_folder, session) =>
    session === id
      ? { prompt: "original moved on", reply: "later" }
      : { prompt: "as copied", reply: "then" };
  await world.says("!fork", origin.thread);
  await world.settle();
  const other = world.state.threads().find(([, thread]) => thread !== origin.thread);
  assert.ok(other);
  const lines = world.shown({ channel: other[0], thread: other[1] });
  assert.ok(
    lines.some((line) => line.includes("> as copied")),
    JSON.stringify(lines),
  );
});
