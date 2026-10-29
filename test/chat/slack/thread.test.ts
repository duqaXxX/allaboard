/**
 * What `SlackThread` adds to the parts it composes: the wiring between a reply, a notice and
 * the thread's status line, the seam's statuses as reactions, a request as a message the core
 * can name, and a failed call as a `ChatError`. The sink, the reaction, the status line and
 * the request blocks have their own tests.
 */
import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import type { QuestionRequest } from "../../../src/agent/seam.ts";
import {
  type ApprovalRequest,
  ChatError,
  type OwnerRequest,
  type SessionStatus,
} from "../../../src/chat/seam.ts";
import type { ChannelLine, LineKind } from "../../../src/chat/slack/channel-line.ts";
import type { Limiter } from "../../../src/chat/slack/reply/limiter.ts";
import type { ReplySink } from "../../../src/chat/slack/reply/sinks.ts";
import {
  resetStatusFlags,
  logger as statusLogger,
  THREAD_STATUS_AFTER_WRITE_SECONDS,
  THREAD_STATUS_REFRESH_SECONDS,
} from "../../../src/chat/slack/reply/status.ts";
import {
  answeredBlocks,
  approvalBlocks,
  questionBlocks,
} from "../../../src/chat/slack/requests.ts";
import type { RootEditor } from "../../../src/chat/slack/tag.ts";
import { logger, SlackChat, type SlackThread } from "../../../src/chat/slack/thread.ts";
import * as texts from "../../../src/core/texts.ts";
import { named } from "../../../src/core/texts.ts";
import {
  AGENT,
  BOT,
  CHANNEL,
  FakeClock,
  FakeSlack,
  OTHER_THREAD,
  OWNER,
  rejected,
  TEAM,
  THREAD,
} from "../../support/fake-slack.ts";
import { PLAIN_NAMES } from "../../support/names.ts";

beforeEach(() => resetStatusFlags());

class CountingLimiter implements Limiter {
  acquired = 0;
  /** The Slack calls made before each token was taken. */
  readonly before: number[] = [];
  readonly #slack: FakeSlack;

  constructor(slack: FakeSlack) {
    this.#slack = slack;
  }

