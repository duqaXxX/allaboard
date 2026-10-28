/**
 * The core draws whatever vocabulary an agent declares: the plain agent's `run` and `change`
 * tools (`test/support/plain-agent.ts`) take the terminal's words and previews with no name of
 * a real agent anywhere in the core.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileChange, SessionEvent } from "../../../src/agent/seam.ts";
import { NO_TOOL_WORDS } from "../../../src/agent/seam.ts";
import type { TaskUpdate } from "../../../src/chat/seam.ts";
import { Fold } from "../../../src/core/reply/fold.ts";
import { Previews } from "../../../src/core/reply/previews.ts";
import { type Sink, TurnRenderer } from "../../../src/core/reply/renderer.ts";
import { PLAIN_NAMES } from "../../support/names.ts";
import { PLAIN_TOOLS } from "../../support/plain-agent.ts";

const PLAIN = new Previews(PLAIN_TOOLS);

class Recording implements Sink {
  tasks: TaskUpdate[] = [];
  async text(): Promise<void> {}
  async task(update: TaskUpdate): Promise<void> {
    this.tasks.push(update);
  }
  async finish(): Promise<void> {}
  async closeOut(): Promise<boolean> {
    return true;
  }
  async waitLanded(): Promise<boolean> {
    return true;
  }
  async settle(): Promise<boolean> {
    return true;
  }
}

const CHANGE: FileChange = {
  path: "/work/notes/a.txt",
  kind: "edited",
  hunks: [{ oldStart: 1, newStart: 1, lines: ["-one", "+two"] }],
  content: null,
};

function started(callId: string, toolName: string, input: Record<string, unknown>): SessionEvent {
  return { type: "call_started", callId, toolName, input, parentCallId: null };
}

function ended(callId: string, fileChange: FileChange | null = null): SessionEvent {
  return {
    type: "call_ended",
    callId,
    isError: false,
    output: "done",
    fileChange,
    model: null,
    parentCallId: null,
  };
}

async function drawn(events: readonly SessionEvent[]): Promise<Recording> {
  const sink = new Recording();
  const renderer = new TurnRenderer(sink, PLAIN_NAMES, PLAIN, "/work/notes");
  for (const event of events) await renderer.feed(event);
  await renderer.close();
  return sink;
}

test("a declared tool is titled by its declared input and timed, as the terminal times a command", async () => {
  const sink = await drawn([started("c1", "run", { summary: "Build it", line: "make all" })]);
  const [first] = sink.tasks;
  assert.equal(first?.title, "Build it");
  assert.equal(first?.details, "$ make all");
  assert.equal(first?.name, "run");
});

test("a declared previewed tool shows its change under the declared title", async () => {
  const sink = await drawn([started("c1", "change", {}), ended("c1", CHANGE)]);
  const last = sink.tasks.at(-1);
  assert.equal(last?.preview?.title, "Modify(a.txt)");
  assert.equal(last?.preview?.language, "diff");
  // The call is held until it ends: nothing was drawn while it ran.
  assert.equal(sink.tasks.length, 1);
});

test("a created file takes the new-file preview under the tool's own name", async () => {
  const created: FileChange = {
    path: "/work/notes/b.txt",
    kind: "created",
    hunks: [],
    content: "x\n",
  };
  const sink = await drawn([started("c1", "change", {}), ended("c1", created)]);
  assert.equal(sink.tasks.at(-1)?.preview?.title, "change(b.txt)");
});

test("a tool the vocabulary does not name stays generic", async () => {
  const sink = await drawn([started("c1", "Edit", {}), ended("c1", CHANGE)]);
  assert.equal(sink.tasks.at(-1)?.preview, null);
  assert.equal(sink.tasks.at(-1)?.status, "complete");
});

function line(id: string, name: string, status: TaskUpdate["status"]): TaskUpdate {
  return {
    id,
    title: id,
    status,
    details: null,
    output: null,
    name,
    task: false,
    message: false,
    calls: 0,
    preview: null,
    folded: null,
    startedAt: null,
  };
}

test("finished calls of a declared tool fold into its declared words", () => {
  const fold = new Fold(PLAIN);
  fold.task(line("a", "run", "complete"));
  const [card] = fold.task(line("b", "run", "complete"));
  assert.equal(card?.title, "Executed 2 jobs");
  const [other] = new Fold(PLAIN).task(line("a", "Bash", "complete"));
  assert.equal(other?.title, "Bash");
});

test("a failed call is counted only for a tool that declares it", () => {
  assert.ok(PLAIN.failsCounted("run"));
  assert.ok(!PLAIN.failsCounted("change"));
  assert.ok(!PLAIN.failsCounted("Bash"));
});

test("an agent that declares no plan tool has no plan", () => {
  assert.equal(new Previews(NO_TOOL_WORDS).plan("propose", { steps: "x" }), null);
});

test("the plan is read from the input key the agent declares", () => {
  assert.equal(PLAIN.plan("propose", { steps: " 1. look\n2. change \n" }), "1. look\n2. change");
  // A key of another agent's vocabulary is no plan here.
  assert.equal(PLAIN.plan("propose", { plan: "x" }), null);
  // An input holding a key beyond the measured ones is shown whole.
  assert.equal(PLAIN.plan("propose", { steps: "x", hidden: "y" }), null);
});
