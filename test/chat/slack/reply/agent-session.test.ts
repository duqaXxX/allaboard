import assert from "node:assert/strict";
import { test } from "node:test";
import type { RootStatus } from "../../../../src/chat/seam.ts";
import {
  AgentSessions,
  SESSION_REFRESH_SECONDS,
  wantedStatus,
} from "../../../../src/chat/slack/reply/agent-session.ts";
import type { Logger } from "../../../../src/log.ts";
import {
  AsyncEvent,
  CHANNEL,
  FakeClock,
  FakeSlack,
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
  slack.responses["agents.sessions.setStatus"] = () => rejected("thread_not_found");
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

test("a failed call keeps what was sent and waits for the next input", async () => {
  const { slack, clock, sessions } = setup();
  sessions.root(REF, "working");
  await clock.advance(0);
  slack.responses["agents.sessions.setStatus"] = () => rejected("internal_error");
  sessions.root(REF, "done"); // the `active` fails; the entry is kept
  await clock.advance(0);
  // Only the processing refresh, armed by the first call, tries again, once.
  await clock.advance(SESSION_REFRESH_SECONDS * 4);
  assert.deepEqual(sent(slack), ["processing", "active", "active"]);
  slack.responses["agents.sessions.setStatus"] = { ok: true };
  sessions.root(REF, "done"); // the next input tries again
  await clock.advance(0);
  assert.deepEqual(sent(slack), ["processing", "active", "active", "active"]);
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
