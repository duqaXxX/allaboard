/**
 * The conformance suite of the chat seam (`chat.ts`), run against every provider: the memory chat
 * of the tests, and the Slack provider over its fake client. The suite includes the owner check:
 * a message, a click and a form from someone else never arrive.
 *
 * Where Slack stands: every listener tells the core through `ChatInbound`, and the adapter builds
 * the payloads Slack would send (the recorded click and form fixtures, through the builders of
 * `test/support/slack-app.ts`). The owner checks of each Slack listener are also
 * `test/agent/claude/slack-app/owner-checks.test.ts`.
 */
import type { App, Receiver } from "@slack/bolt";
import type { Question } from "../../src/agent/seam.ts";
import type { ThreadRef } from "../../src/chat/seam.ts";
import { ChannelGuard } from "../../src/chat/slack/app/guards.ts";
import { BIND_ACTION } from "../../src/chat/slack/bind.ts";
import { HOLD_CANCEL, HOLD_CONTINUE } from "../../src/chat/slack/hold.ts";
import {
  DIFF_FILE_ACTION,
  DIFF_VIEW_ACTION,
  fileValue,
  viewValue,
} from "../../src/chat/slack/lists.ts";
import {
  APPROVAL_ALLOW,
  APPROVAL_DENY,
  QUESTION_OPEN,
  QUESTION_SKIP,
  SHELL_CANCEL,
  SHELL_RUN,
  TERMINAL_CANCEL,
  TERMINAL_GO,
} from "../../src/chat/slack/requests.ts";
import { RESUME_ACTION } from "../../src/chat/slack/resume.ts";
import { SETUP_START } from "../../src/chat/slack/setup.ts";
import { SUGGEST_EDIT } from "../../src/chat/slack/suggest.ts";
import { SlackChat } from "../../src/chat/slack/thread.ts";
import { UPDATE_ACTION } from "../../src/chat/slack/update.ts";
import type { Clock } from "../../src/clock.ts";
import type { CorePort } from "../../src/core/port.ts";
import type { Pending } from "../../src/core/requests.ts";
import {
  AGENT,
  CHANNEL,
  type FakeSlack,
  rejected,
  STRANGER,
  THREAD,
} from "../support/fake-slack.ts";
import { ELSEWHERE, memoryChat, OWNER, SOMEONE } from "../support/memory-chat.ts";
import {
  type Body,
  clickIn,
  deletedRoot,
  fieldEnter,
  message,
  picked,
  reply,
  selectIn,
  setupState,
  submitOn,
  type World,
  worldOf,
} from "../support/slack-app.ts";
import {
  type ChatRig,
  chatConformance,
  type Person,
  type Said,
  type Scope,
  type Shown,
} from "./chat.ts";

// ---- the memory chat

const STEADY: Clock = { sleep: async () => {}, time: () => 1_780_000_000 };

function memoryPerson(
  person: ReturnType<ReturnType<typeof memoryChat>["as"]>,
  who: string,
): Person {
  return {
    says: async (channel, text, options) => {
      const sent = await person.says(channel, text, options);
      return { id: sent.id, ref: sent.ref, author: who };
    },
    answers: async (asked, answer) => {
      await person.answers(asked.requestId, answer);
    },
    picks: async (listed, row) => {
      await person.picks(listed.message, row);
    },
    picksFile: async (listed, path) => {
      await person.picksFile(listed.message, path);
    },
    picksView: async (listed, view) => {
      await person.picksView(listed.message, view);
    },
    deletes: async (said) => {
      await person.deletes(said);
    },
    types: async (shown, _ref, text) => {
      if (shown.id === null) throw new Error("a suggestion is a message of the chat");
      await person.types(shown.id, text);
    },
  };
}

