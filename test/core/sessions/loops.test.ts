/**
 * The scheduled jobs of a session (a loop): how a cron reads to the owner, what `!status` lists,
 * and the idle close that waits for them. The jobs reach the session through the Claude back
 * end's Stop hook, as `stop-hook-session-crons.json` carries them (written to `sdk.d.ts` 0.3.304,
 * after the sequence measured on CLI 2.1.302, 2026-10-19).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ScheduledJob } from "../../../src/agent/seam.ts";
import { APPROVE } from "../../../src/core/requests.ts";
import {
  IDLE_CLOSE_SECONDS,
  INJECTED_TURN_WAIT,
  LOOPS_BELIEVED_SECONDS,
} from "../../../src/core/sessions/constants.ts";
import { cadence, cadenceOf } from "../../../src/core/sessions/loops.ts";
import type { ThreadSession } from "../../../src/core/sessions/session.ts";
import { CHANNEL, THREAD } from "../../support/fake-slack.ts";
import { type JsonObject, sdkJson } from "../../support/fixtures.ts";
import type { Harness } from "../../support/sessions.ts";
import {
  canUseToolCall,
  END_OF_STREAM,
  event,
  harnessFor,
  hookRun,
  type Item,
  isResult,
  recordOf,
  sdkMessages,
  splitTurns,
} from "../../support/sessions.ts";
import { pending, play, send, splitBackground, withResult } from "./helpers.ts";

const WITH_JOB = sdkJson("stop-hook-session-crons") as JsonObject;
const WITHOUT_JOB = { ...WITH_JOB, session_crons: [] };

/** A recorded turn with the CLI's Stop hook call where the CLI makes it: before the result. */
function withStopHook(turn: readonly Item[], hookInput: JsonObject): Item[] {
  return [...turn.slice(0, -1), hookRun(hookInput), turn.at(-1) as Item];
}

test("a cron reads as the cadence a person would say", () => {
  const read: Record<string, string> = {
    "*/1 * * * *": "every minute",
    "* * * * *": "every minute",
    "*/5 * * * *": "every 5 minutes",
    "0 * * * *": "every hour",
    "0 */2 * * *": "every 2 hours",
    "0 */1 * * *": "every hour",
    "30 9 * * *": "every day at 09:30",
  };
  for (const [cron, words] of Object.entries(read)) assert.equal(cadence(cron), words, cron);
});

test("a cron with no plain reading is shown as written", () => {
  for (const cron of [
    "0 9 * * 1-5",
    "*/0 * * * *",
    "15 */3 * * *",
    "61 25 * * *",
    "soon",
    "* * *",
  ]) {
    assert.equal(cadence(cron), cron);
  }
});

test("a job that fires once says so", () => {
  const job: ScheduledJob = { id: "a", schedule: "30 9 * * *", recurring: false, prompt: "x" };
  assert.equal(cadenceOf(job), "once, every day at 09:30");
  assert.equal(cadenceOf({ ...job, recurring: true }), "every day at 09:30");
});

async function withLoop(t: Parameters<typeof harnessFor>[0]): Promise<[Harness, ThreadSession]> {
  const h = harnessFor(t)({
    turns: [
      withStopHook(sdkMessages("tools"), WITH_JOB),
      withStopHook(sdkMessages("tools"), WITHOUT_JOB),
    ],
  });
  const session = h.session();
  await (await session.submit("/loop 1m check the build")).done.wait();
  return [h, session];
}

test("the session keeps the jobs the agent lists, and !status names them", async (t) => {
  const [, session] = await withLoop(t);
  assert.deepEqual(session.scheduledJobs, [
    { id: "a1b2c3d4", schedule: "*/1 * * * *", recurring: true, prompt: "check the build" },
  ]);
  const status = await session.status();
  assert.ok(status.includes("\nLoop `every minute`: check the build"), status);
});

