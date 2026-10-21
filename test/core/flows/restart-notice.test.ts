/**
 * The message a restart asked from the chat leaves (`restart_notice` of `state.json`), rewritten
 * by the next start once the chat is connected (`rewriteRestartNotice`): the three texts, the key
 * forgotten whatever the outcome, and what a start with no key does.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatProvider } from "../../../src/chat/seam.ts";
import { logger, rewriteRestartNotice } from "../../../src/core/flows/notices.ts";
import * as texts from "../../../src/core/texts.ts";
import { fill } from "../../../src/core/texts.ts";
import { MessagesWorld } from "./messages-world.ts";

const RUNNING = "0.3.1";

/** `HH:MM` of `seconds` on this machine's clock, derived here and not by the code under test. */
function clock(seconds: number): string {
  return new Date(seconds * 1000).toTimeString().slice(0, 5);
}

/** The channel holds the line a restart posted, and the state names it; returns its id. */
async function restarting(
  world: MessagesWorld,
  version: string | null,
  line = texts.UPDATE_RESTART,
) {
  const message = await world.chat.provider.channel(world.channel).notice(line);
  assert.ok(message !== null);
  world.state.setRestartNotice({ channel: world.channel, message, version });
  return message;
}

/** What `run` does: takes the notice the file holds, then rewrites it. */
function rewritten(world: MessagesWorld, chat: ChatProvider = world.provider): Promise<void> {
  return rewriteRestartNotice(chat, world.state, world.state.restartNotice, RUNNING, world.now);
}

function shownOf(world: MessagesWorld, message: string) {
  return world.chat.messages(world.channel).find((m) => m.id === message);
}

test("after a restart the line says when the daemon came back", async (t) => {
  const world = await MessagesWorld.make(t);
  const message = await restarting(world, null);
  await rewritten(world);
  assert.equal(shownOf(world, message)?.text, `allaboard restarted at ${clock(world.now)}.`);
  assert.equal(shownOf(world, message)?.kind, "notice");
  assert.equal(world.inChannel().length, 1, "rewritten in place, nothing added");
  assert.equal(world.state.restartNotice, null, "forgotten");
});

test("after an update to the version asked the line says so", async (t) => {
  const world = await MessagesWorld.make(t);
  const message = await restarting(
    world,
    RUNNING,
    "Installed allaboard 0.3.1. Restarting once running turns finish.",
  );
  await rewritten(world);
  assert.equal(shownOf(world, message)?.text, "Updated to allaboard 0.3.1.");
  assert.equal(world.state.restartNotice, null);
});

test("after an update that left another version the line says the update did not take", async (t) => {
  const world = await MessagesWorld.make(t);
  const message = await restarting(world, "0.3.2");
  await rewritten(world);
  assert.equal(
    shownOf(world, message)?.text,
    "allaboard restarted on 0.3.1, not on 0.3.2: the update did not take.",
  );
  assert.equal(
    shownOf(world, message)?.text,
    fill(texts.UPDATE_NOT_TAKEN, { installed: RUNNING, asked: "0.3.2" }),
  );
  assert.equal(world.state.restartNotice, null);
});

test("a start with no key rewrites nothing", async (t) => {
  const world = await MessagesWorld.make(t);
  await world.chat.provider.channel(world.channel).notice("untouched");
  await rewritten(world);
  assert.deepEqual(world.inChannel(), ["untouched"]);
});

test("the key is forgotten when the message was deleted, and the error's name is logged", async (t) => {
  const world = await MessagesWorld.make(t);
  const message = await restarting(world, null);
  assert.equal(await world.provider.channel(world.channel).withdraw(message), true);
  const warnings: string[] = [];
  t.mock.method(logger, "warning", (line: string) => warnings.push(line));
  await rewritten(world);
  assert.equal(world.state.restartNotice, null);
  assert.deepEqual(warnings, [
    `could not rewrite the restart notice in ${world.channel}: message_not_found`,
  ]);
  assert.deepEqual(world.inChannel(), [], "nothing is posted in its place");
});

test("the key is forgotten when the chat refuses, and the refusal's words are not logged", async (t) => {
  const world = await MessagesWorld.make(t);
  await restarting(world, "0.3.2");
  const refusing = {
    channel: () => ({
      rewrite: async () => {
        throw new Error("private words");
      },
    }),
  } as unknown as ChatProvider;
  const warnings: string[] = [];
  t.mock.method(logger, "warning", (line: string) => warnings.push(line));
  await rewritten(world, refusing);
  assert.equal(world.state.restartNotice, null);
  assert.deepEqual(warnings, [`could not rewrite the restart notice in ${world.channel}: Error`]);
});

test("a state that cannot forget the key is logged and does not stop the start", async (t) => {
  const world = await MessagesWorld.make(t);
  await restarting(world, null);
  t.mock.method(world.state, "clearRestartNotice", () => {
    throw new Error("disk full");
  });
  const warnings: string[] = [];
  t.mock.method(logger, "warning", (line: string) => warnings.push(line));
  await rewritten(world);
  assert.deepEqual(warnings, ["could not forget the restart notice: Error"]);
});

test("a restart asked while the rewrite is in flight keeps its own record", async (t) => {
  const world = await MessagesWorld.make(t);
  const first = await restarting(world, null);
  const taken = world.state.restartNotice;
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = {
    channel: () => ({
      rewrite: async () => {
        await held;
      },
    }),
  } as unknown as ChatProvider;
  const rewriting = rewriteRestartNotice(slow, world.state, taken, RUNNING, world.now);
  // The owner types `!allaboard restart` meanwhile: its line is posted and recorded.
  const second = await restarting(world, null);
  release();
  await rewriting;
  assert.notEqual(second, first);
  assert.deepEqual(
    world.state.restartNotice,
    { channel: world.channel, message: second, version: null },
    "the new record is not the one the start forgets",
  );
});

test("a record written after the start took its notice is not rewritten", async (t) => {
  const world = await MessagesWorld.make(t);
  const taken = world.state.restartNotice; // nothing recorded yet: the start takes none
  const message = await restarting(world, null); // `!allaboard restart`, typed as the chat connects
  await rewriteRestartNotice(world.provider, world.state, taken, RUNNING, world.now);
  assert.equal(shownOf(world, message)?.text, texts.UPDATE_RESTART, "still says what it says");
  assert.deepEqual(world.state.restartNotice, {
    channel: world.channel,
    message,
    version: null,
  });
});