async function memoryRig(threadIds: "own" | "opening" = "own"): Promise<ChatRig> {
  const chat = memoryChat({ suggestions: true, threadIds, lists: true });
  const provider = await chat.build({
    variables: {},
    allowedRoot: "/work",
    scratchDir: "/scratch",
    clock: STEADY,
    steady: STEADY,
    core: () => {
      throw new Error("the memory chat never reads the core");
    },
  });
  const channel = chat.openChannel("work");
  return {
    provider,
    channel,
    thread: chat.openThread(channel),
    owner: memoryPerson(chat.as(OWNER), OWNER),
    other: memoryPerson(chat.as(SOMEONE), SOMEONE),
    ownerElsewhere: memoryPerson(chat.as(OWNER, ELSEWHERE), OWNER),
    keep: (thread) => chat.keepThread(thread),
    ownerOnlyNotices: false,
    read: (scope) =>
      chat.messages(scope.channel, scope.thread).map((m) => ({
        id: m.id,
        text: m.text,
        pressable: m.pressable,
        ownerOnly: false,
      })),
    settle: async () => {},
    refuseWrites: () => chat.removeChannel(channel),
    removeChannel: (gone) => chat.removeChannel(gone),
    removeThread: (gone) => chat.removeThread(gone),
    failLookups: () => chat.failChannelLookups(),
  };
}

// ---- the Slack provider

/** The calls that write in Slack, refused when the chat refuses writes. */
const WRITES = [
  "chat.postMessage",
  "chat.postEphemeral",
  "chat.startStream",
  "chat.appendStream",
  "chat.stopStream",
  "chat.update",
  "reactions.add",
];

/** Whether a message's blocks hold a control. */
function pressable(blocks: unknown): boolean {
  return JSON.stringify(blocks).includes('"action_id"');
}

/** What `scope` shows of the fake workspace: the messages of the daemon, and its ephemeral lines. */
function slackRead(slack: FakeSlack, scope: Scope): Shown[] {
  const here = (args: Body): boolean =>
    args.channel === scope.channel && (args.thread_ts ?? undefined) === scope.thread;
  const shown: Shown[] = [];
  const posts = slack.callsTo("chat.postMessage");
  for (const [index, args] of posts.entries()) {
    const ts = slack.postedTs[index];
    const held = ts === undefined ? undefined : slack.messages.get(ts);
    if (!here(args) || held === undefined || held.deleted) continue;
    shown.push({
      id: held.ts,
      text: `${held.text}\n${JSON.stringify(held.blocks)}`,
      pressable: pressable(held.blocks),
      ownerOnly: false,
    });
  }
  for (const [index, args] of slack.callsTo("chat.startStream").entries()) {
    const ts = slack.streamTs[index];
    const held = ts === undefined ? undefined : slack.messages.get(ts);
    if (!here(args) || ts === undefined || held === undefined || held.deleted) continue;
    const at = slack.createdTs.indexOf(ts);
    shown.push({
      id: ts,
      text: [
        slack.messageTexts()[at],
        JSON.stringify(slack.messageCards()[at]),
        JSON.stringify(held.blocks),
      ].join("\n"),
      pressable: pressable(held.blocks),
      ownerOnly: false,
    });
  }
  for (const args of slack.callsTo("chat.postEphemeral")) {
    if (!here(args)) continue;
    shown.push({
      id: null,
      text: `${args.text}\n${JSON.stringify(args.blocks)}`,
      pressable: pressable(args.blocks),
      ownerOnly: true,
    });
  }
  return shown;
}

/** What a click or a form names of `user`: the user's id, in the owner's workspace. */
function userOf(user: string, world: World): Body {
  return user === world.identity.ownerUserId ? {} : { id: user };
}