test("a long prompt is shortened to one line in !status", async (t) => {
  const prompt = `check\n${"the build and the deploy ".repeat(10)}`;
  const h = harnessFor(t)({
    turns: [
      withStopHook(sdkMessages("tools"), {
        ...WITH_JOB,
        session_crons: [{ id: "a", schedule: "*/5 * * * *", recurring: true, prompt }],
      }),
    ],
  });
  const session = h.session();
  await (await session.submit("/loop 5m go")).done.wait();
  const line = (await session.status()).split("\n").find((l) => l.startsWith("Loop "));
  // The prompt's own line break is a space, and the cut is marked.
  assert.ok(line?.startsWith("Loop `every 5 minutes`: check the build and"), line);
  assert.ok(line?.endsWith("…"), line);
});

test("an empty list from the agent removes the loop from !status", async (t) => {
  const [, session] = await withLoop(t);
  await (await session.submit("stop the loop")).done.wait();
  assert.deepEqual(session.scheduledJobs, []);
  assert.ok(!(await session.status()).includes("\nLoop "));
});

test("a session with a loop is not closed for being idle", async (t) => {
  const [h, session] = await withLoop(t);
  await h.until(() => session.idle);
  await h.idle();
  await h.clock.advance(IDLE_CLOSE_SECONDS * 3);
  assert.ok(!session.closed && h.clients[0]?.connected === true);
  // The last job goes: the session is idle for a whole delay from the report that said so.
  await (await session.submit("stop the loop")).done.wait();
  await h.until(() => session.idle);
  await h.idle();
  await h.clock.advance(IDLE_CLOSE_SECONDS);
  await h.until(() => session.closed, 1);
});

test("a list nobody renewed for a week no longer holds the session open", async (t) => {
  const [h, session] = await withLoop(t);
  await h.until(() => session.idle);
  await h.idle();
  // The agent drops a job after 7 days and says nothing when it does.
  await h.clock.advance(LOOPS_BELIEVED_SECONDS - 2 * IDLE_CLOSE_SECONDS);
  assert.ok(!session.closed && session.scheduledJobs.length === 1);
  await h.clock.advance(3 * IDLE_CLOSE_SECONDS);
  await h.until(() => session.closed, 1);
});

// ---- the runs and the loop card ---------------------------------------------------------------

/** A run as the CLI sends it: a turn with no prompt before it, then the Stop hook's list. */
function run(jobs: JsonObject[]): Item[] {
  return withStopHook(sdkMessages("tools"), { ...WITH_JOB, session_crons: jobs });
}

const JOB = { id: "a1b2c3d4", schedule: "*/1 * * * *", recurring: true, prompt: "check the build" };

/** The messages of the thread that carry the loop card or its end. */
function loopMessages(h: Harness): string[] {
  return h.slack
    .messageBlocks()
    .map((blocks) => JSON.stringify(blocks))
    .filter((shown) => shown.includes("Scheduled "));
}

/** How many messages the thread holds, the card and the end among them. */
function messageCount(h: Harness): number {
  return h.slack.createdTs.length;
}

test("runs share one message that the latest run rewrites, and open no reply of their own", async (t) => {
  const [h, session] = await withLoop(t);
  const replies = messageCount(h);
  const reactions = h.reactions().length;
  h.clients[0]?.inject(run([JOB]));
  await h.until(() => loopMessages(h).length === 1);
  assert.equal(messageCount(h), replies + 1, "the first run posts the card");
  assert.ok(loopMessages(h)[0]?.includes("Scheduled run · every minute · run 1"));
  h.clients[0]?.inject(run([JOB]));
  await h.until(() => loopMessages(h)[0]?.includes("run 2") === true);
  assert.equal(messageCount(h), replies + 1, "the next run edits the card");
  assert.equal(loopMessages(h).length, 1);
  assert.equal(h.reactions().length, reactions, "a run moves no status");
  assert.ok(session.scheduledJobs.length === 1);
});

