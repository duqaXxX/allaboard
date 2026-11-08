/**
 * The channel's line names a thread as `✋ Waiting:` when one of its requests is posted
 * (`SlackThread.nameWaiting`), before the core records the request in `state.json`. A request
 * resolved before the post returns (#239) leaves no write behind it: the line must not keep
 * naming a wait that no longer exists.
 */
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import * as texts from "../../../../src/core/texts.ts";
import { AsyncEvent, CHANNEL, OTHER_THREAD, THREAD } from "../../../support/fake-slack.ts";
import { lineWorld, message, reply, type World } from "../../../support/slack-app.ts";

/** Holds the first post whose text starts with `prefix` until the returned event is set. */
function holdPost(world: World, prefix: string): { posting: AsyncEvent; release: AsyncEvent } {
  const release = new AsyncEvent();
  world.slack.gated = new AsyncEvent();
  world.slack.gate = release;
  world.slack.gateMethod = "chat.postMessage";
  world.slack.gateWhen = (args) => {
    if (!String(args.text ?? "").startsWith(prefix)) return false;
    world.slack.gate = null; // only the first such post waits
    return true;
  };
  return { posting: world.slack.gated, release };
}

/** The text of the channel's line as Slack holds it last: its last post or edit. */
function lineText(world: World): string | null {
  const ours = world.slack.apiCalls.filter(
    (call) =>
      (call.method === "chat.postMessage" || call.method === "chat.update") &&
      String(call.args.text ?? "").startsWith("Status:"),
  );
  const last = ours.at(-1);
  return last === undefined ? null : String(last.args.text);
}

function worldOf(t: TestContext): World {
  const guard = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(guard));
  return lineWorld(t);
}

test("a hold stopped while its question is being posted leaves no waiting line", async (t) => {
  const world = worldOf(t);
  const prefix = texts.HOLD_QUESTION.split("{")[0] as string;
  const { posting, release } = holdPost(world, prefix);
  await world.dispatch(message("busy elsewhere", { ts: OTHER_THREAD }));
  const sending = world.dispatch(message("hello", { ts: THREAD }));
  await posting.wait();
  // The owner stops the thread while Slack has not yet answered the question's post.
  await world.dispatch(reply("!stop", THREAD));
  release.set();
  await sending;
  await world.settle();
  // Nothing waits: the request is gone and the root's status was never changed.
  const entry = world.state.thread(CHANNEL, THREAD);
  assert.deepEqual([entry?.status, entry?.requests], [null, []]);
  // The line was drawn (the wait was named), and its last text names no wait.
  const shown = lineText(world);
  assert.ok(shown !== null, "the line was posted");
  assert.ok(!shown.includes("Waiting"), shown);
});
