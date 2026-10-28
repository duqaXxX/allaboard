/**
 * `!stop` with no turn running and background tasks alive: the agent's process is
 * closed instead of the tasks stopped one by one, since Claude Code opens a turn of its own to
 * react to a task stopped that way and the agent carries on. The next message resumes the same
 * session; the process that resumes it tells of the tasks it lost
 * (`stop-close-resume`, recorded on 2026-10-18 with `@anthropic-ai/claude-agent-sdk` 0.3.302,
 * Claude Code 2.1.302 and the daemon's options) and ends an empty turn: neither shows.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { INJECTED_TURN_WAIT } from "../../../../src/core/sessions/constants.ts";
import * as texts from "../../../../src/core/texts.ts";
import { AsyncEvent } from "../../../support/fake-clock.ts";
import { CHANNEL, THREAD } from "../../../support/fake-slack.ts";
import { type JsonObject, sdkRecords } from "../../../support/fixtures.ts";
import {
  type Item,
  isResult,
  requestWhileStreaming,
  sdkMessages,
} from "../../../support/sessions.ts";
import { message, reply, type World, worldOf } from "../../../support/slack-app.ts";

/** The recorded subagent that outlives its turn, and the recorded agent with a command. */
const AGENT = "a04b29a98c245a875";
const BOTH = ["a2212140c7c7bb15e", "btmuz8js3"];

/** A turn whose reply ends with these tasks running. */
function launching(name: string): Item[] {
  const items = sdkMessages(name);
  return items.slice(0, items.findIndex(isResult) + 1);
}

/**
 * What the resumed process emits for the owner's first prompt, from the recording: the stopped
 * notification of each task (the recorded one, once per id), the empty result, then the turn of
 * the prompt. The recorded replay of the prompt is left to the harness, which knows its id.
 */
function resumed(taskIds: readonly string[], sessionId: string): Item[] {
  const records = sdkRecords("stop-close-resume").filter((record) => record.type !== "user");
  const out: JsonObject[] = [];
  for (const record of records) {
    if (record.subtype === "task_notification") {
      for (const task_id of taskIds) out.push({ ...record, task_id });
    } else {
      out.push(record);
    }
  }
  const recorded = String(out.find((record) => record.session_id)?.session_id);
  return JSON.parse(JSON.stringify(out).replaceAll(recorded, sessionId)).map(
    (record: JsonObject) => ({ record }),
  );
}

function posts(world: World): string[] {
  return world.slack.callsTo("chat.postMessage").map((args) => String(args.text ?? ""));
}

/** The reactions standing on the message at `ts`. */
function standing(world: World, ts: string): string[] {
  const shown = new Set<string>();
  for (const call of world.slack.apiCalls) {
    if (call.args.timestamp !== ts) continue;
    if (call.method === "reactions.add") shown.add(String(call.args.name));
    if (call.method === "reactions.remove") shown.delete(String(call.args.name));
  }
  return [...shown];
}

/** A world whose first thread has launched the tasks of `name`, ready for `!stop`. */
async function running(world: World, name: string) {
  await world.dispatch(message("launch it", { ts: THREAD }));
  const first = world.clients[0];
  assert.ok(first !== undefined);
  first.answer(launching(name));
  await world.until(() => world.slack.callsTo("chat.stopStream").length > 0);
  return first;
}

function sessionId(world: World): string {
  const stored = world.state.thread(CHANNEL, THREAD)?.sessionId;
  assert.ok(stored, "the first turn recorded its session id");
  return stored;
}

test("a stop with a subagent in the background closes the process, stops no task, says Stopped. once", async (t) => {
  const world = worldOf(t);
  const first = await running(world, "session-state-agent");
  const before = posts(world).length;
  await world.dispatch(reply("!stop", THREAD));
  await world.until(() => posts(world).includes(texts.STOPPED_THREAD));
  assert.equal(first.connected, false, "the process is closed");
  assert.deepEqual(first.stoppedTasks, [], "no task is stopped one by one");
  assert.equal(first.interrupts, 0);
  assert.deepEqual(posts(world).slice(before), [texts.STOPPED_THREAD], "one push, nothing else");
  assert.deepEqual(standing(world, THREAD), ["white_check_mark"]);
  assert.equal(world.clients.length, 1, "nothing starts a process meanwhile");
});