test("a turn another session's message opens is no run of the loop", async (t) => {
  // Recorded on SDK 0.3.312 (`peer-message.jsonl`): the message opens the turn from idle.
  const [h] = await withLoop(t);
  const [, peer] = splitTurns(sdkMessages("peer-message")) as [Item[], Item[]];
  const replies = messageCount(h);
  h.clients[0]?.inject(peer);
  await h.until(() => messageCount(h) > replies || h.slack.callsTo("chat.startStream").length > 1);
  await h.idle();
  assert.deepEqual(loopMessages(h), []);
  assert.ok(JSON.stringify(h.slack.apiCalls).includes("From another session"));
});

/** The card's blocks as one JSON text, label and footer among them. */
function card(h: Harness): string {
  const [shown] = loopMessages(h);
  assert.ok(shown !== undefined, "the card is posted");
  return shown;
}

/** A run whose result reports `input` and `output` tokens, so one run's footer differs from the next. */
function runWithTokens(input: number, output: number): Item[] {
  const messages = sdkMessages("tools");
  const result = recordOf(messages.at(-1));
  assert.ok(result !== null && isResult(messages.at(-1)));
  const model = Object.keys(result.modelUsage as JsonObject)[0] as string;
  const trimmed = {
    record: { ...result, modelUsage: { [model]: { inputTokens: input, outputTokens: output } } },
  };
  return withStopHook([...messages.slice(0, -1), trimmed], { ...WITH_JOB, session_crons: [JOB] });
}

test("the card's label carries the time of the latest run, as the reply footer writes its own", async (t) => {
  const [h] = await withLoop(t);
  h.clients[0]?.inject(run([JOB]));
  await h.until(() => loopMessages(h).length === 1);
  assert.match(card(h), /Scheduled run · every minute · run 1 · <!date\^\d+\^\{time\}\|[^>]+>/);
});

test("the card carries the footer of the latest run, rewritten with it", async (t) => {
  const [h] = await withLoop(t);
  h.clients[0]?.inject(runWithTokens(1000, 500));
  await h.until(() => loopMessages(h).length === 1);
  await h.until(() => card(h).includes("1.5k *tok*"));
  assert.ok(card(h).includes('"type":"divider"'), "the footer stands under a divider");
  assert.ok(card(h).indexOf("run 1") < card(h).indexOf("1.5k *tok*"), "below the label");
  assert.match(card(h), /done <!date\^/, "with the run's own duration and end");
  h.clients[0]?.inject(runWithTokens(4100, 1000));
  await h.until(() => card(h).includes("run 2"));
  await h.until(() => card(h).includes("5.1k *tok*"));
  assert.ok(!card(h).includes("1.5k *tok*"), "the first run's footer is gone");
  assert.equal(loopMessages(h).length, 1);
});

test("a run whose list is empty at its end ends the loop with one message that counts the runs", async (t) => {
  const [h] = await withLoop(t);
  h.clients[0]?.inject(run([JOB]));
  await h.until(() => loopMessages(h).length === 1);
  h.clients[0]?.inject(run([]));
  await h.until(() => loopMessages(h).length === 2);
  const [card, ended] = loopMessages(h);
  assert.ok(card?.includes("run 2"), card);
  assert.ok(ended?.includes("Scheduled loop ended · 2 runs"), ended);
  // The next loop starts a card and a count anew.
});

const PAUSED = "Scheduled loop paused · 1 run: it resumes with your next message in this thread";

test("a session that closes with a loop running says the loop is paused, and forgets it", async (t) => {
  const [h, session] = await withLoop(t);
  h.clients[0]?.inject(run([JOB]));
  await h.until(() => loopMessages(h).length === 1);
  await session.close();
  assert.ok(loopMessages(h).at(-1)?.includes(PAUSED), loopMessages(h).at(-1));
  assert.equal(loopMessages(h).length, 2);
  assert.deepEqual(session.scheduledJobs, []);
});

