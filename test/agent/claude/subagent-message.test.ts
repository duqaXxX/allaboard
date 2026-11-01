/**
 * A background subagent's message to its parent while it runs (`SendMessage` to `main`), and its
 * hand-back, on the recordings `subagent-message-bypass` and `subagent-message-auto` (2026-11-01,
 * `@anthropic-ai/claude-agent-sdk` 0.3.316, Claude Code 2.1.316, Haiku, the daemon's options:
 * `claude_code` preset, `CLAUDE_CODE_FORK_SUBAGENT=1`, `replay-user-messages`, the three settings
 * layers). Issue #135: the terminal draws `Message from @<agent> (ctrl+o to expand)` for these.
 *
 * What the recordings hold: the message reaches the parent as a `user` record of origin kind
 * `peer` that names the subagent's task in `senderTaskId`, with the subagent's type as `name` and
 * the text as `body`. The translator turns it into `report_started`, as it does a hand-back, and
 * emits no `peer_message`: the text is not drawn by the thread, only the parent's answer to it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Translator } from "../../../src/agent/claude/translate.ts";
import type { SessionEvent } from "../../../src/agent/seam.ts";
import { type JsonObject, sdkRecords } from "../../support/fixtures.ts";
import { recordedEvents as events, eventsOf as of } from "../../support/replay.ts";

/** The peer records of a recording that name a task, with the events each is translated into. */
function fromSubagent(name: string): { origin: JsonObject; events: SessionEvent[] }[] {
  const translator = new Translator();
  return sdkRecords(name).flatMap((record) => {
    const translated = translator.translate(record);
    const origin = record.type === "user" ? record.origin : undefined;
    if (typeof origin !== "object" || origin === null || Array.isArray(origin)) return [];
    return origin.kind === "peer" ? [{ origin, events: translated }] : [];
  });
}

function agentTask(all: readonly SessionEvent[]): string {
  const started = of(all, "task_started").find((event) => event.taskType === "local_agent");
  assert.ok(started);
  return started.taskId;
}

test("bypass: a subagent's mid-run message names its task and starts a report, not a peer message", () => {
  const all = events("subagent-message-bypass");
  const task = agentTask(all);
  const peers = fromSubagent("subagent-message-bypass");
  assert.equal(peers.length, 1);
  const [message] = peers;
  assert.equal(message?.origin.senderTaskId, task);
  assert.equal(message?.origin.from, task);
  assert.equal(message?.origin.name, "general-purpose");
  assert.equal(message?.origin.body, "halfway there");
  assert.deepEqual(message?.events, [{ type: "report_started", taskId: task }]);
  assert.deepEqual(of(all, "peer_message"), []);
});

test("bypass: the message comes while the subagent runs, and no hand-back follows its end", () => {
  const all = events("subagent-message-bypass");
  const task = agentTask(all);
  const said = all.findIndex((event) => event.type === "report_started");
  const ended = all.findIndex((event) => event.type === "task_ended" && event.taskId === task);
  assert.ok(said > 0 && said < ended);
  // The only peer record of the stream is the message: the end is a notification alone, whose
  // summary is the agent's last words (the hand-back is an auto-mode form: the auto recording).
  assert.equal(of(all, "report_started").length, 1);
  const own = of(all, "task_ended").find((event) => event.taskId === task);
  assert.equal(own?.report, "finished");
  assert.equal(own?.reportSent, false);
});

test("bypass: the turn the message opens is the agent's, answered under the task", () => {
  const all = events("subagent-message-bypass");
  const at = all.findIndex((event) => event.type === "report_started");
  const ended = all.findIndex((event, index) => index > at && event.type === "turn_ended");
  const worded = all.findIndex((event, index) => index > at && event.type === "text_started");
  assert.ok(at < worded && worded < ended);
  assert.equal(of(all, "turn_ended")[1]?.startedBy, "agent");
});

test("auto: the mid-run message and the hand-back are both a peer record naming the task", () => {
  const all = events("subagent-message-auto");
  const task = agentTask(all);
  const peers = fromSubagent("subagent-message-auto");
  assert.equal(peers.length, 2);
  const [message, handback] = peers;
  assert.equal(message?.origin.senderTaskId, task);
  assert.equal(handback?.origin.senderTaskId, task);
  assert.equal(message?.origin.name, "general-purpose");
  assert.equal(handback?.origin.name, "general-purpose");
  assert.equal(message?.origin.body, "halfway there");
  assert.equal(message?.origin.handback, undefined);
  // The hand-back's body is the harness's frame around the report, and it says so in `handback`,
  // a field `sdk.d.ts` 0.3.316 does not declare and the translator does not read.
  assert.equal(handback?.origin.handback, true);
  assert.ok(String(handback?.origin.body).startsWith("[Subagent hand-back]"));
  assert.deepEqual(message?.events, [{ type: "report_started", taskId: task }]);
  assert.deepEqual(handback?.events, [{ type: "report_started", taskId: task }]);
  assert.deepEqual(of(all, "peer_message"), []);
});

test("auto: the message precedes the subagent's end and the hand-back follows it", () => {
  const all = events("subagent-message-auto");
  const task = agentTask(all);
  const reports = all.flatMap((event, index) => (event.type === "report_started" ? [index] : []));
  const ended = all.findIndex((event) => event.type === "task_ended" && event.taskId === task);
  assert.equal(reports.length, 2);
  assert.ok((reports[0] ?? Infinity) < ended && ended < (reports[1] ?? 0));
  const own = of(all, "task_ended").find((event) => event.taskId === task);
  assert.equal(own?.reportSent, true);
  assert.equal(own?.report?.includes("halfway there"), true);
});
