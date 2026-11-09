import assert from "node:assert/strict";
import { test } from "node:test";
import type { RootStatus } from "../../../../src/chat/seam.ts";
import {
  AgentSessions,
  SESSION_REFRESH_SECONDS,
  SESSION_RETRY_SECONDS,
  wantedStatus,
} from "../../../../src/chat/slack/reply/agent-session.ts";
import type { Logger } from "../../../../src/log.ts";
import {
  AsyncEvent,
  CHANNEL,
  FakeClock,
  FakeSlack,
  httpError,
  networkDown,
  OWNER,
  rateLimited,
  rejected,
  THREAD,
} from "../../../support/fake-slack.ts";
import { madeChat } from "../../../support/slack-chat.ts";

const REF = { channel: CHANNEL, thread: THREAD };

class Lines implements Logger {
  readonly warnings: string[] = [];
  debug = () => {};
  info = () => {};
  warning = (message: string) => void this.warnings.push(message);
  error = () => {};
}

function setup(log: Logger = new Lines()) {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const sessions = new AgentSessions(slack, { clock, logger: log });
  return { slack, clock, sessions };
}

const sent = (slack: FakeSlack) =>
  slack.callsTo("agents.sessions.setStatus").map((call) => call.status);

test("the mapping: waiting suspends, work and activity process, the rest is active", () => {
  const table: Array<[RootStatus | null, boolean, string]> = [
    ["waiting", false, "suspended"],
    ["waiting", true, "suspended"],
    ["working", false, "processing"],
    ["restarting", false, "processing"],
    ["working", true, "processing"],
    ["done", true, "processing"],
    ["error", true, "processing"],
    [null, true, "processing"],
    ["done", false, "active"],
    ["error", false, "active"],
    [null, false, "active"],
  ];
  for (const [root, activity, expected] of table) {
    assert.equal(wantedStatus(root, activity), expected, `${root} ${activity}`);
  }
});

test("every wanted change is sent explicitly, with the thread's ids", async () => {
  const { slack, sessions } = setup();
  sessions.root(REF, "working");
  await sessions.close();
  sessions.root(REF, "waiting");
  assert.deepEqual(slack.callsTo("agents.sessions.setStatus"), [
    { channel_id: CHANNEL, thread_ts: THREAD, status: "processing" },
  ]);
  const second = setup();
  second.sessions.root(REF, "working");
  second.sessions.root(REF, "waiting");
  second.sessions.root(REF, "done");
  await second.sessions.close();
  // Inputs of one turn collapse into the last wanted one: one call in flight, the last wins.
  assert.deepEqual(sent(second.slack), ["active"]);
});

test("one call is in flight per thread, and the last wanted status follows it", async () => {
  const { slack, clock, sessions } = setup();
  slack.gate = new AsyncEvent();
  slack.gateMethod = "agents.sessions.setStatus";
  sessions.root(REF, "working");
  await slack.gated.wait();
  sessions.root(REF, "waiting");
  sessions.root(REF, "done");
  await clock.advance(0);
  assert.deepEqual(sent(slack), []); // the one call is still out; the others wait behind it
  slack.gate.set();
  await sessions.close();
  assert.deepEqual(sent(slack), ["processing", "active"]);
});

test("the same wanted status again makes no call", async () => {
  const { slack, clock, sessions } = setup();
  sessions.root(REF, "working");
  await clock.advance(0);
  sessions.root(REF, "restarting");
  sessions.activity(REF, true);
  await clock.advance(0);
  assert.deepEqual(sent(slack), ["processing"]);
  await sessions.close();
});

test("a thread nothing was given for is not written to", async () => {
  const { slack, clock, sessions } = setup();
  sessions.root(REF, null);
  sessions.activity(REF, false);
  sessions.bridged(REF, true);
  await clock.advance(0);
  await sessions.close();
  assert.deepEqual(slack.callsTo("agents.sessions.setStatus"), []);
});