test("a process that is lost while a loop runs pauses it and clears what !status lists", async (t) => {
  const [h, session] = await withLoop(t);
  h.clients[0]?.inject(run([JOB]));
  await h.until(() => loopMessages(h).length === 1);
  h.clients[0]?.inject([END_OF_STREAM]);
  await h.until(() => loopMessages(h).length === 2);
  assert.ok(loopMessages(h).at(-1)?.includes(PAUSED), loopMessages(h).at(-1));
  assert.deepEqual(session.scheduledJobs, []);
  assert.ok(!(await session.status()).includes("\nLoop "));
});

test("a task with no recurring job is said to stop with the session, which may restore it", async (t) => {
  const h = harnessFor(t)({
    turns: [
      withStopHook(sdkMessages("tools"), {
        ...WITH_JOB,
        session_crons: [{ ...JOB, recurring: false }],
      }),
    ],
  });
  const session = h.session();
  await (await session.submit("remind me in a minute")).done.wait();
  await session.close();
  const last = loopMessages(h).at(-1) ?? "";
  assert.ok(
    last.includes(
      "Scheduled task stopped with the session: Claude Code may restore it with your next message",
    ),
    last,
  );
  assert.ok(!last.includes("paused") && !last.includes("runs"), last);
});

test("the loop's end is said even when closing the lost run fails", async (t) => {
  const [h, session] = await withLoop(t);
  h.clients[0]?.inject(run([JOB]));
  await h.until(() => loopMessages(h).length === 1);
  const turn = run([JOB]);
  h.clients[0]?.inject(turn.slice(0, -1));
  await h.until(() => session.busy);
  const inner = session as unknown as { abandon: () => Promise<boolean> };
  t.mock.method(inner, "abandon", async () => {
    throw new Error("the chat refused");
  });
  h.clients[0]?.inject([END_OF_STREAM]);
  await h.until(() => loopMessages(h).some((shown) => shown.includes("paused")));
  assert.deepEqual(session.scheduledJobs, []);
});

test("a process lost during a run leaves the paused message last, with no second card", async (t) => {
  const [h, session] = await withLoop(t);
  h.clients[0]?.inject(run([JOB]));
  await h.until(() => loopMessages(h).length === 1);
  const turn = run([JOB]);
  h.clients[0]?.inject(turn.slice(0, -1)); // the second run has started
  await h.until(() => session.busy);
  h.clients[0]?.inject([END_OF_STREAM]);
  await h.until(() => loopMessages(h).some((shown) => shown.includes("paused")));
  await h.idle();
  const shown = loopMessages(h);
  assert.equal(shown.length, 2, "one card and the paused message");
  assert.ok(shown.at(-1)?.includes("paused · 2 runs"), shown.at(-1));
  assert.deepEqual(session.scheduledJobs, []);
});

test("a list that expired in silence ends the loop when the session closes", async (t) => {
  const [h, session] = await withLoop(t);
  h.clients[0]?.inject(run([JOB]));
  await h.until(() => loopMessages(h).length === 1);
  await h.idle();
  await h.clock.advance(LOOPS_BELIEVED_SECONDS + IDLE_CLOSE_SECONDS);
  await h.until(() => session.closed, 1);
  assert.ok(loopMessages(h).at(-1)?.includes("Scheduled loop ended · 1 run"));
});

test("a loop with no run shown is paused with no count", async (t) => {
  const [h, session] = await withLoop(t);
  await session.close();
  assert.ok(loopMessages(h).at(-1)?.includes("Scheduled loop paused: it resumes"));
});

test("a session with no loop says nothing when it closes", async (t) => {
  const h = harnessFor(t)({ turns: [sdkMessages("tools")] });
  const session = h.session();
  await (await session.submit("hi")).done.wait();
  await session.close();
  assert.equal(loopMessages(h).length, 0);
});

test("with several jobs a run is labelled without a cadence", async (t) => {
  const [h] = await withLoop(t);
  const two = [JOB, { ...JOB, id: "b", schedule: "0 * * * *", prompt: "other" }];
  h.clients[0]?.inject(run(two));
  await h.until(() => loopMessages(h).length === 1);
  // The first run still sees one job; the second sees two.
  h.clients[0]?.inject(run(two));
  await h.until(() => loopMessages(h)[0]?.includes("Scheduled run · run 2") === true);
});

