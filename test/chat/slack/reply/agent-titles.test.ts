import assert from "node:assert/strict";
import { test } from "node:test";
import { SESSION_RETRY_SECONDS } from "../../../../src/chat/slack/reply/agent-session.ts";
import { AgentTitles, TITLE_LIMIT } from "../../../../src/chat/slack/reply/agent-titles.ts";
import type { Logger } from "../../../../src/log.ts";
import {
  AsyncEvent,
  CHANNEL,
  FakeClock,
  FakeSlack,
  networkDown,
  rejected,
  THREAD,
} from "../../../support/fake-slack.ts";

const REF = { channel: CHANNEL, thread: THREAD };

class Lines implements Logger {
  readonly warnings: string[] = [];
  debug = () => {};
  info = () => {};
  warning = (message: string) => void this.warnings.push(message);
  error = () => {};
}

function setup() {
  const slack = new FakeSlack();
  slack.responses["conversations.info"] = { ok: true, channel: { id: CHANNEL, name: "demo" } };
  const clock = new FakeClock();
  const log = new Lines();
  const titles = new AgentTitles(slack, { clock, logger: log });
  return { slack, clock, titles, log };
}

// Lets the senders run to their end, then closes.
async function settled(clock: FakeClock, titles: AgentTitles): Promise<void> {
  await clock.advance(0);
  await titles.close();
}

const renamed = (slack: FakeSlack) => slack.callsTo("agents.sessions.rename").map((c) => c.title);

test("no rename before a setStatus made the session", async () => {
  const { slack, clock, titles } = setup();
  titles.title(REF, "Fix the footer");
  await clock.advance(0);
  await settled(clock, titles);
  assert.deepEqual(slack.callsTo("agents.sessions.rename"), []);
  assert.deepEqual(slack.callsTo("conversations.replies"), []);
});

test("the title is the channel, a hyphen and the root's uncut first line", async () => {
  const { slack, clock, titles } = setup();
  const long = "Explain why the reply footer shows the model name twice in a row";
  titles.title(REF, `${long}\nsecond line`);
  titles.exists(REF);
  await settled(clock, titles);
  assert.deepEqual(slack.callsTo("agents.sessions.rename"), [
    { channel_id: CHANNEL, thread_ts: THREAD, title: `demo - ${long}` },
  ]);
  assert.equal(slack.callsTo("conversations.replies").length, 0);
});

test("without a title the root is read once, and its words name the session", async () => {
  const { slack, clock, titles } = setup();
  slack.responses["conversations.replies"] = {
    ok: true,
    messages: [{ ts: THREAD, text: "Look at the build\nplease" }],
  };
  titles.exists(REF);
  titles.exists(REF);
  await settled(clock, titles);
  assert.equal(slack.callsTo("conversations.replies").length, 1);
  assert.deepEqual(renamed(slack), ["demo - Look at the build"]);
});

test("a title written while the root is read wins over the read", async () => {
  const { slack, clock, titles } = setup();
  slack.responses["conversations.replies"] = {
    ok: true,
    messages: [{ ts: THREAD, text: "old words" }],
  };
  slack.gate = new AsyncEvent();
  slack.gateMethod = "conversations.replies";
  titles.exists(REF);
  await slack.gated.wait();
  titles.title(REF, "new words");
  slack.gate.set();
  await settled(clock, titles);
  assert.deepEqual(renamed(slack), ["demo - new words"]);
});

test("a title written while a rename is out is the one Slack ends with", async () => {
  const { slack, clock, titles } = setup();
  titles.title(REF, "first");
  slack.gate = new AsyncEvent();
  slack.gateMethod = "agents.sessions.rename";
  titles.exists(REF);
  await slack.gated.wait();
  titles.title(REF, "second");
  titles.title(REF, "third");
  slack.gate.set();
  await settled(clock, titles);
  assert.deepEqual(renamed(slack), ["demo - first", "demo - third"]);
});

test("the title Slack already has is not sent again", async () => {
  const { slack, clock, titles } = setup();
  titles.title(REF, "same");
  titles.exists(REF);
  titles.title(REF, "same");
  titles.exists(REF);
  await settled(clock, titles);
  assert.deepEqual(renamed(slack), ["demo - same"]);
});

test("session_not_found resets the session; the next setStatus renames with no new read", async () => {
  const { slack, clock, titles } = setup();
  slack.responses["agents.sessions.rename"] = [rejected("session_not_found"), { ok: true }];
  titles.title(REF, "again");
  titles.exists(REF);
  await clock.advance(0);
  assert.equal(renamed(slack).length, 1);
  await clock.advance(1000);
  assert.equal(renamed(slack).length, 1); // nothing retries on a timer
  titles.exists(REF);
  await settled(clock, titles);
  assert.deepEqual(renamed(slack), ["demo - again", "demo - again"]);
  assert.equal(slack.callsTo("conversations.replies").length, 0);
});