test("a bridged clear while processing or suspended is wanted sends the wanted status again", async () => {
  const { slack, clock, sessions } = setup();
  sessions.root(REF, "working");
  await clock.advance(0);
  sessions.bridged(REF, true);
  await clock.advance(0);
  sessions.root(REF, "waiting");
  await clock.advance(0);
  sessions.bridged(REF, true);
  await clock.advance(0);
  // A bridged non-empty call resends nothing.
  sessions.bridged(REF, false);
  await clock.advance(0);
  assert.deepEqual(sent(slack), ["processing", "processing", "suspended", "suspended"]);
  await sessions.close();
});

test("a bridged clear while active is wanted resends nothing", async () => {
  const { slack, clock, sessions } = setup();
  sessions.root(REF, "done");
  await clock.advance(0);
  sessions.bridged(REF, true);
  await clock.advance(0);
  assert.deepEqual(sent(slack), ["active"]);
});

test("processing is sent again every thirty minutes, against the one-hour timeout", async () => {
  const { slack, clock, sessions } = setup();
  assert.equal(SESSION_REFRESH_SECONDS, 1800);
  sessions.root(REF, "working");
  await clock.advance(0);
  await clock.advance(SESSION_REFRESH_SECONDS - 1);
  assert.deepEqual(sent(slack), ["processing"]);
  await clock.advance(1);
  assert.deepEqual(sent(slack), ["processing", "processing"]);
  await clock.advance(SESSION_REFRESH_SECONDS);
  assert.deepEqual(sent(slack), ["processing", "processing", "processing"]);
  // Suspended is not repeated.
  sessions.root(REF, "waiting");
  await clock.advance(0);
  await clock.advance(SESSION_REFRESH_SECONDS * 3);
  assert.deepEqual(sent(slack).slice(3), ["suspended"]);
  await sessions.close();
});

test("an active session is dropped, and the refresh timer with it", async () => {
  const { slack, clock, sessions } = setup();
  sessions.root(REF, "working");
  await clock.advance(0);
  sessions.root(REF, "done");
  await clock.advance(0);
  await clock.advance(SESSION_REFRESH_SECONDS * 2);
  assert.deepEqual(sent(slack), ["processing", "active"]);
  await sessions.close();
});

test("the entry outlives the thread object and takes the end status drawn after its close", async () => {
  const { slack, clock, chat, thread } = madeChat();
  thread.showStatus("working");
  thread.showActivity({ kind: "working" });
  await clock.advance(0);
  await thread.close();
  await clock.advance(0);
  // What the session does after the close, through a thread object of its own.
  const again = chat.thread({ channel: CHANNEL, thread: THREAD });
  await again.showStatus("done");
  await chat.close();
  // The close of the line is a bridged clear while the root still works: processing, again.
  assert.deepEqual(sent(slack), ["processing", "processing", "active"]);
});

test("the close of a thread that drew nothing writes nothing", async () => {
  const { slack, clock, chat, thread } = madeChat();
  await thread.close();
  await clock.advance(0);
  await chat.close();
  assert.deepEqual(slack.callsTo("agents.sessions.setStatus"), []);
});

test("a thread's bridged clear sends the wanted status again", async () => {
  const { slack, clock, thread } = madeChat();
  thread.showStatus("working");
  thread.showActivity({ kind: "working" });
  await clock.advance(0);
  thread.showActivity(null); // the bridge clears: the root is still working
  await clock.advance(0);
  await clock.advance(0);
  assert.deepEqual(sent(slack), ["processing", "processing"]);
});