function slackPerson(
  world: World,
  app: () => App | null,
  asked: Map<string, Pending>,
  user: string,
  team: string = world.identity.teamId,
): Person {
  let sequence = 0;
  // What Slack sends from another workspace: the event names its team, a click or a form names
  // the team and the user's home team (the owner's user id is the same there, the workspace is not).
  const inTeam = (body: Body): Body => {
    if (team === world.identity.teamId) return body;
    if (body.event !== undefined) {
      body.event.team = team;
      body.team_id = team;
    } else {
      body.team = { ...body.team, id: team };
      body.user = { ...body.user, team_id: team };
    }
    return body;
  };
  const dispatch = async (original: Body): Promise<void> => {
    const body = inTeam(original);
    // The chat delivers nothing before the connection opens.
    const built = app();
    if (built === null) return;
    built.processEvent({ body, ack: async () => {} }).catch(() => {});
    await world.idle();
  };
  return {
    says: async (channel, text, options): Promise<Said> => {
      sequence += 1;
      if (options?.thread === undefined) {
        const ts = `1790100000.${String(sequence).padStart(6, "0")}${user === STRANGER ? 1 : 0}`;
        await dispatch(message(text, { user, channel, ts }));
        return { id: ts, ref: { channel, thread: ts }, author: user };
      }
      // Between the last message the fake created and the next one, as in a real thread.
      const ts = `1790000000.${String(world.slack.createdTs.length * world.slack.tsStep + sequence).padStart(6, "0")}`;
      const body = reply(text, options.thread, { user, channel, ts });
      await dispatch(body);
      return { id: String(body.event.ts), ref: { channel, thread: options.thread }, author: user };
    },
    // The button of each request carries its request id; the question's form carries it in the
    // draft it rides on, and Slack's listener looks the question up in what the core holds.
    answers: async (request, answer): Promise<void> => {
      const { ref, requestId, message: shownAt } = request;
      const click = (actionId: string): Body =>
        clickIn(actionId, requestId, ref.channel, ref.thread, {
          messageTs: shownAt,
          user: userOf(user, world),
        });
      switch (answer.type) {
        case "permission":
          await dispatch(click(answer.allow ? APPROVAL_ALLOW : APPROVAL_DENY));
          return;
        case "hold":
          await dispatch(click(answer.send ? HOLD_CONTINUE : HOLD_CANCEL));
          return;
        case "shell":
          await dispatch(click(answer.run ? SHELL_RUN : SHELL_CANCEL));
          return;
        case "terminal":
          await dispatch(click(answer.go ? TERMINAL_GO : TERMINAL_CANCEL));
          return;
        case "setup": {
          const { model, effort, bypass } = answer.selection;
          const body = click(SETUP_START);
          body.state = { values: setupState(model, effort, bypass) };
          await dispatch(body);
          return;
        }
        case "question": {
          if (answer.answers === null) {
            await dispatch(click(QUESTION_SKIP));
            return;
          }
          if (request.request.type !== "question") throw new Error("a question's answer");
          const { questions } = request.request;
          asked.set(requestId, pendingOf(ref, questions));
          // The owner opens the form (Answer); whoever submits it, the form is that one.
          const open = clickIn(QUESTION_OPEN, requestId, ref.channel, ref.thread, {
            messageTs: shownAt,
          });
          open.trigger_id = "0000000000.0000000000.fake";
          await dispatch(open);
          const form = world.slack.callsTo("views.open").at(-1)?.view as Body;
          // The option each question was answered with, by its place in the question's list.
          const values = Object.assign(
            {},
            ...questions.map((question, at) => {
              const label = answer.answers?.[question.text];
              const index = question.options.findIndex((option) => option.label === label);
              if (index === -1) throw new Error(`no option ${String(label)} in the question`);
              return picked(at, String(index));
            }),
          );
          const body = submitOn(form, values, userOf(user, world));
          await dispatch(body);
          return;
        }
      }
    },
    picksFile: async (listed, path): Promise<void> => {
      await dispatch(
        clickIn(
          DIFF_FILE_ACTION,
          fileValue(listed.list.session, listed.list.view, path),
          listed.ref.channel,
          listed.ref.thread,
          { messageTs: listed.message, user: userOf(user, world) },
        ),
      );
    },
    picksView: async (listed, view): Promise<void> => {
      await dispatch(
        selectIn(
          DIFF_VIEW_ACTION,
          viewValue(listed.list.session, view),
          listed.ref.channel,
          listed.ref.thread,
          { messageTs: listed.message, user: userOf(user, world) },
        ),
      );
    },
    // The event names no actor: a deletion by someone outside the owner's workspace is the one
    // that must change nothing.
    deletes: async (said): Promise<void> => {
      // The event names the author of the message that went, and not who deleted it.
      await dispatch(
        deletedRoot(said.ref.channel, said.id, said.author ?? world.identity.ownerUserId),
      );
    },
    // The field's block id carries the typed message; the thread is the one the suggestion sits in.
    types: async (shown, ref, text): Promise<void> => {
      const blocks = JSON.parse(shown.text.slice(shown.text.indexOf("\n") + 1)) as Body[];
      const field = blocks.find((block) => block.type === "input");
      if (field === undefined) throw new Error("the suggestion has no field");
      await dispatch(
        fieldEnter(SUGGEST_EDIT, field.block_id, text, ref.thread, userOf(user, world)),
      );
    },
    picks: async (list, row): Promise<void> => {
      const { channel, message: shownAt } = list;
      // A list posted in the channel is a message of the channel: its thread is its own ts.
      const value = (): string =>
        list.list.type === "sessions" ? `${row}@${list.list.thread.thread}` : row;
      const actionId =
        list.list.type === "sessions"
          ? RESUME_ACTION
          : list.list.type === "update"
            ? UPDATE_ACTION
            : BIND_ACTION;
      await dispatch(
        clickIn(actionId, value(), channel, shownAt, {
          messageTs: shownAt,
          user: userOf(user, world),
        }),
      );
    },
  };
}