  async acquire(): Promise<void> {
    this.acquired += 1;
    this.before.push(this.#slack.apiCalls.length);
  }

  async refund(): Promise<void> {}
}

interface Made {
  readonly slack: FakeSlack;
  readonly clock: FakeClock;
  readonly limiter: CountingLimiter;
  readonly chat: SlackChat;
  readonly thread: SlackThread;
}

function made(
  options: { replies?: FakeSlack; line?: ChannelLine; mentionOwner?: boolean } = {},
): Made {
  const slack = new FakeSlack();
  const clock = new FakeClock();
  const limiter = new CountingLimiter(slack);
  const chat = new SlackChat({
    slack,
    // The tests that do not look at which client a reply is written with share one fake.
    replies: options.replies ?? slack,
    identity: { teamId: TEAM, ownerUserId: OWNER, botUserId: BOT },
    agent: () => AGENT,
    limiter,
    clock,
    ...(options.line !== undefined && { line: options.line }),
    ...(options.mentionOwner !== undefined && { mentionOwner: options.mentionOwner }),
  });
  return { slack, clock, limiter, chat, thread: chat.thread({ channel: CHANNEL, thread: THREAD }) };
}

/** Let what is ready run: the status line's own task, a reaction asked for and not awaited. */
async function settle(clock: FakeClock): Promise<void> {
  await clock.advance(0);
}

const PERMISSION: ApprovalRequest = {
  type: "permission",
  callId: "toolu_1",
  toolName: "Bash",
  input: { command: "ls <here> & there" },
  title: null,
  description: null,
  plan: null,
};

const QUESTION: QuestionRequest = {
  type: "question",
  callId: "toolu_2",
  toolName: "AskUserQuestion",
  title: null,
  questions: [
    {
      header: "Colour",
      text: "Which colour?",
      multiSelect: false,
      options: [
        { label: "Red", description: null, preview: null },
        { label: "Blue", description: null, preview: null },
      ],
    },
  ],
};

test("each status of a session is one reaction on the threads root", async () => {
  const { slack, thread } = made();
  const shown: Array<[SessionStatus, string]> = [
    ["working", "hourglass_flowing_sand"],
    ["waiting", "raised_hand"],
    ["done", "white_check_mark"],
    ["error", "x"],
  ];
  for (const [status] of shown) await thread.showStatus(status);
  const added = slack.callsTo("reactions.add");
  assert.deepEqual(
    added.map((args) => [args.channel, args.timestamp, args.name]),
    shown.map(([, name]) => [CHANNEL, THREAD, name]),
  );
  await thread.clearStatus();
  assert.equal(slack.callsTo("reactions.remove").at(-1)?.name, "x");
  // Nothing is asked for and nothing shows: settling makes no call.
  const before = slack.apiCalls.length;
  await thread.settleStatus();
  assert.equal(slack.apiCalls.length, before);
});

test("a reply is written in the thread to the owner and names its open message", async () => {
  const replies = new FakeSlack();
  const { slack, thread } = made({ replies });
  const changes: Array<[string | null, string | null]> = [];
  const reply = thread.openReply((old, fresh) => changes.push([old, fresh]));
  await reply.text("hello");
  await reply.finish([]);
  const [start] = replies.callsTo("chat.startStream");
  assert.equal(start?.channel, CHANNEL);
  assert.equal(start?.thread_ts, THREAD);
  assert.equal(start?.recipient_team_id, TEAM);
  assert.equal(start?.recipient_user_id, OWNER);
  assert.deepEqual(changes, [[null, replies.streamTs[0]]]); // what a crash would leave unfinished
  assert.equal(await reply.closeOut(), true);
  assert.deepEqual(changes.at(-1), [replies.streamTs[0], null]);
  assert.deepEqual(slack.streamTs, []); // the client made for replies wrote it, and no other
});

test("a write of a reply sets the thread status again", async () => {
  const { slack, clock, thread } = made();
  thread.showActivity({ kind: "working" });
  await settle(clock);
  assert.equal(slack.callsTo("assistant.threads.setStatus").length, 1);
  const reply = thread.openReply(() => {});
  await reply.text("hello");
  await reply.finish([]); // Slack clears a thread's status when the app replies
  await clock.advance(THREAD_STATUS_AFTER_WRITE_SECONDS);
  const [, again, ...more] = slack.callsTo("assistant.threads.setStatus");
  assert.equal(more.length, 0);
  assert.deepEqual(again, {
    channel_id: CHANNEL,
    thread_ts: THREAD,
    status: "is working…",
    loading_messages: ["Working…"],
  });
  await thread.close();
  assert.equal(slack.callsTo("assistant.threads.setStatus").at(-1)?.status, "");
});

/** A line that records which threads it was asked to name, and by which root texts. */
function recordingLine(): {
  line: ChannelLine;
  shown: [string, string, LineKind][];
  opened: (string | undefined)[];
  retitled: [string, string, string][];
  withdrawn: [string, string, string][];
} {
  const shown: [string, string, LineKind][] = [];
  const opened: (string | undefined)[] = [];
  const retitled: [string, string, string][] = [];
  const withdrawn: [string, string, string][] = [];
  const line = {
    show: async (channel: string, root: string, kind: LineKind, message?: string) => {
      shown.push([channel, root, kind]);
      opened.push(message);
    },
    retitle: async (channel: string, root: string, text: string) =>
      void retitled.push([channel, root, text]),
    withdrawn: async (channel: string, root: string, message: string) =>
      void withdrawn.push([channel, root, message]),
    refresh: async () => {},
  };
  return {
    line: line as unknown as ChannelLine,
    shown,
    opened,
    retitled,
    withdrawn,
  };
}

/** A provider with a root editor whose title edit `edit` stands for. */
function titling(line: ChannelLine, edit: (chat: SlackChat) => Promise<string>): SlackChat {
  const slack = new FakeSlack();
  const chat: SlackChat = new SlackChat({
    slack,
    replies: slack,
    identity: { teamId: TEAM, ownerUserId: OWNER, botUserId: BOT },
    agent: () => AGENT,
    limiter: new CountingLimiter(slack),
    clock: new FakeClock(),
    roots: { title: () => edit(chat) } as unknown as RootEditor,
    line,
  });
  return chat;
}

// #43: the channel's line names a thread as its root shows it, so a title the root got after
// the line was posted reaches the line too.
test("a title written on the root is passed to the channel's line", async () => {
  const { line, retitled } = recordingLine();
  const chat = titling(line, async () => "`[web]` *Footer fix*");
  await chat.titleThread?.({ channel: CHANNEL, thread: THREAD }, "Footer fix");
  // The root's text as the edit left it, so the line names the thread as the root reads.
  assert.deepEqual(retitled, [[CHANNEL, THREAD, "`[web]` *Footer fix*"]]);
});

test("a title written once the daemon is stopping never reaches the channel's line", async () => {
  const { line, retitled } = recordingLine();
  const chat = titling(line, async (chat) => {
    chat.halt();
    return "*Footer fix*";
  });
  await chat.titleThread?.({ channel: CHANNEL, thread: THREAD }, "Footer fix");
  assert.deepEqual(retitled, []);
});

test("a title the root refused never reaches the channel's line", async () => {
  const { line, retitled } = recordingLine();
  const chat = titling(line, async () => {
    throw new ChatError("thread_not_found", { permanent: true });
  });
  await assert.rejects(
    chat.titleThread?.({ channel: CHANNEL, thread: THREAD }, "Footer fix") ?? Promise.resolve(),
  );
  assert.deepEqual(retitled, []);
});

for (const [status, kind] of [
  ["done", "done"],
  ["error", "failed"],
] as const) {
  test(`the end of the work moves the channel's line, its footer does not [${status}]`, async () => {
    const { line, shown } = recordingLine();
    const { thread } = made({ line });
    const reply = thread.openReply(() => {});
    await reply.text("hello");
    await reply.finish([]);
    await reply.closeOut();
    // A stop's ✅, or a ❌ the owner was told of already: the core asks for no notice.
    await thread.showStatus(status);
    // The footer's own drawing has its tests in the sink's: here, only that one was written.
    const sink = reply as unknown as ReplySink;
    assert.equal(await sink.showFooterFormatted("main · ctx 6%"), true);
    assert.deepEqual(shown, []);
    await thread.showStatus(status, { notify: true });
    assert.deepEqual(shown, [[CHANNEL, THREAD, kind]]);
  });
}

// #88: between the posts that tell the owner, the line follows `state.json` (`refresh`), never
// a status the thread is shown.
test("a status that tells the owner nothing moves no line", async () => {
  const { line, shown } = recordingLine();
  const { thread } = made({ line });
  for (const status of ["working", "waiting", "restarting", "done", "error"] as const) {
    await thread.showStatus(status);
  }
  assert.deepEqual(shown, []);
});

/** Lets the writes started and not awaited (`void`) run to their end. */
async function drained(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await new Promise((done) => setImmediate(done));
}

// #88: a push from the thread opens the thread, one from the channel the channel (measured
// 2026-10-26, iOS): the thread tells the owner, by an edit of the reply's last message that adds
// his mention to its `text` alone, the same blocks written again.
test("the end of the work mentions the owner on the reply's last message when asked", async () => {
  for (const mentionOwner of [true, false]) {
    const { line, shown } = recordingLine();
    const { slack, thread } = made({ line, mentionOwner });
    const reply = thread.openReply(() => {});
    await reply.text("hello");
    await reply.finish([]);
    await reply.closeOut();
    const before = slack.callsTo("chat.update").length;
    const blocks = (slack.callsTo("chat.update").at(-1) ?? slack.callsTo("chat.stopStream").at(-1))
      ?.blocks;
    await thread.showStatus("working", { notify: true }); // no end: nothing told
    await thread.showStatus("done", { notify: true });
    await drained();
    assert.deepEqual(shown, [[CHANNEL, THREAD, "done"]]);
    const told = slack.callsTo("chat.update").slice(before);
    if (!mentionOwner) {
      assert.deepEqual(told, []);
      continue;
    }
    assert.equal(told.length, 1);
    assert.ok(String(told[0]?.text).endsWith(`<@${OWNER}>`), String(told[0]?.text));
    if (blocks !== undefined) assert.ok(JSON.stringify(told[0]?.blocks).includes("hello"));
    assert.equal(slack.callsTo("chat.postMessage").filter((c) => c.thread_ts).length, 0);
    // Told once: the next edit of the message writes its words alone.
    const sink = reply as unknown as ReplySink;
    assert.equal(await sink.showFooterFormatted("main · ctx 6%"), true);
    assert.ok(!String(slack.callsTo("chat.update").at(-1)?.text).includes("<@"));
  }
});

test("an end told before the reply's own end is carried by the reply's end, once", async () => {
  const { slack, thread } = made({ mentionOwner: true });
  const reply = thread.openReply(() => {});
  await reply.text("hello");
  await reply.finish([]);
  await thread.showStatus("done", { notify: true }); // the stream is still open
  await drained();
  await reply.closeOut();
  await drained();
  const told = [...slack.callsTo("chat.update"), ...slack.callsTo("chat.postMessage")].filter(
    (call) => String(call.text).includes(`<@${OWNER}>`),
  );
  assert.equal(told.length, 1);
  assert.equal(told[0]?.ts, slack.createdTs[0]); // the reply's own message, not a line of its own
});

test("with no reply to carry it, the end is told by a line of its own in the thread", async () => {
  const { slack, thread } = made({ mentionOwner: true });
  await thread.showStatus("error", { notify: true });
  await drained();
  const posted = slack.callsTo("chat.postMessage").at(-1);
  assert.equal(posted?.thread_ts, THREAD);
  assert.equal(posted?.text, `Failed <@${OWNER}>`);
  // Rich text: an invisible mention pushed beside it, never beside a section (2026-10-26).
  assert.deepEqual(posted?.blocks, [
    {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_section",
          elements: [
            { type: "emoji", name: "x" },
            { type: "text", text: " Failed" },
          ],
        },
      ],
    },
  ]);
});