test("a refusal that names the token or the app stops the calls for the run, logged once", async () => {
  for (const code of ["missing_scope", "not_allowed_token_type", "feature_disabled"]) {
    const log = new Lines();
    const { slack, clock, sessions } = setup(log);
    slack.responses["agents.sessions.setStatus"] = () => rejected(code);
    sessions.root(REF, "working");
    await clock.advance(0);
    sessions.root(REF, "waiting");
    await clock.advance(0);
    sessions.root({ channel: CHANNEL, thread: "1780000000.000009" }, "working");
    await clock.advance(0);
    await sessions.close();
    assert.equal(sent(slack).length, 1, code);
    assert.equal(log.warnings.length, 1, code);
    assert.match(log.warnings[0] ?? "", new RegExp(code));
    assert.match(log.warnings[0] ?? "", new RegExp(THREAD));
  }
});

test("another code is logged once in a row and does not stop the calls", async () => {
  const log = new Lines();
  const { slack, clock, sessions } = setup(log);
  slack.responses["agents.sessions.setStatus"] = () => rejected("internal_error");
  sessions.root(REF, "working");
  await clock.advance(0);
  sessions.root(REF, "waiting");
  await clock.advance(0);
  sessions.root(REF, "done");
  await clock.advance(0);
  assert.equal(sent(slack).length, 3);
  assert.equal(log.warnings.length, 1);
  slack.responses["agents.sessions.setStatus"] = () => rejected("ratelimited");
  sessions.root(REF, "working");
  await clock.advance(0);
  assert.equal(log.warnings.length, 2);
  await sessions.close();
});

test("stopped: work stopped resends the wanted status, nothing stopped sets active", async () => {
  const { slack, clock, sessions } = setup();
  sessions.root(REF, "working");
  await clock.advance(0);
  await sessions.stopped(REF, true);
  await sessions.stopped(REF, false);
  assert.deepEqual(sent(slack), ["processing", "processing", "active"]);
  // With no entry at all, `active` all the same, once.
  await sessions.stopped(REF, true);
  assert.deepEqual(sent(slack), ["processing", "processing", "active", "active"]);
  await sessions.close();
});

test("shutdown: the queue ignores the stop signal, close awaits the queue and cancels the timers", async () => {
  const { slack, clock, chat, thread } = madeChat();
  thread.showStatus("working");
  await clock.advance(0);
  chat.halt(); // the daemon aborts the provider's signal before the sessions draw their end
  await thread.showStatus("done");
  await chat.close();
  assert.deepEqual(sent(slack), ["processing", "active"]);
  // Nothing is left to wake: the refresh timer of the dropped entry is gone.
  await clock.advance(SESSION_REFRESH_SECONDS * 2);
  assert.deepEqual(sent(slack), ["processing", "active"]);
});

test("close cancels the refresh timers of a session still processing", async () => {
  const { slack, clock, sessions } = setup();
  sessions.root(REF, "working");
  await clock.advance(0);
  await sessions.close();
  await clock.advance(SESSION_REFRESH_SECONDS * 2);
  assert.deepEqual(sent(slack), ["processing"]);
});

const tick = async (turns: number): Promise<void> => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
};

test("an input just after a drain's last call starts a drain of its own", async () => {
  // The input comes N microtasks after the first root: whatever N, the last wanted status is sent.
  for (let depth = 0; depth < 12; depth += 1) {
    const { slack, sessions } = setup();
    sessions.root(REF, "working");
    await tick(depth);
    sessions.root(REF, "waiting");
    await tick(50);
    await sessions.close();
    assert.equal(sent(slack).at(-1), "suspended", `after ${depth} microtasks`);
  }
});

test("a bridged clear while the explicit call is out gets its resend", async () => {
  const { slack, sessions } = setup();
  slack.gate = new AsyncEvent();
  slack.gateMethod = "agents.sessions.setStatus";
  sessions.root(REF, "working");
  await slack.gated.wait();
  sessions.bridged(REF, true); // the bridge cleared meanwhile: Slack may be active now
  slack.gate.set();
  await sessions.close();
  assert.deepEqual(sent(slack), ["processing", "processing"]);
});

