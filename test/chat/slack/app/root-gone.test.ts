/**
 * A first message the owner deletes by hand: the thread is forgotten at once. The events are the
 * two shapes seen on 2026-10-20 (a tombstone `message_changed`, and `message_deleted`); the
 * checks are the provider's own, since neither names who deleted. Anything but a thread the
 * daemon keeps, in the owner's workspace, changes nothing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThreadRef } from "../../../../src/chat/seam.ts";
import { deletedTs } from "../../../../src/chat/slack/app/guards.ts";
import { CHANNEL, THREAD } from "../../../support/fake-slack.ts";
import {
  type Body,
  deletedRoot,
  message,
  recorded,
  tombstoned,
  worldOf,
} from "../../../support/slack-app.ts";

const OTHER_TEAM = "T000OTHER";
const SHAPES: ReadonlyArray<
  readonly [string, (channel: string, ts: string, author?: string) => Body]
> = [
  ["a tombstone", tombstoned],
  ["a message_deleted", deletedRoot],
];

/** A world that keeps the thread `THREAD`, titled, with its prompt stored, and a Home to refresh. */
function worldWithThread(t: Parameters<typeof worldOf>[0]) {
  const world = worldOf(t);
  world.state.openThread(CHANNEL, THREAD, "session-1");
  world.state.setRootPrompt(CHANNEL, THREAD, "the owner's words");
  const refreshed: ThreadRef[][] = [];
  Object.assign(world.chat, {
    index: { refresh: (changed?: Iterable<ThreadRef>) => refreshed.push([...(changed ?? [])]) },
  });
  return { world, refreshed };
}

for (const [name, build] of SHAPES) {
  test(`${name} of a root the daemon keeps forgets the thread`, async (t) => {
    const { world, refreshed } = worldWithThread(t);
    await world.dispatch(build(CHANNEL, THREAD));
    await world.settle();
    assert.equal(world.state.thread(CHANNEL, THREAD), null, "the entry and its prompt are gone");
    // The state's own change asks the index (`onSessionsChange`): the listener asks nothing more.
    assert.deepEqual(refreshed, []);
    assert.equal(world.sessions.held(CHANNEL, THREAD), false, "the hold ended");
    assert.deepEqual(world.slack.callsTo("chat.delete"), [], "the daemon's replies stay");
  });

  test(`${name} from another workspace changes nothing`, async (t) => {
    const { world, refreshed } = worldWithThread(t);
    const body = build(CHANNEL, THREAD);
    body.team_id = OTHER_TEAM;
    await world.dispatch(body);
    await world.settle();
    assert.equal(world.state.thread(CHANNEL, THREAD)?.rootPrompt, "the owner's words");
    assert.deepEqual(refreshed, []);
  });

  test(`${name} of a message that is no thread the daemon keeps changes nothing`, async (t) => {
    const { world, refreshed } = worldWithThread(t);
    await world.dispatch(build(CHANNEL, "1790999999.000001")); // a reply, or a stranger's message
    await world.dispatch(build("C000ELSE", THREAD)); // the same ts in a channel it does not keep
    await world.settle();
    assert.notEqual(world.state.thread(CHANNEL, THREAD), null);
    assert.deepEqual(refreshed, []);
  });

  test(`${name} of an event with no channel changes nothing`, async (t) => {
    const { world } = worldWithThread(t);
    const body = build(CHANNEL, THREAD);
    delete body.event.channel;
    await world.dispatch(body);
    await world.settle();
    assert.notEqual(world.state.thread(CHANNEL, THREAD), null);
  });
}

test("a root whose session is working stays for the cleanup, and the index reads its row", async (t) => {
  const { world, refreshed } = worldWithThread(t);
  t.mock.method(world.sessions, "hold", () => false);
  await world.dispatch(tombstoned(CHANNEL, THREAD));
  await world.settle();
  assert.notEqual(world.state.thread(CHANNEL, THREAD), null);
  assert.deepEqual(refreshed, [[{ channel: CHANNEL, thread: THREAD }]]);
  assert.equal(world.sessions.held(CHANNEL, THREAD), false, "no hold left behind");
});

test("a root the daemon edited itself (title or tag) is not a deletion", async (t) => {
  const { world, refreshed } = worldWithThread(t);
  // The recorded edit of a message, moved onto the root: no tombstone in it.
  const body = recorded("event_callback-message_changed");
  Object.assign(body.event.message, { ts: THREAD });
  Object.assign(body.event, { channel: CHANNEL });
  await world.dispatch(body);
  await world.settle();
  assert.equal(world.state.thread(CHANNEL, THREAD)?.rootPrompt, "the owner's words");
  assert.deepEqual(refreshed, []);
  assert.equal(deletedTs(body.event), null);
});

test("an edit or a deletion is still no prompt", async (t) => {
  const world = worldOf(t);
  world.state.openThread(CHANNEL, THREAD, "session-1");
  await world.dispatch(tombstoned(CHANNEL, THREAD));
  await world.dispatch(deletedRoot(CHANNEL, THREAD));
  await world.settle();
  assert.deepEqual(world.queries(), []);
});

test("deletedTs reads the two shapes and nothing else", () => {
  assert.equal(deletedTs(tombstoned(CHANNEL, THREAD).event), THREAD);
  assert.equal(deletedTs(deletedRoot(CHANNEL, THREAD).event), THREAD);
  assert.equal(deletedTs(message().event), null);
  assert.equal(deletedTs({ type: "message", subtype: "message_deleted" }), null, "no deleted_ts");
  assert.equal(deletedTs({ type: "message", subtype: "message_changed", message: "x" }), null);
});

test("a deletion after the daemon stopped changes nothing", async (t) => {
  const { world } = worldWithThread(t);
  world.chat.halt();
  await world.dispatch(tombstoned(CHANNEL, THREAD));
  await world.settle();
  assert.notEqual(world.state.thread(CHANNEL, THREAD), null);
});