// #88: a request's own mention tells the owner, beside its rich text heading (measured
// 2026-10-26); the channel's line mentions nobody.
test("each of the agent's requests mentions the owner when asked, and moves the channel's line", async () => {
  for (const mentionOwner of [true, false]) {
    const { line, shown } = recordingLine();
    const { slack, thread } = made({ line, mentionOwner });
    await thread.showStatus("waiting"); // the core's status: the request is not posted yet
    assert.deepEqual(shown, []);
    await thread.ask("approval-1", PERMISSION, "Bash: ls");
    await thread.ask("approval-2", QUESTION, "AskUserQuestion"); // the same turn, once answered
    assert.deepEqual(shown, Array(2).fill([CHANNEL, THREAD, "waiting"]));
    const texts = slack.callsTo("chat.postMessage").map((posted) => String(posted.text));
    assert.deepEqual(
      texts,
      mentionOwner
        ? [`Bash: ls <@${OWNER}>`, `AskUserQuestion <@${OWNER}>`]
        : ["Bash: ls", "AskUserQuestion"],
    );
  }
});

// #84: the line opens the request it names, and is told when that message is deleted.
test("a request's line links that request, and hears of its delete", async () => {
  const { line, opened, withdrawn } = recordingLine();
  const { slack, thread } = made({ line });
  const ts = await thread.ask("approval-1", PERMISSION, "Bash: ls");
  assert.deepEqual(opened, [ts]);
  slack.responses["chat.delete"] = { ok: true };
  await thread.withdraw(ts);
  assert.deepEqual(withdrawn, [[CHANNEL, THREAD, ts]]);
});