test("a failed call counts as not sent: the entry is kept and the status is tried again", async () => {
  const { slack, clock, sessions } = setup();
  sessions.root(REF, "working");
  await clock.advance(0);
  slack.responses["agents.sessions.setStatus"] = () => rejected("internal_error");
  sessions.root(REF, "done"); // the `active` fails; the entry is kept
  await clock.advance(0);
  assert.deepEqual(sent(slack), ["processing", "active"]);
  slack.responses["agents.sessions.setStatus"] = { ok: true };
  await clock.advance(5); // the retry, not the next input, sends it again
  assert.deepEqual(sent(slack), ["processing", "active", "active"]);
  await clock.advance(SESSION_REFRESH_SECONDS * 4);
  assert.deepEqual(sent(slack), ["processing", "active", "active"]);
  await sessions.close();
});

test("a change drawn while a call fails is sent at once, so the end status survives a close", async () => {
  const { slack, sessions } = setup();
  slack.gate = new AsyncEvent();
  slack.gateMethod = "agents.sessions.setStatus";
  let first = true;
  slack.responses["agents.sessions.setStatus"] = () => {
    if (!first) return { ok: true };
    first = false;
    return rejected("ratelimited");
  };
  sessions.root(REF, "working");
  await slack.gated.wait(); // processing is out
  sessions.root(REF, "done");
  slack.gate.set();
  await sessions.close();
  assert.deepEqual(sent(slack), ["processing", "active"]);
});

for (const code of ["channel_not_found", "message_not_found", "thread_not_found"]) {
  test(`a thread Slack answers ${code} for drops its entry and its timers`, async () => {
    const { slack, clock, sessions } = setup();
    sessions.root(REF, "working");
    await clock.advance(0);
    slack.responses["agents.sessions.setStatus"] = () => rejected(code);
    await clock.advance(SESSION_REFRESH_SECONDS); // the refresh meets the refusal
    await clock.advance(SESSION_REFRESH_SECONDS * 4);
    assert.equal(sent(slack).length, 2, "the refresh met the refusal once, then nothing");
    await sessions.close();
  });
}

test("a failed add of the settling reaction does not turn a finished session back", async () => {
  const { slack, clock, thread } = madeChat();
  await thread.showStatus("working");
  slack.responses["reactions.add"] = (args) =>
    args.name === "white_check_mark" ? rejected("internal_error") : { ok: true };
  await thread.showStatus("done");
  await thread.settleStatus();
  await clock.advance(0);
  // The settling rebuilds the dropped entry and sends `active` again, never `processing`.
  assert.deepEqual(sent(slack).slice(1), ["active", "active"]);
});

// ---- #199: a stream stop is a second writer of the session status

test("wanted follows the root and activity, and is undefined until a call succeeded", async () => {
  const { slack, clock, sessions } = setup();
  assert.equal(sessions.wanted(REF), undefined, "nothing proven yet");
  sessions.root(REF, "waiting");
  assert.equal(sessions.wanted(REF), undefined, "the first call is still out");
  await clock.advance(0);
  assert.equal(sessions.wanted(REF), "suspended");
  sessions.root(REF, "working");
  assert.equal(sessions.wanted(REF), "processing");
  sessions.root(REF, "done");
  sessions.activity(REF, true);
  assert.equal(sessions.wanted(REF), "processing");
  sessions.activity(REF, false);
  await clock.advance(0);
  assert.equal(sessions.wanted(REF), "active", "no entry: active");
  assert.deepEqual(sent(slack), ["suspended", "active"]); // the turn collapses its inputs
  await sessions.close();
});