test("a title Slack refused is not sent again, nor on the next setStatus; a new one is", async () => {
  const { slack, clock, titles, log } = setup();
  slack.responses["agents.sessions.rename"] = [rejected("invalid_arguments"), { ok: true }];
  titles.title(REF, "bad");
  titles.exists(REF);
  await clock.advance(0);
  titles.exists(REF);
  await clock.advance(1000);
  assert.deepEqual(renamed(slack), ["demo - bad"]);
  assert.equal(log.warnings.length, 1);
  titles.title(REF, "good");
  await settled(clock, titles);
  assert.deepEqual(renamed(slack), ["demo - bad", "demo - good"]);
});

test("a refusal of the token stops the renames for the process", async () => {
  const { slack, clock, titles, log } = setup();
  slack.responses["agents.sessions.rename"] = rejected("missing_scope");
  titles.title(REF, "one");
  titles.exists(REF);
  await clock.advance(0);
  titles.title(REF, "two");
  await clock.advance(1000);
  await settled(clock, titles);
  assert.deepEqual(renamed(slack), ["demo - one"]);
  assert.equal(log.warnings.length, 1);
});

test("a failed rename is tried again after the backoff, with the latest title only", async () => {
  const { slack, clock, titles } = setup();
  slack.responses["agents.sessions.rename"] = [networkDown(), { ok: true }];
  titles.title(REF, "first");
  titles.exists(REF);
  await clock.advance(0);
  assert.deepEqual(renamed(slack), ["demo - first"]);
  titles.title(REF, "second"); // an input sends at once, without waiting for the timer
  await clock.advance(0);
  assert.deepEqual(renamed(slack), ["demo - first", "demo - second"]);
  await clock.advance(SESSION_RETRY_SECONDS[0] as number);
  assert.deepEqual(renamed(slack), ["demo - first", "demo - second"]);
  await settled(clock, titles);
});

test("the retry timer sends the latest title when nothing else moved", async () => {
  const { slack, clock, titles } = setup();
  slack.responses["agents.sessions.rename"] = [networkDown(), { ok: true }];
  titles.title(REF, "only");
  titles.exists(REF);
  await clock.advance(0);
  await clock.advance(SESSION_RETRY_SECONDS[0] as number);
  assert.deepEqual(renamed(slack), ["demo - only", "demo - only"]);
  await settled(clock, titles);
});

test("a thread whose root is gone is dropped and nothing is retried", async () => {
  const { slack, clock, titles } = setup();
  slack.responses["agents.sessions.rename"] = rejected("thread_not_found");
  titles.title(REF, "x");
  titles.exists(REF);
  await clock.advance(0);
  await clock.advance(1000);
  await settled(clock, titles);
  assert.deepEqual(renamed(slack), ["demo - x"]);
});

test("close waits for the call in flight and starts none after", async () => {
  const { slack, titles } = setup();
  titles.title(REF, "late");
  slack.gate = new AsyncEvent();
  slack.gateMethod = "agents.sessions.rename";
  titles.exists(REF);
  await slack.gated.wait();
  let closed = false;
  const closing = titles.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  titles.title(REF, "after");
  slack.gate.set();
  await closing;
  assert.deepEqual(renamed(slack), ["demo - late"]);
});

test("a title past 80 units is cut with an ellipsis and never inside a surrogate pair", async () => {
  const { slack, clock, titles } = setup();
  assert.equal(TITLE_LIMIT, 80);
  titles.title(REF, `${"a".repeat(60)}${"😀".repeat(20)}`);
  titles.exists(REF);
  await settled(clock, titles);
  const title = renamed(slack)[0] as string;
  assert.ok(title.length <= TITLE_LIMIT);
  assert.ok(title.endsWith("…"));
  assert.ok(!/[\ud800-\udbff]…$/.test(title));
  assert.ok(!/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(title));
});

// Measured 2026-11-09: rename refuses these characters with invalid_name on a thread session.
test("each character rename refuses becomes a space, and spaces collapse", async () => {
  const { slack, clock, titles } = setup();
  titles.title(REF, "Issue #240, a/b: fix [x] {y} @z *w* +1 50% $v <t> \\u `c` ~a ^b ;c");
  titles.exists(REF);
  await settled(clock, titles);
  assert.deepEqual(renamed(slack), ["demo - Issue 240, a b fix x y z w 1 50 v t u c a b c"]);
});