// #72: these answer what the owner has just written in the thread, so he is there.
for (const request of [
  {
    type: "setup",
    requestId: "setup-1",
    models: [],
    efforts: [],
    bypassOffered: true,
    selection: { model: "default", effort: "default", bypass: false },
  },
  { type: "shell", requestId: "shell-1", command: "git status", folder: "/work/web" },
  {
    type: "hold",
    requestId: "hold-1",
    other: { channel: CHANNEL, thread: "1792626999.000001" },
    link: "the other thread",
  },
] as const satisfies readonly OwnerRequest[]) {
  test(`a request the owner set off names nothing, in the channel's line or to him [${request.type}]`, async () => {
    const { line, shown } = recordingLine();
    const { slack, thread } = made({ line, mentionOwner: true });
    await thread.ask(request.requestId, request, "Asked");
    await thread.showStatus("waiting");
    assert.deepEqual(shown, []);
    assert.equal(slack.callsTo("chat.postMessage")[0]?.text, "Asked"); // and mentions nobody
    await thread.ask("approval-1", PERMISSION, "Bash: ls"); // the agent's own still counts
    assert.deepEqual(shown, [[CHANNEL, THREAD, "waiting"]]);
  });
}

// #25: Slack for iOS hides a stream still open once a message lands below it.
for (const [kind, request] of [
  ["approval", PERMISSION],
  ["question", QUESTION],
  ["shell", { type: "shell", requestId: "shell-1", command: "git status", folder: "/work/web" }],
] as const satisfies readonly (readonly [string, OwnerRequest])[]) {
  test(`a reply's stream stops before the ${kind} request is posted`, async () => {
    const { slack, thread } = made();
    const reply = thread.openReply(() => {});
    await reply.text("Working on it.");
    await new Promise((resolve) => setImmediate(resolve));
    await thread.ask("request-1", request, "Asked");
    const calls = slack.apiCalls.map((call) => call.method);
    const stop = calls.indexOf("chat.stopStream");
    assert.ok(stop >= 0, calls.join(", "));
    assert.ok(stop < calls.indexOf("chat.postMessage"), calls.join(", "));
  });
}