test("the next message resumes the session, and its reply is the only new one", async (t) => {
  const world = worldOf(t);
  const first = await running(world, "session-state-agent");
  await world.dispatch(reply("!stop", THREAD));
  await world.until(() => posts(world).includes(texts.STOPPED_THREAD));
  const id = sessionId(world);
  world.backend.script = () => ({ turns: [resumed([AGENT], id)] });
  const streams = world.slack.streamTs.length;
  const before = posts(world).length;
  await world.dispatch(reply("what now?", THREAD));
  await world.until(() => world.slack.streamTs.length > streams);
  await world.until(() => standing(world, THREAD).includes("white_check_mark"));
  await world.idle();
  const second = world.clients[1];
  assert.ok(second !== undefined, "a new process");
  assert.equal(second.options.resume, id, "the same session id");
  assert.deepEqual(second.queries, ["what now?"], "the prompt reaches it, once");
  assert.equal(first.connected, false);
  assert.equal(world.slack.streamTs.length, streams + 1, "one new reply");
  assert.deepEqual(posts(world).slice(before), [], "and no other message");
  const written = JSON.stringify([...world.slack.messages.values()].map((entry) => entry.blocks));
  assert.ok(!written.includes("previous session"), "the lost-task notification shows nothing");
  assert.equal(sessionId(world), id);
});

test("a process resumed with no prompt waiting tells of the lost task and nothing shows or waits", async (t) => {
  const world = worldOf(t);
  await running(world, "session-state-agent");
  await world.dispatch(reply("!stop", THREAD));
  await world.until(() => posts(world).includes(texts.STOPPED_THREAD));
  const id = sessionId(world);
  const session = world.sessions.get(CHANNEL, THREAD);
  assert.ok(session !== null && session !== undefined);
  // A daemon word connects the session with no turn; the recording's first part is all there is
  // (its notification and its empty result, without the prompt's turn).
  await session.ensureConnected();
  const lost = resumed([AGENT], id);
  world.clients[1]?.inject(lost.slice(0, lost.findIndex(isResult) + 1));
  const before = world.slack.apiCalls.length;
  await world.idle();
  await world.clock.advance(INJECTED_TURN_WAIT + 1);
  await world.idle();
  assert.equal(world.slack.streamTs.length, 1, "no reply for the empty turn");
  // Only the thread's activity line may move (the agent's own state words).
  const written = world.slack.apiCalls
    .slice(before)
    .map((call) => call.method)
    .filter((method) => method !== "assistant.threads.setStatus");
  assert.deepEqual(written, []);
  assert.equal(session.restartReady, true);
  assert.equal(session.reporting, false);
});

test("two tasks end with the process, and the resume tells of both without a line", async (t) => {
  const world = worldOf(t);
  const first = await running(world, "subagent-handback");
  await world.dispatch(reply("!stop", THREAD));
  await world.until(() => posts(world).includes(texts.STOPPED_THREAD));
  assert.deepEqual(first.stoppedTasks, []);
  assert.equal(first.connected, false);
  const id = sessionId(world);
  world.backend.script = () => ({ turns: [resumed(BOTH, id)] });
  const streams = world.slack.streamTs.length;
  await world.dispatch(reply("status?", THREAD));
  await world.until(() => world.slack.streamTs.length > streams);
  await world.until(() => standing(world, THREAD).includes("white_check_mark"));
  assert.equal(world.slack.streamTs.length, streams + 1);
  assert.deepEqual(world.clients[1]?.queries, ["status?"]);
});

test("a stop during a turn still interrupts it and stops its tasks one by one", async (t) => {
  const world = worldOf(t);
  const items = sdkMessages("session-state-agent");
  await world.dispatch(message("launch it", { ts: THREAD }));
  const client = world.clients[0];
  assert.ok(client !== undefined);
  const stopStream = items.findIndex(isResult);
  // The turn is still running: its result has not come.
  client.answer(items.slice(0, stopStream));
  await world.until(() => world.slack.streamTs.length > 0);
  await world.dispatch(reply("!stop", THREAD));
  await world.until(() => client.interrupts > 0);
  assert.equal(client.interrupts, 1);
  assert.equal(client.connected, true, "the process stays");
  assert.deepEqual(client.stoppedTasks, [AGENT], "its task is stopped by itself");
});

test("a restart's drain right after such a stop is not held", async (t) => {
  const world = worldOf(t);
  await running(world, "subagent-handback");
  await world.dispatch(reply("!stop", THREAD));
  await world.until(() => posts(world).includes(texts.STOPPED_THREAD));
  const session = world.sessions.get(CHANNEL, THREAD);
  assert.ok(session !== null && session !== undefined);
  assert.equal(session.restartReady, true);
  assert.equal(session.restartHold, "");
  await world.sessions.drain(new AbortController().signal);
});

