/**
 * The state of the update in memory (`src/core/updates.ts`): what a check learned, the phases of an
 * update, what the chat's own page is given, and the periodic check.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkEvery,
  sharedCopyLine,
  UPDATE_CHECK_SECONDS,
  UPDATE_RETRY_LIMIT,
  UPDATE_RETRY_SECONDS,
  Updates,
  whyUnknown,
} from "../../src/core/updates.ts";
import { AsyncEvent, FakeClock } from "../support/fake-slack.ts";
import { COPY, FakeUpdatesHost } from "../support/updates.ts";

function build(host = new FakeUpdatesHost()): { host: FakeUpdatesHost; updates: Updates } {
  return { host, updates: new Updates(host, { now: () => 1_780_000_000 }) };
}

test("before a check nothing is known and the page has no line", () => {
  const { updates } = build();
  assert.equal(updates.latest, null);
  assert.equal(updates.checkedAt, null);
  assert.equal(updates.newer, null);
  assert.equal(updates.line(), null);
  assert.deepEqual(updates.phase, { kind: "idle" });
});

test("a check learns the latest version, when, and that the copy updates", async () => {
  const { host, updates } = build();
  let changes = 0;
  updates.onChange = () => {
    changes += 1;
  };
  await updates.check();
  assert.equal(updates.latest, "0.3.1");
  assert.equal(updates.newer, "0.3.1");
  assert.equal(updates.checkedAt, 1_780_000_000);
  assert.equal(updates.checkFailure, null);
  assert.equal(updates.canUpdate, true);
  assert.equal(changes, 1, "the page is told once");
  assert.deepEqual(updates.line(), {
    installed: "0.3.0",
    latest: "0.3.1",
    changelog: host.changelog("0.3.1"),
    phase: "available",
    failure: null,
    note: null,
  });
});

test("the latest version the daemon already runs is no update, and has no line", async () => {
  const { host, updates } = build();
  host.newest = { version: "0.3.0" };
  await updates.check();
  assert.equal(updates.latest, "0.3.0");
  assert.equal(updates.newer, null);
  assert.equal(updates.line(), null);
});

test("a check that fails keeps the last version it learned and says why it failed", async () => {
  const { host, updates } = build();
  await updates.check();
  host.newest = { failure: { kind: "network" } };
  await updates.check();
  assert.deepEqual(updates.checkFailure, { kind: "network" });
  assert.equal(updates.latest, "0.3.1");
  host.newest = { version: "0.3.2" };
  await updates.check();
  assert.equal(updates.checkFailure, null);
  assert.equal(updates.latest, "0.3.2");
});

test("a host that throws is a failed check, never a rejection", async () => {
  const { host, updates } = build();
  host.latest = async () => {
    throw new Error("spawn failed");
  };
  await updates.check();
  assert.deepEqual(updates.checkFailure, { kind: "other", status: null });
  assert.equal(updates.checkedAt, 1_780_000_000);
});

test("two checks at once ask the host once", async () => {
  const { host, updates } = build();
  await Promise.all([updates.check(), updates.check()]);
  assert.equal(host.calls.filter((call) => call === "latest").length, 1);
});

test("a copy that does not update shows no line, and says why", async () => {
  const { host, updates } = build();
  host.copy = { refusal: { kind: "link" } };
  await updates.check();
  assert.equal(updates.newer, "0.3.1");
  assert.equal(updates.canUpdate, false);
  assert.deepEqual(updates.refusal, { kind: "link" });
  assert.equal(updates.line(), null);
});

test("npm that cannot say whether the copy updates is a failed check, not a refusal", async () => {
  const { host, updates } = build();
  host.copy = { refusal: { kind: "npm", failure: { kind: "network" } } };
  await updates.check();
  assert.equal(updates.refusal, null);
  assert.deepEqual(updates.checkFailure, { kind: "network" });
  assert.equal(updates.line(), null);
});

test("a copy another process is replacing keeps the previous answer, and the check is asked again soon", async () => {
  const { host, updates } = build();
  host.copy = { swapping: true };
  assert.equal(await updates.check(), false, "the answer is not complete");
  assert.equal(updates.canUpdate, false, "nothing was known before");
  assert.equal(updates.refusal, null, "and nothing is refused");
  assert.equal(updates.latest, "0.3.1", "the registry's answer is kept");
  host.copy = { copy: COPY };
  assert.equal(await updates.check(), true);
  assert.equal(updates.canUpdate, true);
  host.copy = { swapping: true };
  host.newest = { version: "0.3.2" };
  assert.equal(await updates.check(), false);
  assert.equal(updates.canUpdate, true, "the previous answer stands during the swap");
  assert.equal(updates.copy, COPY);
  assert.equal(updates.latest, "0.3.2");
  host.copy = { refusal: { kind: "link" } };
  assert.equal(await updates.check(), true);
  assert.equal(updates.canUpdate, false);
});

test("validating while another process replaces the copy keeps the answer and says so", async () => {
  const { host, updates } = build();
  await updates.check();
  host.copy = { swapping: true };
  assert.deepEqual(await updates.validate(), { swapping: true });
  assert.equal(updates.canUpdate, true, "the previous answer stands");
});

test("an incomplete check is asked again after the short wait, a complete one after six hours", async () => {
  const { host, updates } = build();
  host.copy = { swapping: true };
  const clock = new FakeClock();
  const stop = new AbortController();
  const running = checkEvery({
    seconds: UPDATE_CHECK_SECONDS,
    retrySeconds: UPDATE_RETRY_SECONDS,
    check: () => updates.check(),
    sessions: { draining: false },
    clock,
    signal: stop.signal,
  });
  const asked = () => host.calls.filter((call) => call === "latest").length;
  await clock.advance(0);
  assert.equal(asked(), 1);
  assert.equal(UPDATE_RETRY_SECONDS, 30);
  await clock.advance(UPDATE_RETRY_SECONDS);
  assert.equal(asked(), 2, "tried again after 30 seconds");
  host.copy = { copy: COPY };
  await clock.advance(UPDATE_RETRY_SECONDS);
  assert.equal(asked(), 3, "still the short wait: the third check was the first to complete");
  await clock.advance(UPDATE_RETRY_SECONDS * 4);
  assert.equal(asked(), 3, "a complete check waits six hours");
  await clock.advance(UPDATE_CHECK_SECONDS);
  assert.equal(asked(), 4);
  stop.abort();
  await running;
});

test("an entry file that stays gone ends the short retries, and the copy is no longer offered", async () => {
  const { host, updates } = build();
  await updates.check();
  assert.equal(updates.line()?.phase, "available");
  // `npm uninstall -g` under a live daemon: the entry file does not come back.
  host.copy = { swapping: true };
  for (let tried = 1; tried < UPDATE_RETRY_LIMIT; tried += 1) {
    assert.equal(await updates.check(), false, `try ${tried} is asked again soon`);
    assert.equal(updates.canUpdate, true, "the previous answer stands during a swap");
  }
  assert.equal(await updates.check(), true, "the last try goes back to the long wait");
  assert.equal(updates.canUpdate, false, "an answer about a copy that is gone is not kept");
  assert.equal(updates.line(), null);
  assert.equal(updates.noticeDue(null), null);
  host.copy = { copy: COPY };
  assert.equal(await updates.check(), true);
  assert.equal(updates.canUpdate, true, "a copy that is back is offered again");
  host.copy = { swapping: true };
  assert.equal(await updates.check(), false, "and a swap after it is counted from one");
});

test("a click that finds the copy back counts the swaps from one again", async () => {
  const { host, updates } = build();
  await updates.check();
  host.copy = { swapping: true };
  for (let tried = 1; tried < UPDATE_RETRY_LIMIT; tried += 1) await updates.check();
  host.copy = { copy: COPY };
  assert.deepEqual(await updates.validate(), { copy: COPY });
  host.copy = { swapping: true };
  assert.equal(await updates.check(), false, "the swaps before the copy came back do not count");
});

test("a daemon that no service runs offers no line and no notice, as a copy that cannot update", async () => {
  const { host, updates } = build();
  await updates.check();
  assert.equal(updates.line()?.phase, "available");
  assert.equal(updates.noticeDue(null), "0.3.1");
  host.service = false;
  assert.equal(updates.line(), null);
  assert.equal(updates.noticeDue(null), null);
  host.service = true;
  assert.equal(
    updates.line()?.phase,
    "available",
    "a service that runs it again brings the line back",
  );
});

test("the service is asked only when there is a line or a notice to show", async () => {
  const { host, updates } = build();
  host.newest = { version: "0.3.0" };
  await updates.check();
  host.calls.length = 0;
  assert.equal(updates.line(), null);
  assert.equal(updates.noticeDue(null), null);
  assert.ok(
    !host.calls.includes("supervised"),
    "nothing newer: no question to the service manager",
  );
});

test("a check that finds a version newer than the failed one offers it again", async () => {
  const { host, updates } = build();
  await updates.check();
  updates.begin("0.3.1");
  updates.fail("0.3.1", "The update failed.");
  await updates.check();
  assert.equal(updates.line()?.phase, "failed", "the same version still failed");
  host.newest = { version: "0.3.2" };
  await updates.check();
  const line = updates.line();
  assert.equal(line?.phase, "available");
  assert.equal(line?.latest, "0.3.2");
  assert.equal(line?.failure, null);
});

test("an update goes through its phases, and the page follows each", async () => {
  const { updates } = build();
  await updates.check();
  const seen: string[] = [];
  updates.onChange = () => seen.push(updates.line()?.phase ?? "none");
  assert.equal(updates.begin("0.3.1"), true);
  assert.equal(updates.line()?.phase, "installing");
  assert.equal(updates.begin("0.3.1"), false, "a second claim is refused");
  updates.restarting("0.3.1");
  assert.equal(updates.begin("0.3.1"), false);
  assert.equal(updates.line()?.phase, "restarting");
  assert.deepEqual(seen, ["installing", "restarting"]);
});

test("a failed update keeps its sentence on the line until the next claim", async () => {
  const { updates } = build();
  await updates.check();
  updates.begin("0.3.1");
  updates.fail("0.3.1", "The update failed.");
  const line = updates.line();
  assert.equal(line?.phase, "failed");
  assert.equal(line?.failure, "The update failed.");
  assert.equal(updates.begin("0.3.1"), true, "a failed update may be tried again");
  assert.equal(updates.line()?.failure, null);
});

test("abandoning a claim returns to what a check found", async () => {
  const { updates } = build();
  await updates.check();
  updates.begin("0.3.1");
  updates.abandon();
  assert.equal(updates.line()?.phase, "available");
});

test("the notice is due once per version, never for a copy that does not update", async () => {
  const { host, updates } = build();
  assert.equal(updates.noticeDue(null), null, "nothing is known before a check");
  await updates.check();
  assert.equal(updates.noticeDue(null), "0.3.1");
  assert.equal(updates.noticeDue("0.3.1"), null, "told already");
  assert.equal(updates.noticeDue("0.3.0"), "0.3.1", "another version was told");
  host.copy = { refusal: { kind: "not-global", folder: "/elsewhere" } };
  await updates.check();
  assert.equal(updates.noticeDue(null), null);
  host.copy = { copy: COPY };
  host.newest = { version: "0.3.0" };
  await updates.check();
  assert.equal(updates.noticeDue(null), null, "up to date");
});

test("no notice while an update is under way", async () => {
  const { updates } = build();
  await updates.check();
  updates.begin("0.3.1");
  assert.equal(updates.noticeDue(null), null);
});

test("a page that throws does not break the state", async () => {
  const { updates } = build();
  updates.onChange = () => {
    throw new Error("the page is gone");
  };
  await updates.check();
  assert.equal(updates.latest, "0.3.1");
});

test("the check runs at start and every six hours, and ends with the stop", async () => {
  const { host, updates } = build();
  const clock = new FakeClock();
  const stop = new AbortController();
  const sessions = { draining: false };
  const running = checkEvery({
    seconds: UPDATE_CHECK_SECONDS,
    check: () => updates.check(),
    sessions,
    clock,
    signal: stop.signal,
  });
  await clock.advance(0);
  assert.equal(host.calls.filter((call) => call === "latest").length, 1, "at start");
  assert.equal(UPDATE_CHECK_SECONDS, 6 * 60 * 60);
  await clock.advance(UPDATE_CHECK_SECONDS);
  assert.equal(host.calls.filter((call) => call === "latest").length, 2, "every six hours");
  sessions.draining = true;
  await clock.advance(UPDATE_CHECK_SECONDS);
  assert.equal(host.calls.filter((call) => call === "latest").length, 2, "none once draining");
  await running;
});

test("a stop before the first check ends the loop without a check", async () => {
  const { host, updates } = build();
  const stop = new AbortController();
  stop.abort();
  await checkEvery({
    seconds: 1,
    check: () => updates.check(),
    sessions: { draining: false },
    clock: new FakeClock(),
    signal: stop.signal,
  });
  assert.deepEqual(host.calls, []);
});

test("a check is given the signal that the shutdown aborts", async () => {
  const { host, updates } = build();
  await updates.check();
  const [latest, updatable] = host.signals;
  assert.equal(latest?.call, "latest");
  assert.equal(updatable?.call, "updatable");
  assert.equal(latest?.signal, updatable?.signal);
  assert.equal(latest?.signal.aborted, false);
  updates.endChecks();
  assert.equal(latest?.signal.aborted, true);
});

test("a click is work the drain waits for, until it ends or the drain is cut short", async () => {
  const { updates } = build();
  const click = new AsyncEvent();
  const clicking = updates.track(() => click.wait());
  assert.equal(updates.working, true);
  const cut = new AbortController();
  let drained = false;
  const waiting = updates.settled(cut.signal).then(() => {
    drained = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false, "a click under way holds the drain");
  click.set();
  await clicking;
  await waiting;
  assert.equal(updates.working, false);
  // Cut short: the drain does not wait for a click any more.
  const stuck = new AsyncEvent();
  void updates.track(() => stuck.wait());
  const second = updates.settled(cut.signal);
  cut.abort();
  await second;
  stuck.set();
});

test("cancelling the install aborts its signal, waits for the click, and refuses a new claim", async () => {
  const { host, updates } = build();
  await updates.check();
  const click = new AsyncEvent();
  let seen: AbortSignal | null = null;
  void updates.track(async () => {
    updates.begin("0.3.1");
    seen = updates.installing;
    await click.wait();
  });
  assert.ok(seen !== null);
  assert.equal((seen as AbortSignal).aborted, false);
  let ended = false;
  const cancelled = updates.cancelInstall().then(() => {
    ended = true;
  });
  assert.equal((seen as AbortSignal).aborted, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ended, false, "it waits for the click to end");
  click.set();
  await cancelled;
  updates.abandon();
  assert.equal(updates.begin("0.3.1"), false, "no install starts once the stop is cancelling");
  void host;
});

test("the instances that restart with this one are named", () => {
  assert.equal(sharedCopyLine([]), null);
  assert.equal(sharedCopyLine(["work2"]), "Instance `work2` runs the same copy and restarts too.");
  assert.equal(sharedCopyLine([null]), "The default instance runs the same copy and restarts too.");
  assert.equal(
    sharedCopyLine([null, "work2"]),
    "Instances the default instance and `work2` run the same copy and restart too.",
  );
  assert.equal(
    sharedCopyLine(["a", "b", "c"]),
    "Instances `a`, `b` and `c` run the same copy and restart too.",
  );
});

test("why npm could not say is worded as the terminal words it", () => {
  assert.equal(whyUnknown({ kind: "network" }), "npm could not reach the registry");
  assert.equal(whyUnknown({ kind: "permission", path: null }), "npm may not read what it needs");
  assert.equal(whyUnknown({ kind: "other", status: 3 }), "npm ended with status 3");
  assert.equal(whyUnknown({ kind: "other", status: null }), "npm ended with status unknown");
});
