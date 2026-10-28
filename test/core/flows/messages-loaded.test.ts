/**
 * `!memory` and `!skills` through the message flow: inside a thread, what the session loaded,
 * for the owner alone; in the channel, where they work; with an agent that does not list it, a
 * refusal and nothing sent to it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as texts from "../../../src/core/texts.ts";
import { named } from "../../../src/core/texts.ts";
import { PlainAgent } from "../../support/plain-agent.ts";
import { MessagesWorld, PLAIN_NAMES } from "./messages-world.ts";

const LOADED = {
  memoryFiles: [{ path: "/etc/claude/CLAUDE.md", tokens: 1200 }],
  skills: [{ name: "loop", source: "built-in", tokens: 86 }],
};

test("!memory and !skills inside a thread list what its session loaded", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new PlainAgent({ loaded: LOADED }) });
  const ref = await world.opened();
  await world.says("!memory", ref.thread);
  assert.equal(
    world.shown(ref).at(-1),
    "Memory files loaded (1, 1,200 tokens):\n• /etc/claude/CLAUDE.md · 1,200 tokens",
  );
  await world.says("!skills", ref.thread);
  assert.equal(world.shown(ref).at(-1), "Skills (1):\n• loop · built-in");
  assert.deepEqual(await world.prompts(), ["first"], "nothing reached the agent as a prompt");
});

test("in the channel the words say they work inside a thread", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new PlainAgent({ loaded: LOADED }) });
  await world.says("!skills");
  assert.equal(world.inChannel().at(-1), texts.LOADED_TOP_LEVEL);
});

test("an agent that does not list what a session loaded refuses both words", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  await world.says("!memory", ref.thread);
  const refusal = named(texts.LOADED_UNAVAILABLE, PLAIN_NAMES);
  assert.ok(world.shown(ref).includes(refusal), world.shown(ref).join("\n"));
  assert.deepEqual(await world.prompts(), ["first"]);
});

test("an agent that does not list what a session loaded is offered neither word by !help", async (t) => {
  const plain = await MessagesWorld.make(t);
  const ref = await plain.opened();
  await plain.says("!help", ref.thread);
  const help = plain.shown(ref).at(-1) ?? "";
  assert.ok(
    help.includes("`!status`") && !help.includes("`!memory`") && !help.includes("`!skills`"),
  );

  const listing = await MessagesWorld.make(t, { agent: new PlainAgent({ loaded: LOADED }) });
  const other = await listing.opened();
  await listing.says("!help", other.thread);
  const offered = listing.shown(other).at(-1) ?? "";
  assert.ok(offered.includes("`!memory`") && offered.includes("`!skills`"));
});