test("a message posted outside the session sets the thread status again", async () => {
  const { slack, clock, thread } = made();
  thread.showActivity({ kind: "working" });
  await settle(clock);
  thread.written();
  await clock.advance(THREAD_STATUS_AFTER_WRITE_SECONDS);
  assert.equal(slack.callsTo("assistant.threads.setStatus").length, 2);
});

test("a notice is one grey line in the thread shown as written", async () => {
  const { slack, clock, thread } = made();
  thread.showActivity({ kind: "working" });
  await settle(clock);
  await thread.notice('1 message was not sent: send it again.\n- "a <b> & c"');
  const [post, ...more] = slack.callsTo("chat.postMessage");
  assert.equal(more.length, 0);
  const shown = '1 message was not sent: send it again.\n- "a &lt;b&gt; &amp; c"';
  assert.deepEqual(post, {
    channel: CHANNEL,
    thread_ts: THREAD,
    text: shown,
    blocks: [{ type: "context", elements: [{ type: "mrkdwn", text: shown }] }],
    unfurl_links: false,
    unfurl_media: false,
  });
  // The post cleared the thread's status: it is set again.
  await clock.advance(THREAD_STATUS_AFTER_WRITE_SECONDS);
  assert.equal(slack.callsTo("assistant.threads.setStatus").length, 2);
});

test("a notice slack refuses is logged by its code and never rejects", async (t) => {
  const { slack, thread } = made();
  const errors: string[] = [];
  t.mock.method(logger, "error", (line: string) => errors.push(line));
  slack.responses["chat.postMessage"] = rejected("channel_not_found");
  await thread.notice("the words of the owner");
  assert.deepEqual(errors, [`could not post in ${CHANNEL}/${THREAD}: channel_not_found`]);
});

test("a permission request is a message of its own and the core gets its ts", async () => {
  const { slack, thread } = made();
  const ts = await thread.ask("approval-1", PERMISSION, "Bash: ls");
  assert.equal(ts, slack.postedTs[0]);
  const [post] = slack.callsTo("chat.postMessage");
  assert.deepEqual(post, {
    channel: CHANNEL,
    thread_ts: THREAD,
    text: "Bash: ls",
    blocks: JSON.parse(JSON.stringify(approvalBlocks("approval-1", PERMISSION, PLAIN_NAMES))),
    unfurl_links: false,
    unfurl_media: false,
  });
});

test("a question request is posted with the questions buttons", async () => {
  const { slack, thread } = made();
  await thread.ask("approval-2", QUESTION, "AskUserQuestion");
  const [post] = slack.callsTo("chat.postMessage");
  assert.equal(post?.text, "AskUserQuestion");
  assert.deepEqual(
    post?.blocks,
    JSON.parse(JSON.stringify(questionBlocks("approval-2", QUESTION.questions, PLAIN_NAMES))),
  );
});

test("a request slack refuses rejects with a chat error named by slacks code", async () => {
  const { slack, thread } = made();
  slack.responses["chat.postMessage"] = rejected("invalid_blocks");
  await assert.rejects(thread.ask("approval-1", PERMISSION, "Bash: ls"), (error: unknown) => {
    assert.ok(error instanceof ChatError);
    assert.equal(error.name, "invalid_blocks");
    return true;
  });
});

test("a withdrawn request is deleted and one already gone counts as removed", async () => {
  const { slack, thread } = made();
  const ts = await thread.ask("approval-1", PERMISSION, "Bash: ls");
  await thread.withdraw(ts);
  assert.deepEqual(slack.callsTo("chat.delete"), [{ channel: CHANNEL, ts }]);
  slack.responses["chat.delete"] = rejected("message_not_found");
  await thread.withdraw(ts); // never rejects
  assert.equal(slack.callsTo("chat.delete").length, 2);
});