test("a stop of the whole channel follows the same rule for each session", async (t) => {
  const world = worldOf(t);
  const first = await running(world, "session-state-agent");
  await world.dispatch(message("!stop", { ts: "1790019999.000100" }));
  await world.until(() => posts(world).includes(texts.STOPPED_CHANNEL));
  assert.equal(first.connected, false, "the process is closed");
  assert.deepEqual(first.stoppedTasks, []);
  assert.equal(first.interrupts, 0);
  assert.deepEqual(standing(world, THREAD), ["white_check_mark"]);
});

test("bypass and effort survive the stop and the resume", async (t) => {
  const world = worldOf(t);
  await running(world, "session-state-agent");
  world.state.setBypass(CHANNEL, THREAD, true);
  world.state.setEffort(CHANNEL, THREAD, "high");
  await world.dispatch(reply("!stop", THREAD));
  await world.until(() => posts(world).includes(texts.STOPPED_THREAD));
  const id = sessionId(world);
  world.backend.script = () => ({ turns: [resumed([AGENT], id)] });
  await world.dispatch(reply("go on", THREAD));
  await world.until(() => world.clients.length > 1);
  const second = world.clients[1];
  assert.ok(second !== undefined);
  assert.equal(second.options.effort, "high");
  assert.deepEqual(second.modes, ["bypassPermissions"]);
  assert.equal(world.state.thread(CHANNEL, THREAD)?.bypass, true);
});

/** The texts of the context blocks of every message: where the footer is. */
function contexts(world: World): string[] {
  return [...world.slack.messages.values()].flatMap((entry) =>
    entry.blocks.filter((block) => block.type === "context").map((block) => JSON.stringify(block)),
  );
}

test("a session object made after an idle close tells of the lost task and nothing shows", async (t) => {
  // Nothing is stored of the stop: a daemon that restarted, or an idle close, resumes with a
  // session object that never saw the task. The process's word on it is dropped all the same.
  const world = worldOf(t);
  await running(world, "session-state-agent");
  await world.dispatch(reply("!stop", THREAD));
  await world.until(() => posts(world).includes(texts.STOPPED_THREAD));
  const id = sessionId(world);
  const old = world.sessions.get(CHANNEL, THREAD);
  assert.ok(old !== null && old !== undefined);
  await old.close(texts.ENDED_IDLE);
  await world.idle();
  world.backend.script = () => ({ turns: [resumed([AGENT], id)] });
  const streams = world.slack.streamTs.length;
  const before = posts(world).length;
  await world.dispatch(reply("what now?", THREAD));
  await world.until(() => world.slack.streamTs.length > streams);
  await world.idle();
  await world.clock.advance(INJECTED_TURN_WAIT + 1);
  await world.idle();
  assert.notEqual(world.sessions.get(CHANNEL, THREAD), old, "a session object of its own");
  assert.deepEqual(world.clients[1]?.queries, ["what now?"]);
  assert.equal(world.slack.streamTs.length, streams + 1, "one new reply: the prompt's");
  assert.deepEqual(posts(world).slice(before), [], "and no push beside it");
  const written = JSON.stringify([...world.slack.messages.values()].map((entry) => entry.blocks));
  assert.ok(!written.includes("previous session"));
});

for (const aborted of [false, true]) {
  test(`an approval a background agent waits on goes with the stop (aborted by the close: ${aborted})`, async (t) => {
    const world = worldOf(t);
    const first = await running(world, "session-state-agent");
    const session = world.sessions.get(CHANNEL, THREAD);
    assert.ok(session !== null && session !== undefined);
    const abort = new AbortController();
    first.inject([requestWhileStreaming("Bash", { command: "rm -rf build" }, "toolu_bg_1", abort)]);
    await world.until(() => session.waitingForOwner);
    const buttons = () =>
      [...world.slack.messages.values()].filter(
        (entry) => !entry.deleted && JSON.stringify(entry.blocks).includes('"actions"'),
      ).length;
    assert.equal(buttons(), 1, "the request is on screen");
    await world.dispatch(reply("!stop", THREAD));
    await world.until(() => posts(world).includes(texts.STOPPED_THREAD));
    if (aborted) abort.abort(); // the SDK gives the request up when the process closes
    await world.idle();
    assert.equal(session.waitingForOwner, false);
    assert.equal(buttons(), 0, "no live button is left");
    assert.deepEqual(standing(world, THREAD), ["white_check_mark"], "and the root stays at ✅");
    assert.equal(session.restartReady, true);
  });
}