test("wanted stays undefined when the first call fails, and after a refusal", async () => {
  const failing = setup();
  failing.slack.responses["agents.sessions.setStatus"] = () => rejected("internal_error");
  failing.sessions.root(REF, "working");
  await failing.clock.advance(0);
  assert.equal(failing.sessions.wanted(REF), undefined);
  await failing.sessions.close();

  const { slack, clock, sessions } = setup();
  sessions.root(REF, "working");
  await clock.advance(0);
  assert.equal(sessions.wanted(REF), "processing");
  slack.responses["agents.sessions.setStatus"] = () => rejected("missing_scope");
  sessions.root(REF, "done");
  await clock.advance(0);
  assert.equal(sessions.wanted(REF), undefined, "refused for good");
  await sessions.close();
});

test("afterWrite with what is wanted sends nothing, a stop without the field being active", async () => {
  const { slack, clock, sessions } = setup();
  sessions.root(REF, "working");
  await clock.advance(0);
  sessions.afterWrite(REF, "processing");
  sessions.afterWrite(REF, "processing");
  await clock.advance(0);
  assert.deepEqual(sent(slack), ["processing"]);
  sessions.root(REF, "done");
  await clock.advance(0);
  sessions.afterWrite(REF, undefined); // no field: Slack's default, which is what is wanted
  sessions.afterWrite(REF, "active");
  await clock.advance(0);
  assert.deepEqual(sent(slack), ["processing", "active"]);
  await sessions.close();
});

test("afterWrite with another status sends the wanted one again", async () => {
  const { slack, clock, sessions } = setup();
  sessions.root(REF, "working");
  await clock.advance(0);
  sessions.afterWrite(REF, undefined); // a stop with no field set the session active
  await clock.advance(0);
  sessions.afterWrite(REF, "suspended");
  await clock.advance(0);
  assert.deepEqual(sent(slack), ["processing", "processing", "processing"]);
  await sessions.close();
});

test("afterWrite of an unknown outcome sends the wanted status, even a matching one", async () => {
  const { slack, clock, sessions } = setup();
  sessions.root(REF, "working");
  await clock.advance(0);
  sessions.afterWrite(REF, null);
  await clock.advance(0);
  assert.deepEqual(sent(slack), ["processing", "processing"]);
  await sessions.close();
});

test("a stop that returns after the entry was dropped is corrected", async () => {
  const { slack, clock, sessions } = setup();
  sessions.root(REF, "working");
  await clock.advance(0);
  const carried = sessions.wanted(REF); // the stop reads processing
  sessions.root(REF, "done"); // the work ends: active sent, the entry dropped
  await clock.advance(0);
  assert.deepEqual(sent(slack), ["processing", "active"]);
  sessions.afterWrite(REF, carried); // the stop lands last and sets processing
  await clock.advance(0);
  assert.deepEqual(sent(slack), ["processing", "active", "active"]);
  await sessions.close();
});

test("a matching stop does not erase a resend a bridged clear demanded", async () => {
  const { slack, clock, sessions } = setup();
  sessions.root(REF, "working");
  await clock.advance(0);
  slack.gate = new AsyncEvent();
  slack.gateMethod = "agents.sessions.setStatus";
  const stopped = sessions.stopped(REF, true); // a resend is out, held
  await slack.gated.wait();
  const carried = sessions.wanted(REF); // a stream stop reads processing
  sessions.bridged(REF, true); // the bridge cleared: another resend is demanded
  sessions.afterWrite(REF, carried); // the stop returns, a match: nothing of its own
  slack.gate.set();
  await stopped;
  await sessions.close();
  assert.deepEqual(sent(slack), ["processing", "processing", "processing"]);
});

test("a stream that starts while suspended is wanted gets the wanted status again", async () => {
  const { slack, clock, sessions } = setup();
  sessions.root(REF, "waiting");
  await clock.advance(0);
  sessions.afterWrite(REF, "processing"); // a start sets processing
  await clock.advance(0);
  assert.deepEqual(sent(slack), ["suspended", "suspended"]);
  await sessions.close();
});