/** The request the core holds for a question the daemon asked, as the form's listener reads it. */
function pendingOf(ref: ThreadRef, questions: readonly Question[]): Pending {
  return {
    channelId: ref.channel,
    threadId: ref.thread,
    title: "A request",
    questions,
    decision: new Promise(() => {}),
    decided: false,
    messageId: null,
  };
}

async function slackRig(t: Parameters<typeof worldOf>[0]): Promise<ChatRig> {
  const world = worldOf(t);
  world.slack.tsStep = 100; // room between two messages for a person's
  let built: App | null = null;
  // The questions the checks asked: the core holds each under the id the check chose.
  const asked = new Map<string, Pending>();
  const core: CorePort = {
    ...world.core,
    approvals: {
      questions: (id, channel, thread) => {
        const pending = asked.get(id);
        if (pending === undefined) return world.approvals.questions(id, channel, thread);
        const same = pending.channelId === channel && pending.threadId === thread;
        return same && pending.questions?.length ? pending.questions : null;
      },
    },
  };
  const receiver: Receiver = {
    init: (app) => {
      built = app;
    },
    start: async () => {},
    stop: async () => {},
  };
  const provider = new SlackChat({
    slack: world.slack,
    replies: world.slack,
    identity: world.identity,
    agent: () => AGENT,
    limiter: world.limiter,
    clock: world.slackClock,
    app: {
      core: () => core,
      config: world.config,
      guard: new ChannelGuard(world.slack, world.identity),
      home: world.home,
      uploads: world.uploads,
      receiver,
      appKey: "app-token:0123abcd",
    },
  });
  const app = (): App | null => built;
  const refuse = (...methods: string[]) => {
    for (const method of methods) world.slack.responses[method] = rejected("channel_not_found");
  };
  return {
    provider,
    channel: CHANNEL,
    thread: { channel: CHANNEL, thread: THREAD },
    owner: slackPerson(world, app, asked, world.identity.ownerUserId),
    other: slackPerson(world, app, asked, STRANGER),
    ownerElsewhere: slackPerson(world, app, asked, world.identity.ownerUserId, "T000ELSEWHERE"),
    // The core's state holds the threads the owner started: the provider tells of those alone.
    keep: (thread) => {
      world.state.openThread(thread.channel, thread.thread);
    },
    ownerOnlyNotices: true,
    read: (scope) => slackRead(world.slack, scope),
    settle: async () => {
      await world.slackClock.advance(2);
      await world.idle();
    },
    refuseWrites: () => refuse(...WRITES),
    removeChannel: () => refuse("conversations.info"),
    removeThread: () => {
      world.slack.responses["conversations.replies"] = rejected("thread_not_found");
    },
    failLookups: () => {
      world.slack.responses["conversations.info"] = rejected("ratelimited");
      world.slack.responses["conversations.replies"] = rejected("ratelimited");
    },
  };
}

chatConformance("the memory chat", () => memoryRig());
// A thread named by its opening message's id, as Slack's is: the other thread model of the seam.
chatConformance("the memory chat, threads named by their opening message", () =>
  memoryRig("opening"),
);

chatConformance("the Slack provider", slackRig);
