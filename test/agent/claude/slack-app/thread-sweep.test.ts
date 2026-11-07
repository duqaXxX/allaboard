/** `SlackChat.start` launches the periodic sweep of the uploads folder, and the stop ends it. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ChannelGuard } from "../../../../src/chat/slack/app/guards.ts";
import { KEEP_SECONDS, SWEEP_EVERY_SECONDS } from "../../../../src/chat/slack/attachments.ts";
import { SlackChat } from "../../../../src/chat/slack/thread.ts";
import { AGENT, FakeClock } from "../../../support/fake-slack.ts";
import { worldOf } from "../../../support/slack-app.ts";

/** Waits until `done` holds: the pass's file work runs off the event loop, with no signal to wait on. */
async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
}

test("start sweeps the uploads folder every 6 hours until the chat stops", async (t) => {
  const world = worldOf(t);
  const steady = new FakeClock();
  mkdirSync(world.uploads, { mode: 0o700, recursive: true });
  const old = join(world.uploads, "old.txt");
  writeFileSync(old, "x");
  const stamp = Date.now() / 1000 - KEEP_SECONDS - 60;
  await utimes(old, stamp, stamp);
  const chat = new SlackChat({
    slack: world.slack,
    replies: world.slack,
    identity: world.identity,
    agent: () => AGENT,
    limiter: world.limiter,
    clock: steady,
    steady,
    app: {
      core: () => world.core,
      config: world.config,
      guard: new ChannelGuard(world.slack, world.identity),
      home: world.home,
      uploads: world.uploads,
      receiver: { init: () => {}, start: async () => {}, stop: async () => {} },
      appKey: "key",
    },
  });
  await chat.start(world.inbound);
  await steady.advance(SWEEP_EVERY_SECONDS);
  await until(() => !existsSync(old));
  assert.ok(!existsSync(old));
  const later = join(world.uploads, "later.txt");
  writeFileSync(later, "x");
  await utimes(later, stamp, stamp);
  await chat.stop();
  await steady.advance(SWEEP_EVERY_SECONDS);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(later)); // no sweep after the stop
});