test("a chat without the loop card shows a run as an ordinary reply", async (t) => {
  const [h] = await withLoop(t);
  (h.chat as { capabilities: unknown }).capabilities = { ...h.chat.capabilities, loopCard: false };
  const replies = messageCount(h);
  h.clients[0]?.inject(run([JOB]));
  await h.until(() => messageCount(h) === replies + 1);
  assert.equal(loopMessages(h).length, 0);
});

test("an owner prompt sent while a run is going is answered in a reply of its own", async (t) => {
  const h = harnessFor(t)({
    turns: [
      withStopHook(sdkMessages("tools"), WITH_JOB),
      withStopHook(sdkMessages("tools"), WITH_JOB),
    ],
  });
  const session = h.session();
  await (await session.submit("/loop 1m check the build")).done.wait();
  const turn = run([JOB]);
  h.clients[0]?.inject(turn.slice(0, -1)); // the run has started and has not ended
  await h.until(() => session.busy);
  const asked = await session.submit("and now this");
  h.clients[0]?.inject(turn.slice(-1));
  await asked.done.wait();
  await h.until(() => loopMessages(h).length === 1);
  assert.equal(messageCount(h), 3, "the setup's reply, the card and the owner's reply");
});

/** Claude Code's replay of a prompt: a user record of plain text carrying the prompt's uuid. */
function replay(uuid: string, text: string): Item {
  return {
    record: {
      type: "user",
      message: { role: "user", content: text },
      session_id: "68da9311-c5e1-4465-a7e5-75d74e30aaa4",
      parent_tool_use_id: null,
      uuid,
      timestamp: "2026-10-06T19:06:27.246Z",
      isReplay: true,
    },
  };
}

/** A session with a loop whose agent has no turn scripted beyond the setup's. */
async function looping(t: Parameters<typeof harnessFor>[0]): Promise<[Harness, ThreadSession]> {
  const h = harnessFor(t)({ turns: [withStopHook(sdkMessages("tools"), WITH_JOB)] });
  const session = h.session();
  await (await session.submit("/loop 1m check the build")).done.wait();
  return [h, session];
}

test("a prompt Claude Code folds into a running run is answered, in a reply the owner sees", async (t) => {
  const [h, session] = await looping(t);
  const turn = run([JOB]);
  h.clients[0]?.inject(turn.slice(0, -1));
  await h.until(() => session.busy);
  const asked = await send(h, session, "and now this");
  const id = h.clients[0]?.sent.at(-1)?.id ?? "";
  h.clients[0]?.inject([replay(id, "and now this"), ...turn.slice(-1)]);
  await h.until(() => session.idle);
  assert.equal(loopMessages(h).length, 0, "the owner's answer is not on the card");
  assert.equal(messageCount(h), 2, "the setup's reply and the owner's");
  assert.ok(asked.done.isSet);
});

test("a prompt Claude Code replays after a cron took its turn is an owner turn, not a run", async (t) => {
  const [h, session] = await looping(t);
  await send(h, session, "and now this");
  const id = h.clients[0]?.sent.at(-1)?.id ?? "";
  // The cron fires first and is taken for the prompt's turn; the prompt then runs in its own.
  h.clients[0]?.inject(run([JOB]));
  await h.until(() => session.idle);
  h.clients[0]?.inject([replay(id, "and now this"), ...run([JOB])]);
  await h.until(() => messageCount(h) === 3);
  await h.until(() => session.idle);
  assert.equal(loopMessages(h).length, 0, "the owner's real answer is an ordinary reply");
});