test("a stop answered before the first status call succeeded is still reconciled", async () => {
  const { slack, clock, sessions } = setup();
  slack.gate = new AsyncEvent();
  slack.gateMethod = "agents.sessions.setStatus";
  sessions.root(REF, "working");
  await slack.gated.wait(); // the first call is held: nothing is proven yet
  assert.equal(sessions.wanted(REF), undefined);
  sessions.afterWrite(REF, sessions.wanted(REF)); // a stop with no field set `active`
  slack.gate.set();
  await clock.advance(0);
  await sessions.close();
  assert.deepEqual(sent(slack), ["processing", "processing"]);
});

test("afterWrite does nothing once a refusal stopped the calls", async () => {
  const { slack, clock, sessions } = setup();
  slack.responses["agents.sessions.setStatus"] = () => rejected("feature_disabled");
  sessions.root(REF, "working");
  await clock.advance(0);
  sessions.afterWrite(REF, null);
  sessions.afterWrite(REF, "suspended");
  await clock.advance(0);
  assert.equal(sent(slack).length, 1);
  // No entry was made: a refresh timer or a later input would find one to send for.
  sessions.root(REF, "done");
  await clock.advance(0);
  assert.equal(sent(slack).length, 1);
  await sessions.close();
});

// ---- #206: a failed status call is retried on a timer of its own

const FAILING = () => rejected("internal_error");

test("a failed active is sent again after 5 s, 15 s, 45 s, then every 300 s, until it succeeds", {
  timeout: 8000,
}, async () => {
  const { slack, clock, sessions } = setup();
  sessions.root(REF, "working");
  await clock.advance(0);
  slack.responses["agents.sessions.setStatus"] = FAILING;
  sessions.root(REF, "done");
  await clock.advance(0);
  assert.equal(sent(slack).length, 2);
  let expected = 2;
  for (const [step, wait] of [
    [4, false],
    [1, true],
    [14, false],
    [1, true],
    [44, false],
    [1, true],
    [299, false],
    [1, true],
    [299, false],
    [1, true],
  ] as const) {
    await clock.advance(step);
    if (wait) expected += 1;
    assert.equal(sent(slack).length, expected, `after ${clock.now} s`);
  }
  slack.responses["agents.sessions.setStatus"] = { ok: true };
  await clock.advance(300);
  assert.equal(sent(slack).length, expected + 1);
  await clock.advance(300);
  await clock.advance(SESSION_REFRESH_SECONDS * 2);
  assert.equal(sent(slack).length, expected + 1, "a success ends the retries");
  await sessions.close();
});

test("a failed call leaves the processing refresh at thirty minutes", {
  timeout: 8000,
}, async () => {
  const { slack, clock, sessions } = setup();
  sessions.root(REF, "working");
  await clock.advance(0);
  slack.responses["agents.sessions.setStatus"] = FAILING;
  sessions.bridged(REF, true); // a second writer: processing is sent again and fails
  await clock.advance(0);
  for (const step of [5, 15, 45, 300, 300, 300, 300, 300]) await clock.advance(step); // t = 1565
  assert.equal(sent(slack).length, 10); // first, again, three fast retries, five slow ones
  await clock.advance(1800 - 1565 - 1);
  assert.equal(sent(slack).length, 10);
  await clock.advance(1); // t = 1800: the refresh, the next retry is due at 2100
  assert.equal(sent(slack).length, 11);
  await sessions.close();
});

test("a failed active then an input that wants processing: processing is sent, the refresh armed, the retry gone", {
  timeout: 8000,
}, async () => {
  const { slack, clock, sessions } = setup();
  sessions.root(REF, "working");
  await clock.advance(0);
  let failing = true;
  slack.responses["agents.sessions.setStatus"] = (args) =>
    failing && args.status === "active" ? rejected("internal_error") : { ok: true };
  sessions.root(REF, "done");
  await clock.advance(0);
  sessions.root(REF, "working");
  await clock.advance(0);
  assert.deepEqual(sent(slack), ["processing", "active", "processing"]);
  failing = false;
  for (const step of [5, 15, 45, 300]) await clock.advance(step);
  assert.equal(sent(slack).length, 3, "no retry is left");
  await clock.advance(SESSION_REFRESH_SECONDS - 365);
  assert.equal(sent(slack).length, 4, "the refresh fires at thirty minutes");
  await sessions.close();
});