test("an answered question is rewritten on the budget every reply draws from", async () => {
  const { slack, limiter, thread } = made();
  const ts = await thread.ask("approval-2", QUESTION, "AskUserQuestion");
  const answers = { "Which colour?": "Red" };
  await thread.keepAnswers(ts, QUESTION.questions, answers);
  const [update, ...more] = slack.callsTo("chat.update");
  assert.equal(more.length, 0);
  assert.deepEqual(update, {
    channel: CHANNEL,
    ts,
    text: named(texts.ANSWERED, PLAIN_NAMES),
    blocks: JSON.parse(JSON.stringify(answeredBlocks(QUESTION.questions, answers, PLAIN_NAMES))),
  });
  // One token, taken before the update was sent.
  assert.equal(limiter.acquired, 1);
  assert.equal(slack.apiCalls[limiter.before[0] ?? -1]?.method, "chat.update");
});

test("a rewrite slack refuses rejects with a chat error named by slacks code", async () => {
  const { slack, thread } = made();
  const ts = await thread.ask("approval-2", QUESTION, "AskUserQuestion");
  slack.responses["chat.update"] = rejected("msg_too_long");
  await assert.rejects(
    thread.keepAnswers(ts, QUESTION.questions, { "Which colour?": "Red" }),
    (error: unknown) => error instanceof ChatError && error.name === "msg_too_long",
  );
});

test("the activity line is refused once slack says the token cannot set one", async () => {
  const { slack, clock, thread } = made();
  assert.equal(thread.activityRefused, false);
  slack.responses["assistant.threads.setStatus"] = rejected("missing_scope");
  const warnings = mock.method(statusLogger, "warning", () => {});
  try {
    thread.showActivity({ kind: "working" });
    await settle(clock);
  } finally {
    warnings.mock.restore();
  }
  assert.equal(thread.activityRefused, true);
});

test("the status line counts its refresh on the steady clock, not on the wall clock", async () => {
  // A step of the system clock must neither bring a refresh forward nor put it off.
  const slack = new FakeSlack();
  const wall = new FakeClock();
  const steady = new FakeClock();
  const chat = new SlackChat({
    slack,
    replies: slack,
    identity: { teamId: TEAM, ownerUserId: OWNER, botUserId: BOT },
    agent: () => AGENT,
    limiter: new CountingLimiter(slack),
    clock: wall,
    steady,
  });
  const thread = chat.thread({ channel: CHANNEL, thread: THREAD });
  const shown = () => slack.callsTo("assistant.threads.setStatus").length;
  thread.showActivity({ kind: "working" });
  await steady.advance(0);
  assert.equal(shown(), 1);
  await wall.advance(10 * THREAD_STATUS_REFRESH_SECONDS);
  await steady.advance(0);
  assert.equal(shown(), 1); // an hour of wall time and no refresh
  await steady.advance(THREAD_STATUS_REFRESH_SECONDS);
  assert.equal(shown(), 2);
  await thread.close();
});

test("the provider gives each thread its own object and shares one budget", async () => {
  const { slack, limiter, chat, thread } = made();
  const other = chat.thread({ channel: CHANNEL, thread: OTHER_THREAD });
  assert.notEqual(other, thread);
  assert.equal(chat.limiter, limiter);
  await other.showStatus("working");
  assert.equal(slack.callsTo("reactions.add")[0]?.timestamp, OTHER_THREAD);
});

test("the threads a chat builds for one Slack thread share the order of its messages", async () => {
  const { chat, clock } = made();
  const ref = { channel: CHANNEL, thread: THREAD };
  const first = chat.thread(ref).openReply(() => {});
  await first.text("one");
  await first.settle();
  // A later session of the same thread builds a thread object of its own.
  const second = chat.thread(ref).openReply(() => {});
  await second.text("two");
  await second.settle();
  await settle(clock);
  assert.equal(first.overtaken, true);
  assert.equal(second.overtaken, false);
  chat.ownerPosted(CHANNEL, THREAD, "1790000000.900000");
  assert.equal(second.last, false);
  // Another Slack thread has an order of its own.
  const apart = chat.thread({ channel: CHANNEL, thread: "1790000000.000777" }).openReply(() => {});
  await apart.text("elsewhere");
  await apart.settle();
  assert.equal(second.overtaken, false);
});

