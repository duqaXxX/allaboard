/**
 * A terminal wrote in the session while background work runs here (#101): the process that
 * runs the work never sees what the terminal wrote, so the owner is asked before it is stopped.
 * `writtenBesideWork` names the work without touching the record's place; `stopForTerminal`
 * ends it with the process, so the next message resumes the record.
 */
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { ForeignTurns } from "../../../src/agent/seam.ts";
import { Status } from "../../../src/chat/slack/reply/status.ts";
import { type Harness, harnessFor } from "../../support/sessions.ts";
import { splitBackground } from "./helpers.ts";

const WRITTEN: ForeignTurns = {
  changed: true,
  turns: [{ prompt: "typed there", reply: "done there" }],
  last: { id: "m9", at: 9 },
};

/** A harness whose agent reads what a terminal wrote as `written`, the reads counted. */
function withTerminal(t: TestContext, written: ForeignTurns): { h: Harness; reads: string[] } {
  const [first] = splitBackground();
  const h = harnessFor(t)({ turns: [first] });
  h.backend.capabilities = { ...h.backend.capabilities, foreignTurns: true };
  const reads: string[] = [];
  Object.assign(h.backend, {
    turnsAfter: async (_folder: string, session: string, after: { id: string }) => {
      reads.push(`${session} ${after.id}`);
      return written;
    },
  });
  return { h, reads };
}

test("background work beside what a terminal wrote is named, and nothing is taken", async (t) => {
  const { h } = withTerminal(t, WRITTEN);
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  session.saved = { id: "m1", at: 1 };
  assert.equal(await session.writtenBesideWork(), "1 shell");
  // the record's place is kept, and the process lives on
  assert.deepEqual(session.saved, { id: "m1", at: 1 });
  assert.equal(h.clients[0]?.connected, true);
});

test("nothing is named with no background work, or when the terminal wrote nothing", async (t) => {
  const quiet = withTerminal(t, { changed: false, turns: [], last: null });
  const session = quiet.h.session();
  await (await session.submit("start it")).done.wait();
  session.saved = { id: "m1", at: 1 };
  assert.equal(await session.writtenBesideWork(), "");

  // what has no typed prompt and no move before it is this process's own, saved late
  const late = withTerminal(t, {
    changed: true,
    turns: [{ prompt: null, reply: "my own late reply" }],
    last: { id: "m9", at: 9 },
  });
  const other = late.h.session();
  await (await other.submit("start it")).done.wait();
  other.saved = { id: "m1", at: 1 };
  assert.equal(await other.writtenBesideWork(), "");
});

test("stopping for the terminal ends the work with the process, then the turns are taken", async (t) => {
  const { h } = withTerminal(t, WRITTEN);
  const session = h.session();
  await (await session.submit("start it")).done.wait();
  session.saved = { id: "m1", at: 1 };
  await session.stopForTerminal();
  assert.equal(h.clients[0]?.connected, false, "the process is closed");
  assert.equal(h.clients[0]?.interrupts, 0);
  assert.equal(session.stillRunning, "");
  await h.until(() => h.reactions().at(-1) === Status.DONE);
  assert.equal(await session.writtenBesideWork(), "");
  assert.deepEqual(await session.takeForeignTurns(), WRITTEN.turns);
  assert.deepEqual(session.saved, { id: "m9", at: 9 });
});