test("a new wanted status during the backoff is sent at once, and its own backoff starts at 5 s", {
  timeout: 8000,
}, async () => {
  const { slack, clock, sessions } = setup();
  slack.responses["agents.sessions.setStatus"] = FAILING;
  sessions.root(REF, "working");
  await clock.advance(0);
  await clock.advance(5);
  await clock.advance(15); // failures of processing: 3, the next retry is 45 s away
  assert.deepEqual(sent(slack), ["processing", "processing", "processing"]);
  sessions.root(REF, "waiting");
  await clock.advance(0);
  assert.deepEqual(sent(slack), ["processing", "processing", "processing", "suspended"]);
  await clock.advance(4);
  assert.equal(sent(slack).length, 4);
  await clock.advance(1);
  assert.equal(sent(slack).length, 5, "suspended starts again at 5 s");
  assert.equal(sent(slack)[4], "suspended");
  await sessions.close();
});

test("no retry after close", { timeout: 8000 }, async () => {
  const { slack, clock, sessions } = setup();
  slack.responses["agents.sessions.setStatus"] = FAILING;
  sessions.root(REF, "working");
  await clock.advance(0);
  await sessions.close();
  for (const step of [5, 15, 45, 300]) await clock.advance(step);
  assert.equal(sent(slack).length, 1);
});

test("no retry after a refusal that names the app, or after gone", { timeout: 8000 }, async () => {
  for (const code of ["missing_scope", "thread_not_found"]) {
    const { slack, clock, sessions } = setup();
    slack.responses["agents.sessions.setStatus"] = FAILING;
    sessions.root(REF, "working");
    await clock.advance(0);
    slack.responses["agents.sessions.setStatus"] = () => rejected(code);
    await clock.advance(5); // the retry meets the answer
    for (const step of [15, 45, 300, 300]) await clock.advance(step);
    assert.equal(sent(slack).length, 2, code);
    await sessions.close();
  }
});

test("repeated failures with the same code log once", { timeout: 8000 }, async () => {
  const log = new Lines();
  const { slack, clock, sessions } = setup(log);
  slack.responses["agents.sessions.setStatus"] = FAILING;
  sessions.root(REF, "working");
  await clock.advance(0);
  for (const step of [5, 15, 45, 300]) await clock.advance(step);
  assert.equal(sent(slack).length, 5);
  assert.equal(log.warnings.length, 1);
  await sessions.close();
});

test("a call whose answer was lost does not leave the old status counted as sent", {
  timeout: 8000,
}, async () => {
  const { slack, clock, sessions } = setup();
  sessions.root(REF, "waiting");
  await clock.advance(0);
  slack.responses["agents.sessions.setStatus"] = FAILING;
  sessions.root(REF, "working"); // processing may have reached Slack; the answer was lost
  await clock.advance(0);
  slack.responses["agents.sessions.setStatus"] = { ok: true };
  sessions.root(REF, "waiting");
  await clock.advance(0);
  assert.deepEqual(sent(slack), ["suspended", "processing", "suspended"]);
  await sessions.close();
});

test("a thread failing with the same code logs once, whatever other threads do", {
  timeout: 8000,
}, async () => {
  const log = new Lines();
  const { slack, clock, sessions } = setup(log);
  const other = { channel: CHANNEL, thread: "1780000000.000009" };
  slack.responses["agents.sessions.setStatus"] = (args) =>
    args.thread_ts === THREAD ? rejected("internal_error") : { ok: true };
  sessions.root(REF, "working");
  await clock.advance(0);
  let status: RootStatus = "working";
  for (const step of [5, 15, 45, 300]) {
    status = status === "working" ? "waiting" : "working";
    sessions.root(other, status); // a success elsewhere between the retries
    await clock.advance(step);
  }
  assert.equal(
    sent(slack).filter(
      (_, i) => slack.callsTo("agents.sessions.setStatus")[i]?.thread_ts === THREAD,
    ).length,
    5,
  );
  assert.equal(log.warnings.length, 1);
  await sessions.close();
});