test("a reply let go of by the owner's message still sees the next reply of its thread below it", async () => {
  // The commonest sequence: a reply ends, the owner writes, the next reply opens in the same
  // thread. The places outlive the release, or the two replies are in two objects.
  const { chat, clock } = made();
  const thread = chat.thread({ channel: CHANNEL, thread: THREAD });
  const first = thread.openReply(() => {});
  await first.text("one");
  await first.finish([]);
  assert.equal(await first.closeOut(), true);
  chat.ownerPosted(CHANNEL, THREAD, "1790000000.900000"); // lets the first go
  assert.equal(trackedThreads(chat), 1, "a release by the owner's message keeps the places");
  const second = thread.openReply(() => {});
  await second.text("two");
  await second.settle();
  await settle(clock);
  assert.equal(trackedThreads(chat), 1);
  assert.equal(first.overtaken, true, "the second wrote below it, in the same places");
  assert.equal(second.overtaken, false);
  await thread.close();
});

test("a reply whose end never lands is let go of when its thread closes", async () => {
  const { chat, slack } = made();
  slack.responses["chat.startStream"] = rejected("internal_error");
  const thread = chat.thread({ channel: CHANNEL, thread: THREAD });
  const reply = thread.openReply(() => {});
  await reply.text("never written");
  await reply.finish([]);
  assert.equal(await reply.closeOut(), false, "the end did not land");
  assert.equal(trackedThreads(chat), 1);
  await thread.close();
  assert.equal(trackedThreads(chat), 0, "the places and the reply are forgotten");
});

// The map of a chat's threads' places, which no member of the provider exposes.
function trackedThreads(chat: SlackChat): number {
  return (chat as unknown as { places: Map<string, unknown> }).places.size;
}

test("a thread that ended its reply and closed leaves nothing in the chat", async () => {
  const { chat } = made();
  for (let i = 1; i <= 20; i += 1) {
    const thread = chat.thread({
      channel: CHANNEL,
      thread: `1790000000.00${String(i).padStart(4, "0")}`,
    });
    const reply = thread.openReply(() => {});
    await reply.text(`answer ${i}`);
    await reply.finish([]);
    assert.equal(await reply.closeOut(), true);
    await thread.close();
  }
  assert.equal(trackedThreads(chat), 0);
});

test("a detached thread object closing does not let go of a live session's replies", async () => {
  const { chat } = made();
  const ref = { channel: CHANNEL, thread: THREAD };
  const live = chat.thread(ref).openReply(() => {});
  await live.text("one");
  await live.finish([]);
  assert.equal(await live.closeOut(), true);
  await chat.thread(ref).close(); // a handler's object, which opened nothing
  assert.equal(trackedThreads(chat), 1);
});

test("a reply opened and silent keeps the thread's places when another is let go of", async () => {
  const { chat } = made();
  const ref = { channel: CHANNEL, thread: THREAD };
  const ended = chat.thread(ref).openReply(() => {});
  await ended.text("one");
  await ended.finish([]);
  assert.equal(await ended.closeOut(), true);
  const silent = chat.thread(ref).openReply(() => {});
  chat.ownerPosted(CHANNEL, THREAD, "1790000000.900000"); // lets the ended one go
  const newest = chat.thread(ref).openReply(() => {});
  await newest.text("two");
  await newest.settle();
  await silent.text("three");
  await silent.settle();
  assert.equal(newest.overtaken, true, "the silent reply wrote below it, in the same places");
  assert.equal(silent.overtaken, false);
});

test("a thread keeps no reply the places let go of", async () => {
  const { chat } = made();
  const thread = chat.thread({ channel: CHANNEL, thread: THREAD });
  const opened = () => (thread as unknown as { opened: unknown[] }).opened.length;
  for (const [i, ts] of ["1790000000.900001", "1790000000.900002"].entries()) {
    const reply = thread.openReply(() => {});
    await reply.text(`answer ${i}`);
    await reply.finish([]);
    assert.equal(await reply.closeOut(), true);
    chat.ownerPosted(CHANNEL, THREAD, ts); // seals it
  }
  assert.equal(opened(), 1, "the first was dropped when the second opened");
  thread.openReply(() => {});
  assert.equal(opened(), 1, "only the reply still held");
});
