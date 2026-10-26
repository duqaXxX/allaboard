/**
 * The owner is told of the end of a session's work once, whichever way it ends: a change of the
 * root's status from working or waiting to done or error (`endsWork`), and never one his own act
 * made (`!stop`, a hold he cancelled). Seen here as the channel's line the Slack provider moves
 * for a `notify` status.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Status } from "../../../src/chat/slack/reply/status.ts";
import { APPROVE } from "../../../src/core/requests.ts";
import { CHANNEL, OWNER, THREAD } from "../../support/fake-slack.ts";
import {
  canUseToolCall,
  END_OF_STREAM,
  type Harness,
  harnessFor,
  isResult,
  sdkMessages,
} from "../../support/sessions.ts";
import { inside, pending, recordingLine } from "./helpers.ts";

function approve(h: Harness): void {
  const [approvalId] = pending(h.approvals);
  assert.ok(approvalId !== undefined);
  assert.notEqual(h.approvals.resolve(approvalId, CHANNEL, THREAD, APPROVE), null);
}

test("a prompt's work that ends tells the owner once, a later sweep or close does not", async (t) => {
  const { line, shown } = recordingLine();
  const h = harnessFor(t, { line, mentionOwner: true })({ turns: [sdkMessages("tools")] });
  const session = h.session();
  await (await session.submit("list the files")).done.wait();
  await h.until(() => h.reactions().at(-1) === Status.DONE);
  assert.deepEqual(shown, [[THREAD, "done"]]);
  // Done again, as a report's or a landed reply's own sweep asks for it: no second word.
  await (session as unknown as { reactDoneIfIdle(): Promise<void> }).reactDoneIfIdle();
  await session.close();
  await h.idle();
  assert.deepEqual(shown, [[THREAD, "done"]]);
  // Told in the thread, once: the mention in one write's `text` (#88).
  const told = [...h.slack.callsTo("chat.update"), ...h.slack.callsTo("chat.postMessage")].filter(
    (call) => String(call.text).includes(`<@${OWNER}>`),
  );
  assert.equal(told.length, 1);
});

test("each prompt's work tells the owner of its own end", async (t) => {
  const { line, shown } = recordingLine();
  const h = harnessFor(t, { line })({ turns: [sdkMessages("tools"), sdkMessages("tools")] });
  const session = h.session();
  await (await session.submit("one")).done.wait();
  await h.until(() => shown.length === 1);
  await (await session.submit("two")).done.wait();
  await h.until(() => shown.length === 2);
  // Without `mentionOwner` the line moves all the same.
  assert.deepEqual(shown, [
    [THREAD, "done"],
    [THREAD, "done"],
  ]);
});

test("an answered approval tells the owner of the work's end, not of the answer", async (t) => {
  const { line, shown } = recordingLine();
  const h = harnessFor(t, { line })({
    turns: [[canUseToolCall("Bash", { command: "ls" }), ...sdkMessages("tools")]],
  });
  const session = h.session();
  const turn = await session.submit("list the files");
  await h.until(() => pending(h.approvals).length > 0);
  assert.deepEqual(shown, [[THREAD, "waiting"]]); // the request's own line
  approve(h);
  await turn.done.wait();
  await h.until(() => shown.length === 2);
  assert.deepEqual(shown.at(-1), [THREAD, "done"]);
});

test("a failed turn tells the owner it failed", async (t) => {
  const { line, shown } = recordingLine();
  const h = harnessFor(t, { line })({});
  const session = h.session();
  await session.ensureConnected();
  const client = h.clients[0];
  assert.ok(client !== undefined);
  client.send = async () => {
    throw new Error("boom");
  };
  await (await session.submit("hi")).done.wait();
  await h.until(() => shown.length === 1);
  assert.deepEqual(shown, [[THREAD, "failed"]]);
});

test("!stop tells the owner nothing: he has just given it", async (t) => {
  const { line, shown } = recordingLine();
  const turn = [canUseToolCall("Bash", { command: "rm -rf build" }), ...sdkMessages("interrupt")];
  const h = harnessFor(t, { line })({ turns: [turn] });
  const session = h.session();
  const submitted = await session.submit("clean");
  await h.until(() => pending(h.approvals).length === 1);
  assert.equal(await session.stop(), true);
  await submitted.done.wait();
  await h.idle();
  assert.equal(h.reactions().at(-1), Status.DONE);
  assert.deepEqual(shown, [[THREAD, "waiting"]]); // the approval's line alone
});

test("a hold the owner cancels restores the status he was told of, telling him nothing", async (t) => {
  const { line, shown } = recordingLine();
  // The CLI process is gone in the middle of the turn: ❌, told once.
  const h = harnessFor(t, { line })({
    turns: [[...sdkMessages("tools").slice(0, 21), END_OF_STREAM]],
  });
  const session = h.session();
  await (await session.submit("go")).done.wait();
  await h.until(() => inside(session).client === null);
  await h.until(() => h.reactions().at(-1) === Status.ERROR);
  await h.idle();
  assert.deepEqual(shown, [[THREAD, "failed"]]);
  session.holdStart();
  await h.idle();
  await session.holdEnd({ continued: false });
  await h.until(() => h.reactions().at(-1) === Status.ERROR);
  await h.idle();
  assert.deepEqual(shown, [[THREAD, "failed"]]);
});

// The stop of work left running in the background closes the agent's process, whose tasks end
// with it: that end is the owner's stop too (seen live on 2026-10-25, a `✅ Done:` push after
// `!stop`).
for (const recording of ["session-state-agent", "session-state-shell"]) {
  test(`!stop of work left in the background tells the owner nothing [${recording}]`, async (t) => {
    const { line, shown } = recordingLine();
    const items = sdkMessages(recording);
    const first = items.findIndex(isResult);
    const h = harnessFor(t, { line })({ turns: [items.slice(0, first + 1)] });
    const session = h.session();
    await (await session.submit("launch it")).done.wait();
    await h.idle();
    assert.equal(h.reactions().at(-1), Status.WORKING); // the task still runs
    assert.equal(await session.stop(), true);
    await h.until(() => session.idle);
    await h.idle();
    assert.equal(h.reactions().at(-1), Status.DONE);
    assert.deepEqual(shown, []);
  });
}