function withInitiator() {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const created: string[] = [];
  const sessions = new AgentSessions(slack, {
    clock,
    logger: new Lines(),
    initiator: OWNER,
    created: (ref) => void created.push(ref.thread),
  });
  return { slack, clock, sessions, created };
}

const calls = (slack: FakeSlack) => slack.callsTo("agents.sessions.setStatus");

test("setStatus names the owner as the initiator and reports the session made", async () => {
  const { slack, sessions, created } = withInitiator();
  sessions.root(REF, "working");
  await sessions.close();
  assert.deepEqual(calls(slack), [
    { channel_id: CHANNEL, thread_ts: THREAD, status: "processing", initiator_user_id: OWNER },
  ]);
  assert.deepEqual(created, [THREAD]);
});

test("a platform refusal of the initiator is sent again at once without it, and remembered", async () => {
  const { slack, sessions, created } = withInitiator();
  slack.responses["agents.sessions.setStatus"] = [rejected("user_not_in_channel"), { ok: true }];
  sessions.root(REF, "working");
  await sessions.close();
  assert.deepEqual(
    calls(slack).map((call) => call.initiator_user_id),
    [OWNER, undefined],
  );
  assert.deepEqual(created, [THREAD]);
  sessions.root(REF, "waiting");
  await sessions.close();
  assert.equal(calls(slack).at(-1)?.initiator_user_id, undefined);
  assert.equal(calls(slack).length, 3);
});

test("a bot outside the channel marks nothing: both calls fail and the ordinary retry follows", async () => {
  const { slack, clock, sessions, created } = withInitiator();
  slack.responses["agents.sessions.setStatus"] = [
    rejected("user_not_in_channel"),
    rejected("not_in_channel"),
    { ok: true },
  ];
  sessions.root(REF, "working");
  await clock.advance(0);
  assert.deepEqual(created, []);
  await clock.advance(SESSION_RETRY_SECONDS[0] as number);
  await sessions.close();
  assert.deepEqual(
    calls(slack).map((call) => call.initiator_user_id),
    [OWNER, undefined, OWNER],
  );
  assert.deepEqual(created, [THREAD]);
});

test("a rate limit or a service error on the creating call is retried with the initiator", async () => {
  for (const failure of [
    networkDown(),
    rateLimited(),
    rejected("service_unavailable"),
    rejected("request_timeout"),
    httpError(),
  ]) {
    const { slack, clock, sessions } = withInitiator();
    slack.responses["agents.sessions.setStatus"] = [failure, { ok: true }];
    sessions.root(REF, "working");
    await clock.advance(0);
    assert.equal(calls(slack).length, 1, "no bare call at once");
    await clock.advance(SESSION_RETRY_SECONDS[0] as number);
    await sessions.close();
    assert.deepEqual(
      calls(slack).map((call) => call.initiator_user_id),
      [OWNER, OWNER],
    );
  }
});

test("SlackChat.close halts the titles before the sessions drain: a late setStatus starts no read", async () => {
  const { slack, chat } = madeChat();
  slack.gate = new AsyncEvent();
  slack.gateMethod = "agents.sessions.setStatus";
  chat.agentSessions.root(REF, "working");
  await slack.gated.wait();
  const closing = chat.close();
  slack.gate.set();
  await closing;
  assert.equal(calls(slack).length, 1);
  assert.deepEqual(slack.callsTo("conversations.replies"), []);
  assert.deepEqual(slack.callsTo("agents.sessions.rename"), []);
});