test("the footer a stop draws names the model and the context share", async (t) => {
  const world = worldOf(t);
  await running(world, "session-state-agent");
  await world.dispatch(reply("!stop", THREAD));
  await world.until(() => posts(world).includes(texts.STOPPED_THREAD));
  await world.idle();
  const footers = contexts(world).filter((block) => block.includes("ctx"));
  assert.equal(footers.length, 1, contexts(world).join("\n"));
  assert.match(footers[0] ?? "", /Haiku/);
});

test("no process resumes while the stop is still drawing the ends", async (t) => {
  const world = worldOf(t);
  await running(world, "subagent-handback");
  const id = sessionId(world);
  const session = world.sessions.get(CHANNEL, THREAD);
  assert.ok(session !== null && session !== undefined);
  const gate = new AsyncEvent();
  world.slack.gate = gate;
  world.slack.gateMethod = "chat.update";
  world.slack.gated = new AsyncEvent();
  world.backend.script = () => ({ turns: [] });
  const stopping = session.stop();
  await world.slack.gated.wait(); // a task's end is being written
  const connecting = session.ensureConnected();
  await world.idle();
  assert.equal(world.clients.length, 1, "the resume waits for the stop to finish drawing");
  world.slack.gate = null;
  gate.set();
  await stopping;
  await connecting;
  const lost = resumed(BOTH, id);
  world.clients[1]?.inject(lost.slice(0, lost.findIndex(isResult) + 1));
  await world.idle();
  await world.clock.advance(INJECTED_TURN_WAIT + 1);
  await world.idle();
  assert.equal(session.restartReady, true);
  assert.equal(session.runningKinds, "");
  assert.equal(world.slack.streamTs.length, 1);
});

test("a stop of the channel closes the processes of its sessions together", async (t) => {
  const world = worldOf(t);
  const firstClient = await running(world, "session-state-agent");
  await world.dispatch(message("and this", { ts: "1790019000.000100" }));
  const secondClient = world.clients[1];
  assert.ok(secondClient !== undefined);
  secondClient.answer(launching("session-state-agent"));
  await world.until(() => world.slack.callsTo("chat.stopStream").length > 1);
  const gate = new AsyncEvent();
  const entered: number[] = [];
  for (const [index, client] of [firstClient, secondClient].entries()) {
    const close = client.close.bind(client);
    client.close = async () => {
      entered.push(index);
      await gate.wait();
      await close();
    };
  }
  const stopping = world.dispatch(message("!stop", { ts: "1790019999.000100" }));
  await world.until(() => entered.length === 2);
  assert.deepEqual(entered.sort(), [0, 1], "the second close starts while the first waits");
  gate.set();
  await stopping;
  await world.until(() => posts(world).includes(texts.STOPPED_CHANNEL));
});

const EARLIER = { model: "claude-haiku-5-5", percentage: 5 };

test("a context read the CLI never answers does not hold the stop, the close or the lock", async (t) => {
  const world = worldOf(t);
  // No timeout on a control request in the SDK: neither the turn-end read nor the stop's answers.
  const first = await endedWithTask(world, () => new Promise(() => {}));
  const session = world.sessions.get(CHANNEL, THREAD);
  assert.ok(session !== null && session !== undefined);
  let stopped = false;
  void session.stop().then(() => {
    stopped = true;
  });
  await world.idle();
  assert.equal(stopped, true, "the stop returns");
  assert.equal(first.connected, false, "the process is closed");
  assert.deepEqual(standing(world, THREAD), ["white_check_mark"]);
  // No read ever answered: the footer has no model and no context, and nothing crashed.
  assert.equal(contexts(world).filter((block) => block.includes("ctx")).length, 0);
  await session.close();
  assert.equal(session.closed, true);
});

test("a stop whose read never answers draws the context an earlier footer read", async (t) => {
  const world = worldOf(t);
  const first = await running(world, "subagent-handback");
  const session = world.sessions.get(CHANNEL, THREAD);
  assert.ok(session !== null && session !== undefined);
  first.contextUsage = async () => EARLIER;
  await session.status(); // a live read: model and context are kept
  first.contextUsage = () => new Promise(() => {});
  await world.dispatch(reply("!stop", THREAD));
  await world.until(() => posts(world).includes(texts.STOPPED_THREAD));
  await world.idle();
  const footers = contexts(world).filter((block) => block.includes("ctx"));
  assert.equal(footers.length, 1, contexts(world).join("\n"));
  assert.match(footers[0] ?? "", /5%/);
  assert.match(footers[0] ?? "", /claude-haiku-5-5/);
});

