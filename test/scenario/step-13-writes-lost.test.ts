/**
 * Step 13 of the scenario the memory chat carries: the agent reports, as its process exits, that
 * it could not save to disk. The plain agent's session returns the report from `close`; the thread
 * gets one notice, or none when the agent reported nothing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClosedReport } from "../../src/agent/seam.ts";
import { IDLE_CLOSE_SECONDS } from "../../src/core/sessions/constants.ts";
import { logger } from "../../src/core/sessions/session.ts";
import * as texts from "../../src/core/texts.ts";
import { fill } from "../../src/core/texts.ts";
import { say } from "../support/plain-agent.ts";
import { World } from "./world.ts";

/** The notice for a lost conversation, as the thread shows it. */
function conversation(world: World): string {
  const names = texts.namesOf(world.plain, world.chat.provider);
  return fill(texts.named(texts.UNSAVED_CONVERSATION, names), {
    cause: texts.UNSAVED_CAUSES.disk_full,
  });
}

/** A thread whose one turn ended, its session set to report `report` on its close. */
async function ended(world: World, report: ClosedReport): Promise<string> {
  await world.start();
  world.script(say("Done."));
  const thread = await world.open("work");
  await world.ended(thread);
  const session = world.plain.sessions.at(-1);
  assert.ok(session);
  session.report = report;
  return thread;
}

const notices = (world: World, thread: string): string[] =>
  world
    .kinds(thread)
    .filter(([kind, text]) => kind === "notice" && text.includes("could not save"))
    .map(([, text]) => text);

test("an idle close that reports unsaved conversation posts one notice and awaits the exit", async (t) => {
  const world = World.make(t);
  const thread = await ended(world, {
    unsaved: { conversation: true, settings: false, cause: "disk_full" },
  });
  await world.clock.advance(IDLE_CLOSE_SECONDS);
  await world.until(() => world.plain.sessions.at(-1)?.closed === true, "the idle close");
  assert.deepEqual(world.plain.sessions.at(-1)?.closeCalls, [{ awaitExit: true }]);
  assert.deepEqual(notices(world, thread), [conversation(world)]);
  await world.finish();
});

test("unsaved settings alone post the other text, a quota its own cause", async (t) => {
  const world = World.make(t);
  const thread = await ended(world, {
    unsaved: { conversation: false, settings: true, cause: "quota" },
  });
  await world.clock.advance(IDLE_CLOSE_SECONDS);
  await world.until(() => notices(world, thread).length === 1, "the notice");
  assert.match(
    notices(world, thread)[0] ?? "",
    /could not save its own settings to disk \(the disk quota is used up\)\. Changes made in this session may be lost\.$/,
  );
  await world.finish();
});

test("a close that reports nothing posts nothing", async (t) => {
  const world = World.make(t);
  const thread = await ended(world, { unsaved: null });
  await world.clock.advance(IDLE_CLOSE_SECONDS);
  await world.until(() => world.plain.sessions.at(-1)?.closed === true, "the idle close");
  await world.settle();
  assert.deepEqual(notices(world, thread), []);
  await world.finish();
});

test("a notice that cannot be posted does not fail the close", async (t) => {
  const world = World.make(t);
  const thread = await ended(world, {
    unsaved: { conversation: true, settings: false, cause: "other" },
  });
  const warned = t.mock.method(logger, "warning", () => undefined);
  const chat = world.chat.provider.thread({ channel: world.channel, thread });
  t.mock.method(Object.getPrototypeOf(chat), "notice", async () => {
    throw new Error("the chat refused");
  });
  await world.clock.advance(IDLE_CLOSE_SECONDS);
  await world.until(() => world.plain.sessions.at(-1)?.closed === true, "the idle close");
  await world.settle();
  assert.deepEqual(notices(world, thread), []);
  assert.equal(warned.mock.callCount(), 1);
  await world.finish();
});

test("a process lost on its own posts the report its close returns", async (t) => {
  const world = World.make(t);
  const thread = await ended(world, {
    unsaved: { conversation: true, settings: false, cause: "disk_full" },
  });
  world.plain.sessions.at(-1)?.kill();
  await world.until(() => notices(world, thread).includes(conversation(world)), "the notice");
  await world.finish();
});

test("a shutdown closes without waiting for the exit", async (t) => {
  const world = World.make(t);
  await ended(world, { unsaved: null });
  await world.stop("SIGINT");
  assert.deepEqual(world.plain.sessions.at(-1)?.closeCalls, [{ awaitExit: false }]);
  await world.finish();
});

test("conversation and settings lost together post the conversation text and one sentence", async (t) => {
  const world = World.make(t);
  const thread = await ended(world, {
    unsaved: { conversation: true, settings: true, cause: "disk_full" },
  });
  await world.clock.advance(IDLE_CLOSE_SECONDS);
  await world.until(() => notices(world, thread).length === 1, "the notice");
  assert.deepEqual(notices(world, thread), [
    `${conversation(world)} ${texts.UNSAVED_SETTINGS_TOO}`,
  ]);
  await world.finish();
});
