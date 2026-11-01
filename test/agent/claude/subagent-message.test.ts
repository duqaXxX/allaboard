/**
 * A background subagent's message to its parent while it runs (`SendMessage` to `main`), and its
 * hand-back, on the recordings `subagent-message-bypass` and `subagent-message-auto` (2026-11-01,
 * `@anthropic-ai/claude-agent-sdk` 0.3.316, Claude Code 2.1.316, Haiku, the daemon's options:
 * `claude_code` preset, `CLAUDE_CODE_FORK_SUBAGENT=1`, `replay-user-messages`, the three settings
 * layers). Issue #135: the terminal draws `Message from @<agent> (ctrl+o to expand)` for these.
 *
 * What the recordings hold: the message reaches the parent as a `user` record of origin kind
 * `peer` that names the subagent's task in `senderTaskId`, with the subagent's type as `name` and
 * the text as `body`. The translator turns it into `report_started` (the parent's answer goes
 * under the task, as for a hand-back) and `subagent_message`, which the reply draws as a line
 * (owner's decision 2026-11-01). It emits no `peer_message`. A hand-back, told apart by
 * `origin.handback` (measured on 2.1.316, declared nowhere), gets `report_started` alone.
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
  assert.deepEqual(message?.events, [
    { type: "report_started", taskId: task },
    { type: "subagent_message", from: "general-purpose", text: "halfway there" },
  ]);
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
  assert.deepEqual(message?.events, [
    { type: "report_started", taskId: task },
    { type: "subagent_message", from: "general-purpose", text: "halfway there" },
  ]);
  // The hand-back keeps drawing what it did: the report turn under the task, no message line.
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

test("auto: one line is drawn for the stream, the hand-back's none", () => {
  assert.equal(of(events("subagent-message-auto"), "subagent_message").length, 1);
  assert.equal(of(events("subagent-message-bypass"), "subagent_message").length, 1);
});

test("the 2.1.296 hand-back recording carries the handback flag too, and draws no line", () => {
  // Recorded on Claude Code 2.1.296: the flag is there, so the flag is not new to 2.1.316.
  const peer = sdkRecords("subagent-handback").find(
    (r) => r.type === "user" && typeof r.origin === "object" && r.origin !== null,
  );
  assert.ok(peer);
  assert.equal((peer.origin as JsonObject).handback, true);
  assert.deepEqual(of(events("subagent-handback"), "subagent_message"), []);
  assert.equal(of(events("subagent-handback"), "report_started").length, 1);
});

/** The auto recording's records, `change` applied to the list. */
function autoWith(change: (records: JsonObject[]) => JsonObject[]): SessionEvent[] {
  const translator = new Translator();
  return change([...sdkRecords("subagent-message-auto")]).flatMap((r) => translator.translate(r));
}

const isHandback = (record: JsonObject): boolean =>
  record.type === "user" &&
  typeof record.origin === "object" &&
  record.origin !== null &&
  (record.origin as JsonObject).handback === true;

test("a hand-back that comes before its subagent's notification draws no line", () => {
  const all = autoWith((records) => {
    const at = records.findIndex(isHandback);
    const note = records.findIndex(
      (r) => r.type === "system" && r.subtype === "task_notification" && "handback_report" in r,
    );
    assert.ok(note < at);
    const [hand] = records.splice(at, 1);
    records.splice(note, 0, hand as JsonObject);
    return records;
  });
  assert.deepEqual(
    of(all, "subagent_message").map((event) => event.text),
    ["halfway there"],
  );
});

test("a hand-back with an empty report draws no line", () => {
  const all = autoWith((records) =>
    records.map((r) => {
      if (r.type === "system" && "handback_report" in r) return { ...r, handback_report: {} };
      return isHandback(r)
        ? { ...r, origin: { ...(r.origin as JsonObject), handbackReportText: "" } }
        : r;
    }),
  );
  assert.deepEqual(
    of(all, "subagent_message").map((event) => event.text),
    ["halfway there"],
  );
});

test("a message, the end's notification, then the hand-back: the message is drawn, not the frame", () => {
  const all = events("subagent-message-auto");
  const task = agentTask(all);
  const kinds = all.flatMap((event, index) =>
    event.type === "subagent_message" ||
    event.type === "report_started" ||
    (event.type === "task_ended" && event.taskId === task)
      ? [event.type]
      : [],
  );
  assert.deepEqual(kinds, ["report_started", "subagent_message", "task_ended", "report_started"]);
});

/** The mid-run record of the bypass recording with its origin changed. */
function withOrigin(change: (origin: JsonObject) => void): SessionEvent[] {
  const translator = new Translator();
  let out: SessionEvent[] = [];
  for (const record of sdkRecords("subagent-message-bypass")) {
    const origin = record.type === "user" ? record.origin : undefined;
    const peer = typeof origin === "object" && origin !== null && !Array.isArray(origin);
    if (peer && origin.kind === "peer") {
      const changed = { ...origin };
      change(changed);
      out = translator.translate({ ...record, origin: changed });
    } else translator.translate(record);
  }
  return out;
}

test("a message with no name or no text draws no line, and still starts the report", () => {
  const task = agentTask(events("subagent-message-bypass"));
  const report = [{ type: "report_started", taskId: task }];
  assert.deepEqual(
    withOrigin((o) => delete o.name),
    report,
  );
  assert.deepEqual(
    withOrigin((o) => (o.name = "")),
    report,
  );
  assert.deepEqual(
    withOrigin((o) => delete o.body),
    report,
  );
  assert.deepEqual(
    withOrigin((o) => (o.body = "")),
    report,
  );
});