test("a stop whose read answers draws that read, not the earlier one", async (t) => {
  const world = worldOf(t);
  const first = await running(world, "subagent-handback");
  const session = world.sessions.get(CHANNEL, THREAD);
  assert.ok(session !== null && session !== undefined);
  const fresh = first.contextUsage.bind(first);
  first.contextUsage = async () => EARLIER;
  await session.status();
  first.contextUsage = fresh;
  await world.dispatch(reply("!stop", THREAD));
  await world.until(() => posts(world).includes(texts.STOPPED_THREAD));
  await world.idle();
  const footers = contexts(world).filter((block) => block.includes("ctx"));
  assert.equal(footers.length, 1);
  assert.doesNotMatch(footers[0] ?? "", /5%/);
});

// A share read before a model switch or a compaction no longer holds: the stop's footer must not
// show it beside the new model or the compacted context.
for (const [what, event] of [
  ["a model switch", { type: "model_changed", model: "claude-opus-5-5" }],
  ["a compaction", { type: "compaction_started" }],
] as const) {
  test(`${what} after the last read leaves the stop's footer without its share`, async (t) => {
    const world = worldOf(t);
    const first = await running(world, "subagent-handback");
    const session = world.sessions.get(CHANNEL, THREAD);
    assert.ok(session !== null && session !== undefined);
    first.contextUsage = async () => EARLIER;
    await session.status(); // share 5%
    first.inject([{ event }]);
    await world.idle();
    first.contextUsage = () => new Promise(() => {});
    await world.dispatch(reply("!stop", THREAD));
    await world.until(() => posts(world).includes(texts.STOPPED_THREAD));
    await world.idle();
    const footers = contexts(world).filter((block) => block.includes("tok"));
    assert.ok(footers.length > 0, contexts(world).join("\n"));
    for (const footer of footers) assert.doesNotMatch(footer, /5%/);
  });
}

/** A thread whose turn left a background task running, the client's context read set before it ends. */
async function endedWithTask(
  world: World,
  read: () => Promise<{ model: string; percentage: number }>,
) {
  await world.dispatch(message("launch it", { ts: THREAD }));
  const first = world.clients[0];
  assert.ok(first !== undefined);
  first.contextUsage = read;
  first.answer(launching("subagent-handback"));
  await world.until(() => world.slack.callsTo("chat.stopStream").length > 0);
  return first;
}

test("the read made when a turn ends under background work feeds the footer of a later stop", async (t) => {
  const world = worldOf(t);
  let reads = 0;
  const first = await endedWithTask(world, async () => {
    reads += 1;
    return EARLIER;
  });
  await world.idle();
  assert.equal(reads, 1, "one control request for the turn, and no footer was drawn");
  first.contextUsage = () => new Promise(() => {}); // the stop's own read loses the race
  await world.dispatch(reply("!stop", THREAD));
  await world.until(() => posts(world).includes(texts.STOPPED_THREAD));
  await world.idle();
  const footers = contexts(world).filter((block) => block.includes("ctx"));
  assert.equal(footers.length, 1, contexts(world).join("\n"));
  assert.match(footers[0] ?? "", /5%/);
  assert.match(footers[0] ?? "", /claude-haiku-5-5/);
});

test("a model switch while the turn-end read is on its way voids it", async (t) => {
  const world = worldOf(t);
  let answer: (usage: typeof EARLIER) => void = () => {};
  const first = await endedWithTask(world, () => new Promise((resolve) => (answer = resolve)));
  await world.idle();
  first.inject([{ event: { type: "model_changed", model: "claude-opus-5-5" } }]);
  await world.idle();
  answer(EARLIER); // started before the switch: its share is the old model's
  await world.idle();
  first.contextUsage = () => new Promise(() => {});
  await world.dispatch(reply("!stop", THREAD));
  await world.until(() => posts(world).includes(texts.STOPPED_THREAD));
  await world.idle();
  const footers = contexts(world).filter((block) => block.includes("tok"));
  assert.ok(footers.length > 0, contexts(world).join("\n"));
  for (const footer of footers) assert.doesNotMatch(footer, /5%/);
});