test("a run that asked for an approval leaves the root where a finished turn leaves it", async (t) => {
  const [h, session] = await looping(t);
  const done = h.reactions().at(-1);
  const count = h.reactions().length;
  h.clients[0]?.inject([canUseToolCall("Bash", { command: "ls" }), ...run([JOB])]);
  await h.until(() => pending(h.approvals).length > 0);
  h.approvals.resolve(pending(h.approvals)[0] ?? "", CHANNEL, THREAD, APPROVE);
  await h.until(() => loopMessages(h).length === 1);
  await h.until(() => session.idle);
  await h.idle();
  assert.ok(h.reactions().length > count, "the approval moved the root");
  assert.equal(h.reactions().at(-1), done);
});

/** A task the agent started in the background, as the session is told of it. */
function started(taskId: string): Item {
  return event({
    type: "task_started",
    taskId,
    kind: "command",
    taskType: "local_bash",
    description: "watch",
    callId: null,
    agentType: null,
    parentTaskId: null,
  } as never);
}

test("a turn that comes while a background task runs is not taken for a run", async (t) => {
  const [first] = splitBackground();
  const h = harnessFor(t)({ turns: [withStopHook(first, WITH_JOB)] });
  const session = h.session();
  await (await session.submit("/loop 1m start it")).done.wait();
  assert.ok(session.runningKinds !== "", "the task outlived its turn");
  h.clients[0]?.inject(run([JOB]));
  await h.until(() => h.replies().join("").includes("notes.txt"));
  assert.equal(loopMessages(h).length, 0);
});

test("a turn that comes after a report was given up on is not taken for a run", async (t) => {
  const [h, session] = await looping(t);
  h.clients[0]?.inject([
    started("t1"),
    event({
      type: "task_ended",
      taskId: "t1",
      status: "completed",
      summary: "",
      durationMs: null,
      callId: null,
      report: null,
      reportSent: false,
      foldNamed: false,
    }),
  ]);
  await h.until(() => session.runningKinds === "");
  await h.idle();
  await h.clock.advance(INJECTED_TURN_WAIT + 1);
  await h.idle();
  const before = messageCount(h);
  h.clients[0]?.inject(run([JOB]));
  await h.until(() => session.idle);
  assert.equal(loopMessages(h).length, 0);
  assert.ok(messageCount(h) >= before);
});

test("the card shows the run's final words, and the end of them when they are too long", async (t) => {
  const [h] = await looping(t);
  const words = `${"padding ".repeat(600)}THE END`;
  h.clients[0]?.inject(withResult(run([JOB]), words));
  await h.until(() => loopMessages(h).length === 1);
  const card = loopMessages(h)[0] ?? "";
  assert.ok(card.includes("THE END"), "the end is kept");
  assert.ok(!card.includes("notes.txt"), "the final words, not the first message's");
});

test("a long run with its footer stays within what a message holds", async (t) => {
  const [h] = await looping(t);
  const words = `${"padding ".repeat(2000)}THE END`;
  h.clients[0]?.inject(withResult(run([JOB]), words));
  await h.until(() => (loopMessages(h)[0] ?? "").includes("*tok*"));
  const blocks =
    h.slack.messageBlocks().find((b) => JSON.stringify(b).includes("Scheduled ")) ?? [];
  const kinds = blocks.map((b) => b.type);
  assert.deepEqual(kinds, ["context", "markdown", "divider", "context"]);
  const markdown = blocks.reduce(
    (n, b) => n + (b.type === "markdown" ? String(b.text).length : 0),
    0,
  );
  assert.ok(markdown <= 3000, `${markdown} characters of words`);
  for (const b of blocks.filter((x) => x.type === "context")) {
    const [element] = b.elements as JsonObject[];
    assert.ok(String(element?.text).length <= 3000);
  }
  assert.ok(JSON.stringify(blocks).includes("THE END"), "the end of the words is kept");
});