test("the channel's name is asked once per channel", async () => {
  const { slack, clock, titles } = setup();
  titles.title(REF, "a");
  titles.exists(REF);
  const other = { channel: CHANNEL, thread: "1780000000.000009" };
  titles.title(other, "b");
  titles.exists(other);
  await settled(clock, titles);
  assert.equal(slack.callsTo("conversations.info").length, 1);
  assert.equal(renamed(slack).length, 2);
});

test("a root the read returns as a tombstone is gone: no rename, the record dropped", async () => {
  const { slack, clock, titles } = setup();
  slack.responses["conversations.replies"] = {
    ok: true,
    messages: [{ ts: THREAD, subtype: "tombstone", text: "This message was deleted." }],
  };
  titles.exists(REF);
  await clock.advance(0);
  await clock.advance(1000);
  await settled(clock, titles);
  assert.deepEqual(renamed(slack), []);
  assert.equal(slack.callsTo("conversations.replies").length, 1);
});

test("a root the read does not return is gone, not retried", async () => {
  const { slack, clock, titles, log } = setup();
  slack.responses["conversations.replies"] = { ok: true, messages: [] };
  titles.exists(REF);
  await clock.advance(0);
  await clock.advance(1000);
  await settled(clock, titles);
  assert.equal(slack.callsTo("conversations.replies").length, 1);
  assert.deepEqual(log.warnings, []);
});

test("a setStatus success during a rename answered session_not_found keeps exists", async () => {
  const { slack, clock, titles } = setup();
  slack.responses["agents.sessions.rename"] = [rejected("session_not_found"), { ok: true }];
  titles.title(REF, "t");
  slack.gate = new AsyncEvent();
  slack.gateMethod = "agents.sessions.rename";
  titles.exists(REF);
  await slack.gated.wait();
  titles.exists(REF); // the session was made again while the call was out
  slack.gate.set();
  await settled(clock, titles);
  assert.deepEqual(renamed(slack), ["demo - t", "demo - t"]);
});

test("a refusal of the token on a read is logged as the read's method", async () => {
  const { slack, clock, titles, log } = setup();
  slack.responses["conversations.replies"] = rejected("missing_scope");
  titles.exists(REF);
  await settled(clock, titles);
  assert.equal(log.warnings.length, 1);
  assert.ok(log.warnings[0]?.includes("conversations.replies"));
  assert.ok(!log.warnings[0]?.includes("agents.sessions.rename"));
  titles.title(REF, "x");
  titles.exists(REF);
  await clock.advance(0);
  assert.deepEqual(renamed(slack), []); // titles stop for the process
});

test("a read answered invalid_arguments is retried after the backoff", async () => {
  const { slack, clock, titles } = setup();
  slack.responses["conversations.replies"] = [
    rejected("invalid_arguments"),
    { ok: true, messages: [{ ts: THREAD, text: "w" }] },
  ];
  titles.exists(REF);
  await clock.advance(0);
  titles.exists(REF);
  await clock.advance(0);
  assert.equal(slack.callsTo("conversations.replies").length, 2); // an input sends at once...
  const { slack: s2, clock: c2, titles: t2 } = setup();
  s2.responses["conversations.replies"] = [
    rejected("invalid_arguments"),
    { ok: true, messages: [{ ts: THREAD, text: "w" }] },
  ];
  t2.exists(REF);
  await c2.advance(0);
  await c2.advance((SESSION_RETRY_SECONDS[0] as number) - 1);
  assert.equal(s2.callsTo("conversations.replies").length, 1, "not before the first step");
  await c2.advance(1);
  assert.deepEqual(
    s2.callsTo("agents.sessions.rename").map((c) => c.title),
    ["demo - w"],
  );
  await settled(clock, titles);
  await t2.close();
});

test("halt stops a sender that a late setStatus success would start", async () => {
  const { slack, clock, titles } = setup();
  titles.title(REF, "late");
  titles.halt();
  titles.exists(REF);
  await clock.advance(0);
  await titles.close();
  assert.deepEqual(slack.callsTo("agents.sessions.rename"), []);
});

test("a title written just after a rename answers is not lost, at any microtask distance", async () => {
  for (let turns = 0; turns <= 8; turns += 1) {
    const { slack, clock, titles } = setup();
    const rename = slack.agents.sessions.rename.bind(slack.agents.sessions);
    slack.agents.sessions.rename = async (options) => {
      const answer = await rename(options);
      if (renamed(slack).length === 1) {
        let wait = Promise.resolve();
        for (let i = 0; i < turns; i += 1) wait = wait.then(() => {});
        void wait.then(() => titles.title(REF, "second"));
      }
      return answer;
    };
    titles.title(REF, "first");
    titles.exists(REF);
    await settled(clock, titles);
    assert.deepEqual(renamed(slack), ["demo - first", "demo - second"], `after ${turns} turns`);
  }
});
