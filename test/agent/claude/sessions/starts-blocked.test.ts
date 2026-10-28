/**
 * No new agent process while an install replaces the copy: a session already
 * connected goes on, and every path that would start a process is refused with `StartsBlocked`.
 * The paths are `ThreadSession.ensureConnected` (the one call of the agent's `start`, reached by a
 * turn, a word, the setup and the reconnect for an effort) and the usage probe, which starts a
 * session of its own.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { StartsBlocked } from "../../../../src/core/sessions/errors.ts";
import * as texts from "../../../../src/core/texts.ts";
import { CHANNEL, THREAD } from "../../../support/fake-slack.ts";
import { harnessFor, sdkMessages } from "../../../support/sessions.ts";
import { inside } from "./helpers.ts";

const OTHER = "1780000000.000020";

test("a session already connected goes on while starts are blocked", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  const session = h.session();
  await session.ensureConnected();
  const unblock = h.manager.blockStarts();
  assert.equal(h.manager.startsBlocked, true);
  await (await session.submit("keep going")).done.wait();
  assert.equal(h.clients.length, 1, "no process was started");
  assert.deepEqual(h.clients[0]?.queries, ["keep going"]);
  unblock();
});

test("a session with no process starts none while starts are blocked", async (t) => {
  const h = harnessFor(t)({});
  h.state.openThread(CHANNEL, OTHER);
  const unblock = h.manager.blockStarts();
  const fresh = h.manager.get(CHANNEL, OTHER);
  assert.ok(fresh !== null);
  assert.equal(fresh.connected, false);
  await assert.rejects(fresh.ensureConnected(), StartsBlocked);
  assert.equal(h.clients.length, 0);
  unblock();
  await fresh.ensureConnected();
  assert.equal(h.clients.length, 1, "starts are allowed again once the block is lifted");
});

test("the refusal says what a draining daemon says", () => {
  assert.equal(new StartsBlocked().message, texts.RESTARTING);
});

test("a block applies to a session built after it was raised", async (t) => {
  const h = harnessFor(t)({});
  const unblock = h.manager.blockStarts();
  const fresh = h.session(THREAD);
  await assert.rejects(fresh.ensureConnected(), StartsBlocked);
  assert.equal(h.clients.length, 0);
  unblock();
});

test("a turn queued for a session with no process fails with the restart sentence", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  const session = h.session();
  const unblock = h.manager.blockStarts();
  const turn = await session.submit("start a process");
  await turn.done.wait();
  assert.equal(h.clients.length, 0);
  assert.ok(h.replies().some((reply) => reply.includes(texts.RESTARTING)));
  unblock();
});

test("the usage probe, which starts a session of its own, waits while starts are blocked", async (t) => {
  const h = harnessFor(t)({});
  const session = h.session();
  let refreshes = 0;
  t.mock.method(h.usage, "refreshIfStale", async () => {
    refreshes += 1;
  });
  const unblock = h.manager.blockStarts();
  inside(session).refreshUsage();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 0);
  unblock();
  inside(session).refreshUsage();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 1);
});

// ---- another process updates (critical review of 2026-10-17): another instance on the
// copy, or `allaboard update` in a terminal, holds the machine's update lock.

test("a session with no process starts none while another process updates, and starts after", async (t) => {
  const h = harnessFor(t)({});
  h.state.openThread(CHANNEL, OTHER);
  h.updatingElsewhere = true;
  const fresh = h.manager.get(CHANNEL, OTHER);
  assert.ok(fresh !== null);
  await assert.rejects(fresh.ensureConnected(), StartsBlocked);
  assert.equal(h.clients.length, 0);
  h.updatingElsewhere = false;
  await fresh.ensureConnected();
  assert.equal(h.clients.length, 1);
});

test("a start reads the thread's stored effort after the question about another update", async (t) => {
  const h = harnessFor(t)({});
  const session = h.session(); // opens the thread
  // The owner sets the level while the question is asked (the file calls of a probe take time).
  (h.deps as { updating: () => Promise<boolean> }).updating = async () => {
    h.state.setEffort(CHANNEL, THREAD, "high");
    return false;
  };
  await session.ensureConnected();
  assert.equal(h.clients[0]?.options.effort, "high");
});

test("a session already connected goes on while another process updates", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  const session = h.session();
  await session.ensureConnected();
  h.updatingElsewhere = true;
  await (await session.submit("keep going")).done.wait();
  assert.equal(h.clients.length, 1);
  assert.deepEqual(h.clients[0]?.queries, ["keep going"]);
});

test("a turn for a session with no process fails with the restart sentence while another process updates", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  const session = h.session();
  h.updatingElsewhere = true;
  await (await session.submit("start a process")).done.wait();
  assert.equal(h.clients.length, 0);
  assert.ok(h.replies().some((reply) => reply.includes(texts.RESTARTING)));
});

test("the usage probe waits while another process updates", async (t) => {
  const h = harnessFor(t)({});
  const session = h.session();
  let refreshes = 0;
  t.mock.method(h.usage, "refreshIfStale", async () => {
    refreshes += 1;
  });
  h.updatingElsewhere = true;
  inside(session).refreshUsage();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 0);
  h.updatingElsewhere = false;
  inside(session).refreshUsage();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 1);
});

test("the manager refuses a start for this daemon's block and for another process's update", async (t) => {
  const h = harnessFor(t)({});
  assert.equal(await h.manager.refusesStarts(), false);
  h.updatingElsewhere = true;
  assert.equal(await h.manager.refusesStarts(), true);
  h.updatingElsewhere = false;
  const unblock = h.manager.blockStarts();
  assert.equal(await h.manager.refusesStarts(), true);
  unblock();
  assert.equal(await h.manager.refusesStarts(), false);
});
