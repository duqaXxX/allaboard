/**
 * `ReplySink.tell` (#88): the owner told of the work's end by an edit of the reply's last message
 * that adds his mention to its `text` alone, the same blocks written again. The ways it could be
 * lost: an end that failed for good, and an update Slack refuses.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { UpdateLimiter } from "../../../../src/chat/slack/reply/limiter.ts";
import { ReplySink } from "../../../../src/chat/slack/reply/sinks.ts";
import {
  BOT,
  CHANNEL,
  FakeClock,
  FakeSlack,
  OWNER,
  rejected,
  TEAM,
  THREAD,
} from "../../../support/fake-slack.ts";
import { PLAIN_PREVIEWS } from "../../../support/plain-tools.ts";

class Paced {
  now = 0;
  async sleep(seconds: number): Promise<void> {
    this.now += seconds || 1e-9;
  }
  time(): number {
    return this.now;
  }
}

const tick = () => new Promise((done) => setImmediate(done));
const QUIET = { debug() {}, info() {}, warning() {}, error() {} } as never;

function made(slack: FakeSlack, clock: FakeClock): ReplySink {
  return new ReplySink(slack, {
    channel: CHANNEL,
    threadTs: THREAD,
    teamId: TEAM,
    userId: OWNER,
    botUserId: BOT,
    limiter: new UpdateLimiter({ clock: new Paced() }),
    previews: PLAIN_PREVIEWS,
    clock,
    debounceSeconds: 0,
    finalRetrySeconds: 1,
    logger: QUIET,
  });
}

/** The writes whose `text` mentions the owner. */
const mentions = (slack: FakeSlack) =>
  slack.apiCalls.filter((call) => String(call.args.text ?? "").includes(`<@${OWNER}>`));

async function written(sink: ReplySink, clock: FakeClock): Promise<void> {
  await sink.text("Hello.");
  for (let i = 0; i < 5; i += 1) {
    await clock.advance(0);
    await tick();
  }
  await sink.finish([]);
}

test("a reply whose end failed for good tells nothing, so the thread tells on its own", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = made(slack, clock);
  await written(sink, clock);
  slack.responses["chat.stopStream"] = [rejected("internal_error"), rejected("internal_error")];
  const closed = sink.closeOut();
  for (let i = 0; i < 20; i += 1) {
    await clock.advance(2);
    await tick();
  }
  await closed;
  assert.equal(await sink.waitLanded(), false);
  delete slack.responses["chat.stopStream"];
  assert.equal(await sink.tell(OWNER), false);
  for (let i = 0; i < 20; i += 1) {
    await clock.advance(2);
    await tick();
  }
  assert.deepEqual(mentions(slack), []);
});

test("a told update Slack refuses is not tried again for the mention", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = made(slack, clock);
  await written(sink, clock);
  assert.equal(await sink.closeOut(), true);
  slack.responses["chat.update"] = () => rejected("invalid_blocks");
  assert.equal(await sink.tell(OWNER), true);
  assert.equal(mentions(slack).length, 1); // the one try
  delete slack.responses["chat.update"];
  await sink.showFooterFormatted("main · ctx 6%");
  assert.equal(mentions(slack).length, 1); // the footer's edit writes the words alone
});

test("a reply that landed is told at once, with the blocks it shows", async () => {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sink = made(slack, clock);
  await written(sink, clock);
  assert.equal(await sink.closeOut(), true);
  assert.equal(await sink.tell(OWNER), true);
  const [told, ...more] = mentions(slack);
  assert.deepEqual(more, []);
  assert.equal(told?.method, "chat.update");
  assert.ok(
    JSON.stringify(told?.args.blocks).includes("Hello."),
    "the same blocks, never text alone",
  );
});