test("the end of a loop is said after the turn that deleted it, not in the middle of it", async (t) => {
  const h = harnessFor(t)({
    turns: [
      withStopHook(sdkMessages("tools"), WITH_JOB),
      withStopHook(sdkMessages("tools"), WITHOUT_JOB),
    ],
  });
  const session = h.session();
  await (await session.submit("/loop 1m check the build")).done.wait();
  h.clients[0]?.inject(run([JOB]));
  await h.until(() => loopMessages(h).length === 1);
  const busyWhenEnded: boolean[] = [];
  const thread = session.threadChat;
  const endLoop = thread.endLoop.bind(thread);
  thread.endLoop = (line: string) => {
    busyWhenEnded.push(session.busy);
    return endLoop(line);
  };
  await (await session.submit("stop the loop")).done.wait();
  await h.until(() => loopMessages(h).length === 2);
  assert.deepEqual(busyWhenEnded, [false]);
});

test("a run's background task reports on the card, with no message of its own", async (t) => {
  const [h, session] = await looping(t);
  const [first, notice, injected] = splitBackground();
  const replies = messageCount(h);
  h.clients[0]?.inject(withStopHook(first, { ...WITH_JOB, session_crons: [JOB] }));
  await h.until(() => loopMessages(h).length === 1);
  await h.until(() => !session.busy);
  assert.ok(session.runningKinds !== "", "the run's task outlived the run");
  h.clients[0]?.inject(notice);
  h.clients[0]?.inject(withResult(injected, "THE REPORT"));
  await h.until(() => card(h).includes("THE REPORT"));
  await h.until(() => session.idle);
  await h.idle();
  assert.equal(messageCount(h), replies + 1, "the report rewrites the card");
  assert.ok(card(h).includes("run 1"), "under the run it belongs to");
  assert.ok(!card(h).includes("Running in background"), "the run's launch line is gone");
  assert.equal(
    h.replies().filter((text) => text.includes("THE REPORT")).length,
    1,
    "the card alone",
  );
});

test("a run's report that comes after a message of the owner's is an ordinary reply, and leaves the card as it was", async (t) => {
  const [h, session] = await looping(t);
  const [first, notice, injected] = splitBackground();
  h.clients[0]?.inject(withStopHook(first, { ...WITH_JOB, session_crons: [JOB] }));
  await h.until(() => loopMessages(h).length === 1);
  await h.until(() => !session.busy);
  const shown = card(h);
  // Sent while the run's task runs: the message stands below the card, and the agent takes it
  // into its report.
  const asked = await send(h, session, "and now this");
  const id = h.clients[0]?.sent.at(-1)?.id ?? "";
  h.clients[0]?.inject(notice);
  const report = withResult(injected, "THE REPORT");
  h.clients[0]?.inject([...report.slice(0, -1), replay(id, "and now this"), ...report.slice(-1)]);
  await h.until(() => asked.done.isSet);
  await h.until(() => h.replies().some((text) => text.includes("took your message")));
  await h.idle();
  assert.equal(card(h), shown, "the card keeps the run's words");
  await session.close();
  assert.ok(
    (loopMessages(h)[1] ?? "").includes("Scheduled loop paused · 1 run"),
    "the run still counts",
  );
});

test("a run's report that comes after an exchange with the owner is an ordinary reply below it", async (t) => {
  const [h, session] = await looping(t);
  const [first, notice, injected] = splitBackground();
  h.clients[0]?.inject(withStopHook(first, { ...WITH_JOB, session_crons: [JOB] }));
  await h.until(() => loopMessages(h).length === 1);
  await h.until(() => !session.busy);
  const shown = card(h);
  const asked = await send(h, session, "and now this");
  play(h, withStopHook(sdkMessages("tools"), { ...WITH_JOB, session_crons: [JOB] }));
  await asked.done.wait();
  const before = messageCount(h);
  h.clients[0]?.inject(notice);
  h.clients[0]?.inject(withResult(injected, "THE REPORT"));
  await h.until(() => messageCount(h) === before + 1);
  await h.until(() => !session.busy);
  await h.idle();
  assert.equal(card(h), shown, "the card above the exchange keeps the run's words");
});
