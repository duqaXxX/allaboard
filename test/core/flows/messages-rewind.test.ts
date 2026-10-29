/**
 * `!rewind` through the message flow, with the plain agent and the memory chat: the prompts of a
 * session listed in its thread, the actions offered at one, and what each does. The plain agent
 * keeps the files a test writes and a checkpoint of them at each prompt, and cuts its record of
 * the conversation once a prompt is sent after a `rewindTo` (as Claude Code does).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ThreadRef } from "../../../src/chat/seam.ts";
import * as texts from "../../../src/core/texts.ts";
import { hold, PlainAgent, PlainStore, say } from "../../support/plain-agent.ts";
import { MessagesWorld } from "./messages-world.ts";

type Rewind = ConstructorParameters<typeof PlainAgent>[0] extends infer O
  ? O extends { rewind?: infer R }
    ? R
    : never
  : never;

/**
 * A thread with two prompts: `a.txt` holds `alpha` while the first runs and `beta` while the
 * second does, and the agent keeps a checkpoint of each. `after` is what is written since.
 */
async function threadOf(
  t: Parameters<typeof MessagesWorld.make>[0],
  options: {
    readonly rewind?: Rewind;
    readonly noFold?: boolean;
    readonly store?: PlainStore;
  } = {},
) {
  const store = options.store ?? new PlainStore();
  const agent = new PlainAgent({
    store,
    rewind: options.rewind ?? { files: true, conversation: true },
  });
  const world = await MessagesWorld.make(t, {
    agent,
    rewind: true,
    ...(options.noFold && { noFold: true }),
  });
  store.writeFile(world.folder, "a.txt", "alpha");
  agent.next(say("first answer"));
  const ref = await world.opened("add the first feature");
  store.writeFile(world.folder, "a.txt", "beta");
  agent.next(say("second answer"));
  await world.says("fix the second bug", ref.thread);
  await world.settle();
  const [first, second] = world.agentSession().prompts.map((prompt) => prompt.id);
  assert.ok(first && second);
  store.writeFile(world.folder, "a.txt", "gamma");
  return { world, agent, store, ref, first, second };
}

function listIn(world: MessagesWorld, ref: ThreadRef) {
  const open = world.chat.threadLists().findLast((list) => list.ref.thread === ref.thread);
  assert.ok(open, "a list is open in the thread");
  return open;
}

/** The last line the thread shows. */
function lastLine(world: MessagesWorld, ref: ThreadRef): string | undefined {
  return world.shown(ref).at(-1);
}

async function openActions(world: MessagesWorld, ref: ThreadRef, promptId: string) {
  await world.says("!rewind", ref.thread);
  await world.settle();
  const points = listIn(world, ref);
  assert.equal(await world.chat.as("alice").picksPoint(points.message, promptId), true);
  await world.settle();
  const actions = listIn(world, ref);
  assert.equal(actions.list.type, "rewind-actions");
  return actions;
}

test("!rewind lists the session's prompts, newest first", async (t) => {
  const { world, ref } = await threadOf(t);
  await world.says("!rewind", ref.thread);
  await world.settle();
  const open = listIn(world, ref);
  assert.equal(open.list.type, "rewind-points");
  if (open.list.type !== "rewind-points") return;
  assert.deepEqual(
    open.list.points.map((point) => point.text),
    ["fix the second bug", "add the first feature"],
  );
  assert.equal(open.title, texts.REWIND_TITLE);
});

test("a pick offers the code with its counts and the conversation", async (t) => {
  const { world, ref, first } = await threadOf(t);
  const { list } = await openActions(world, ref, first);
  assert.equal(list.type, "rewind-actions");
  if (list.type !== "rewind-actions") return;
  assert.deepEqual(list.files, { count: 1, insertions: 1, deletions: 1 });
  assert.equal(list.conversation, true);
  assert.equal(list.point.text, "add the first feature");
});

test("the code actions are not offered where the preview shows no change", async (t) => {
  const { world, store, ref, second } = await threadOf(t);
  // The files are as the second prompt found them.
  store.writeFile(world.folder, "a.txt", "beta");
  const { list } = await openActions(world, ref, second);
  assert.equal(list.type === "rewind-actions" && list.files, null);
  assert.equal(list.type === "rewind-actions" && list.conversation, true);
});

test("an agent that cannot restore files offers the conversation alone", async (t) => {
  const { world, ref, first } = await threadOf(t, { rewind: { conversation: true } });
  const { list } = await openActions(world, ref, first);
  assert.equal(list.type === "rewind-actions" && list.files, null);
  assert.equal(list.type === "rewind-actions" && list.conversation, true);
});

test("an agent that cannot cut the conversation offers the code alone", async (t) => {
  const { world, ref, first } = await threadOf(t, { rewind: { files: true } });
  const { list } = await openActions(world, ref, first);
  assert.equal(list.type === "rewind-actions" && list.conversation, false);
  assert.ok(list.type === "rewind-actions" && list.files !== null);
});

test("the first prompt offers the code alone when the agent cannot cut before it", async (t) => {
  const { world, ref, first } = await threadOf(t, {
    rewind: { files: true, conversation: true, firstUncuttable: true },
  });
  const { list } = await openActions(world, ref, first);
  assert.equal(list.type === "rewind-actions" && list.conversation, false);
  assert.ok(list.type === "rewind-actions" && list.files !== null);
});

test("a prompt with nothing to restore says so and leaves no controls", async (t) => {
  const { world, store, ref, first } = await threadOf(t, {
    rewind: { files: true, conversation: true, firstUncuttable: true },
  });
  store.writeFile(world.folder, "a.txt", "alpha");
  await world.says("!rewind", ref.thread);
  await world.settle();
  const points = listIn(world, ref);
  await world.chat.as("alice").picksPoint(points.message, first);
  await world.settle();
  assert.equal(
    world.chat.threadLists().some((list) => list.message === points.message),
    false,
  );
  assert.ok(world.shown(ref).includes(texts.REWIND_NOTHING));
});

test("Restore code puts the files back and tells how many", async (t) => {
  const { world, store, ref, first } = await threadOf(t);
  const actions = await openActions(world, ref, first);
  assert.equal(await world.chat.as("alice").picksAction(actions.message, "code"), true);
  await world.settle();
  assert.equal(store.file(world.folder, "a.txt"), "alpha");
  assert.ok(
    world.shown(ref).includes("Restored the code to how it was at that prompt: 1 file, +1 −1."),
  );
  // The conversation was not touched.
  assert.equal((world.agent as PlainAgent).starts.length, 1);
  assert.equal(world.chat.threadLists().length, 0, "the list is a notice now");
});

test("Restore conversation cuts at the prompt, folds the replies after it and posts it again", async (t) => {
  const { world, agent, store, ref, first } = await threadOf(t);
  const actions = await openActions(world, ref, first);
  await world.chat.as("alice").picksAction(actions.message, "conversation");
  await world.settle();

  // The agent was started again on the same session with the cut; the files were left alone.
  const start = agent.starts.at(-1);
  assert.equal(start?.rewindTo, first);
  assert.equal(start?.resume, agent.sessions[0]?.id);
  assert.equal(store.file(world.folder, "a.txt"), "gamma");

  // Each reply from that prompt on is one message that shows the title and holds its words.
  const folded = world.chat
    .messages(ref.channel, ref.thread)
    .filter((message) => message.inside !== null);
  assert.deepEqual(
    folded.map((message) => [message.text, message.inside?.includes("answer")]),
    [
      [texts.REWOUND_TITLE, true],
      [texts.REWOUND_TITLE, true],
    ],
  );
  assert.ok(folded[0]?.inside?.includes("first answer"));
  assert.ok(folded[1]?.inside?.includes("second answer"));

  // The prompt is posted again to copy, and the owner is told it holds once a message is sent.
  const lines = world.shown(ref);
  assert.ok(lines.includes("add the first feature"));
  assert.ok(lines.some((line) => line.startsWith("Went back to before that prompt")));
});

test("rewinding to the second prompt folds only the replies from it", async (t) => {
  const { world, store, ref, second } = await threadOf(t);
  store.writeFile(world.folder, "a.txt", "beta");
  const actions = await openActions(world, ref, second);
  await world.chat.as("alice").picksAction(actions.message, "conversation");
  await world.settle();
  const folded = world.chat
    .messages(ref.channel, ref.thread)
    .filter((message) => message.inside !== null);
  assert.equal(folded.length, 1);
  assert.ok(folded[0]?.inside?.includes("second answer"));
});

test("Restore code and conversation restores the files first, then cuts", async (t) => {
  const { world, agent, store, ref, first } = await threadOf(t);
  const actions = await openActions(world, ref, first);
  await world.chat.as("alice").picksAction(actions.message, "both");
  await world.settle();
  assert.equal(store.file(world.folder, "a.txt"), "alpha");
  assert.equal(agent.starts.at(-1)?.rewindTo, first);
  assert.ok(world.shown(ref).some((line) => line.startsWith("Restored the code")));
  assert.ok(world.shown(ref).some((line) => line.startsWith("Went back to before that prompt")));
});

test("Never mind leaves everything as it was", async (t) => {
  const { world, agent, store, ref, first } = await threadOf(t);
  const actions = await openActions(world, ref, first);
  await world.chat.as("alice").picksAction(actions.message, "cancel");
  await world.settle();
  assert.equal(store.file(world.folder, "a.txt"), "gamma");
  assert.equal(agent.starts.length, 1);
  assert.ok(world.shown(ref).includes(texts.REWIND_CANCELLED));
  assert.equal(world.chat.threadLists().length, 0);
});

test("a cut the agent refuses leaves the session as it was and the list to use again", async (t) => {
  const { world, agent, ref, first } = await threadOf(t, {
    rewind: { conversation: true, refuse: true },
  });
  const actions = await openActions(world, ref, first);
  await world.chat.as("alice").picksAction(actions.message, "conversation");
  await world.settle();
  assert.ok(
    world.shown(ref).includes(`Plain could not cut the conversation there, so it is as it was.`),
  );
  // The session was started again without the cut, and nothing was folded.
  assert.equal(agent.starts.at(-1)?.rewindTo, undefined);
  assert.equal(
    world.chat.messages(ref.channel, ref.thread).filter((message) => message.inside !== null)
      .length,
    0,
  );
  assert.equal(world.chat.threadLists().length, 1);
  // The next message goes to the session, which is alive.
  agent.next(say("still here"));
  await world.says("hello again", ref.thread);
  await world.settle();
  assert.ok(world.shown(ref).some((line) => line.includes("still here")));
});

test("a refused cut after the code was restored says exactly that", async (t) => {
  const { world, store, ref, first } = await threadOf(t, {
    rewind: { files: true, conversation: true, refuse: true },
  });
  const actions = await openActions(world, ref, first);
  await world.chat.as("alice").picksAction(actions.message, "both");
  await world.settle();
  assert.equal(store.file(world.folder, "a.txt"), "alpha");
  assert.ok(
    world
      .shown(ref)
      .includes(
        "The code was restored, but Plain could not cut the conversation there, so it is as it was.",
      ),
  );
});

test("nothing is rewound while a turn runs", async (t) => {
  const { world, agent, ref, first } = await threadOf(t);
  const actions = await openActions(world, ref, first);
  agent.next(say("working"), hold());
  await world.says("a long task", ref.thread);
  await world.settle();
  await world.says("!rewind", ref.thread);
  await world.settle();
  assert.equal(lastLine(world, ref), texts.REWIND_BUSY);
  // A list drawn before the turn started is refused the same.
  await world.chat.as("alice").picksAction(actions.message, "conversation");
  await world.settle();
  assert.equal(lastLine(world, ref), texts.REWIND_BUSY);
  assert.equal(agent.starts.length, 1, "the agent was not restarted");
  agent.sessions[0]?.release();
});

test("a list made for another session is refused", async (t) => {
  const { world, ref, first } = await threadOf(t);
  const open = await openActions(world, ref, first);
  world.chat.addThreadList({
    ...open,
    list: { ...open.list, session: "another" } as typeof open.list,
  });
  await world.chat.as("alice").picksAction(open.message, "conversation");
  await world.settle();
  assert.equal(lastLine(world, ref), texts.REWIND_STALE);
});

test("a prompt the session does not hold is refused", async (t) => {
  const { world, ref, first } = await threadOf(t);
  await world.says("!rewind", ref.thread);
  await world.settle();
  const points = listIn(world, ref);
  if (points.list.type !== "rewind-points") throw new Error("no prompt list");
  const forged = { ...points.list, points: [{ id: "forged", text: "a prompt that is not there" }] };
  world.chat.addThreadList({ ...points, list: forged });
  await world.chat.as("alice").picksPoint(points.message, "forged");
  await world.settle();
  assert.equal(lastLine(world, ref), texts.REWIND_POINT_GONE);
  assert.ok(first);
});

test("a chat that folds nothing still rewinds, and says the replies were not marked", async (t) => {
  const { world, agent, ref, first } = await threadOf(t, { noFold: true });
  const actions = await openActions(world, ref, first);
  await world.chat.as("alice").picksAction(actions.message, "conversation");
  await world.settle();
  assert.equal(agent.starts.at(-1)?.rewindTo, first);
  assert.ok(
    world
      .shown(ref)
      .includes(
        "Memory chat cannot mark the replies after that prompt as removed: they stay as they were.",
      ),
  );
  assert.ok(world.shown(ref).some((line) => line.includes("first answer")));
});

test("a rewind is asked for again when the session starts before a prompt is sent", async (t) => {
  const { world, agent, ref, first } = await threadOf(t);
  const actions = await openActions(world, ref, first);
  await world.chat.as("alice").picksAction(actions.message, "conversation");
  await world.settle();
  assert.equal(agent.starts.at(-1)?.rewindTo, first);

  // An idle close: the agent keeps the cut only once a prompt follows it, so the next start asks again.
  await world.sessions.get(ref.channel, ref.thread)?.close();
  agent.next(say("after the cut"));
  await world.says("go on from there", ref.thread);
  await world.settle();
  assert.equal(agent.starts.at(-1)?.rewindTo, first);

  // That prompt made the cut stick: a later start resumes plainly.
  await world.sessions.get(ref.channel, ref.thread)?.close();
  agent.next(say("later"));
  await world.says("and again", ref.thread);
  await world.settle();
  assert.equal(agent.starts.at(-1)?.rewindTo, undefined);
});

test("after a restart the replies of earlier turns are not folded, and the owner is told", async (t) => {
  const { world, store, ref, first } = await threadOf(t);
  const again = await MessagesWorld.make(t, {
    restartOf: world,
    agent: new PlainAgent({ store, rewind: { files: true, conversation: true } }),
    rewind: true,
  });
  const actions = await openActions(again, ref, first);
  await again.chat.as("alice").picksAction(actions.message, "conversation");
  await again.settle();
  assert.equal(
    again.chat.messages(ref.channel, ref.thread).filter((message) => message.inside !== null)
      .length,
    0,
  );
  assert.ok(again.shown(ref).includes(texts.REWIND_UNKNOWN_REPLIES));
  assert.ok(again.shown(ref).includes("add the first feature"));
});

test("!rewind is refused in the channel, before a session started and with no prompt", async (t) => {
  const store = new PlainStore();
  const agent = new PlainAgent({ store, rewind: { files: true, conversation: true } });
  const world = await MessagesWorld.make(t, { agent, rewind: true });
  await world.says("!rewind");
  await world.settle();
  assert.ok(world.inChannel().includes(texts.REWIND_TOP_LEVEL));
});

test("an agent with no way back and a chat with no lists do not offer the word", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new PlainAgent() });
  await world.says("!help rewind");
  await world.settle();
  assert.ok(!world.inChannel().some((line) => line.includes("`!rewind`")));
});

// The fix round: a cut that waits for a prompt, and what runs beside a rewind.

test("a cut that waited is dropped when someone else wrote to the session, and the owner is told", async (t) => {
  const { world, agent, store, ref, first } = await threadOf(t);
  const actions = await openActions(world, ref, first);
  await world.chat.as("alice").picksAction(actions.message, "conversation");
  await world.settle();
  const id = agent.sessions[0]?.id;
  assert.ok(id);
  // A terminal wrote two prompts to the session, which this process never saw.
  store.addPrompt(world.folder, id, { id: "t-3", text: "typed in a terminal", conversation: true });
  store.addPrompt(world.folder, id, {
    id: "t-4",
    text: "typed in a terminal too",
    conversation: true,
  });
  await world.sessions.get(ref.channel, ref.thread)?.close();

  agent.next(say("after the terminal"));
  await world.says("back in the chat", ref.thread);
  await world.settle();
  // The session started without the cut, and nothing the terminal wrote vanished.
  assert.equal(agent.sessions.at(-1)?.options.rewindTo, undefined);
  assert.deepEqual(
    (await agent.prompts?.(world.folder, id))?.map((point) => point.id).slice(0, 2),
    [agent.sessions[0]?.prompts[0]?.id, agent.sessions[0]?.prompts[1]?.id],
  );
  assert.ok((await agent.prompts?.(world.folder, id))?.some((point) => point.id === "t-4"));
  assert.ok(world.shown(ref).includes(texts.REWIND_DROPPED));
  assert.ok(world.shown(ref).some((line) => line.includes("after the terminal")));
});

test("moving the session to a terminal drops a cut that waits", async (t) => {
  const { world, ref, first } = await threadOf(t);
  const actions = await openActions(world, ref, first);
  await world.chat.as("alice").picksAction(actions.message, "conversation");
  await world.settle();
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.equal(session?.pendingCut, first);
  await session?.moveToTerminal();
  assert.equal(session?.pendingCut, null);
  assert.ok(world.shown(ref).includes(texts.REWIND_DROPPED_TERMINAL));
});

test("a move to the terminal during a rewind leaves it refused, not done", async (t) => {
  const { world, agent, ref, first } = await threadOf(t);
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session);
  const old = agent.sessions[0];
  assert.ok(old);
  const close = old.close.bind(old);
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  old.close = async () => {
    await gate;
    await close();
  };
  const rewinding = session.rewindConversation(first, [first]);
  await world.settle(5);
  const moving = session.moveToTerminal();
  await world.settle(5);
  open();
  const result = await rewinding;
  await moving;
  assert.equal(result.outcome, "refused");
  assert.equal(session.pendingCut, null);
});

test("a prompt queued behind a rewind is answered by the session the rewind left", async (t) => {
  const { world, agent, ref, first } = await threadOf(t, {
    rewind: { conversation: true, refuse: true },
  });
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session);
  // The agent takes its time to let the old process go.
  const old = agent.sessions[0];
  assert.ok(old);
  const close = old.close.bind(old);
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  old.close = async () => {
    await gate;
    await close();
  };
  const rewinding = session.rewindConversation(first, [first]);
  agent.next(say("answered after the rewind"));
  const sent = world.says("a prompt while it rewinds", ref.thread);
  await world.settle(5);
  open();
  const result = await rewinding;
  await sent;
  await world.settle();
  assert.equal(result.outcome, "refused");
  const lines = world.shown(ref);
  assert.ok(lines.some((line) => line.includes("answered after the rewind")));
  assert.ok(!lines.some((line) => line.includes("RewindRefused")), "no error reached the prompt");
  assert.equal(agent.sessions.at(-1)?.options.rewindTo, undefined);
});

test("a session reads in use while it rewinds", async (t) => {
  const { world, agent, ref, first } = await threadOf(t);
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session);
  const old = agent.sessions[0];
  assert.ok(old);
  const close = old.close.bind(old);
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let seen = false;
  old.close = async () => {
    seen = session.inUse;
    await gate;
    await close();
  };
  const rewinding = session.rewindConversation(first, [first]);
  await world.settle(5);
  assert.equal(seen, true);
  assert.equal((await session.rewindConversation(first, [first])).outcome, "busy");
  open();
  await rewinding;
  assert.equal(session.inUse, false);
});

test("replies are folded from the dropped prompts, whether or not the picked one was remembered", async (t) => {
  const { world, ref, first, second } = await threadOf(t);
  const session = world.sessions.get(ref.channel, ref.thread);
  // The first prompt's replies are not in memory (older than what is kept, or from before a restart).
  session?.rewinds.forgetIds([first]);
  const actions = await openActions(world, ref, first);
  await world.chat.as("alice").picksAction(actions.message, "conversation");
  await world.settle();
  const folded = world.chat
    .messages(ref.channel, ref.thread)
    .filter((message) => message.inside !== null);
  assert.equal(folded.length, 1);
  assert.ok(folded[0]?.inside?.includes("second answer"));
  assert.ok(second);
});

test("a second !rewind before the next prompt lists only the prompts before the cut", async (t) => {
  const { world, ref, first, second } = await threadOf(t);
  const actions = await openActions(world, ref, second);
  await world.chat.as("alice").picksAction(actions.message, "conversation");
  await world.settle();
  await world.says("!rewind", ref.thread);
  await world.settle();
  const open = listIn(world, ref);
  assert.equal(open.list.type, "rewind-points");
  if (open.list.type !== "rewind-points") return;
  assert.deepEqual(
    open.list.points.map((point) => point.id),
    [first],
  );
  // A list drawn before the cut cannot bring the dropped prompt back.
  world.chat.addThreadList({
    ...open,
    list: { ...open.list, points: [{ id: second, text: "fix the second bug" }] },
  });
  await world.chat.as("alice").picksPoint(open.message, second);
  await world.settle();
  assert.equal(lastLine(world, ref), texts.REWIND_POINT_GONE);
});

test("a double click on an action runs it once", async (t) => {
  const { world, agent, store, ref, first } = await threadOf(t);
  const actions = await openActions(world, ref, first);
  const alice = world.chat.as("alice");
  await Promise.all([
    alice.picksAction(actions.message, "both"),
    alice.picksAction(actions.message, "both"),
  ]);
  await world.settle();
  assert.equal(store.file(world.folder, "a.txt"), "alpha");
  assert.equal(agent.starts.filter((start) => start.rewindTo !== undefined).length, 1, "one cut");
  // The owner's own message, and the one repost.
  assert.equal(
    world.shown(ref).filter((line) => line === "add the first feature").length,
    2,
    "the prompt is posted once",
  );
  assert.ok(
    world.shown(ref).includes(texts.REWIND_UNDER_WAY) ||
      world.shown(ref).includes(texts.REWIND_ALREADY),
  );
});

test("the files are not restored when something started to run after the preview", async (t) => {
  const { world, agent, store, ref, first } = await threadOf(t);
  const actions = await openActions(world, ref, first);
  const live = world.agentSession();
  const restore = live.restoreFiles;
  assert.ok(restore);
  live.restoreFiles = async (promptId, preview) => {
    const done = await restore(promptId, preview);
    if (preview) {
      agent.next(say("working"), hold());
      void world.says("a long task", ref.thread);
      await world.settle(5);
    }
    return done;
  };
  await world.chat.as("alice").picksAction(actions.message, "code");
  await world.settle();
  assert.equal(store.file(world.folder, "a.txt"), "gamma", "nothing was restored");
  assert.ok(world.shown(ref).includes(texts.REWIND_BUSY));
  live.release();
});

test("what a thread remembered is dropped with the thread", async (t) => {
  const { world, ref } = await threadOf(t);
  await world.sessions.get(ref.channel, ref.thread)?.close();
  assert.equal(world.sessions.remembered, 1);
  world.state.removeThread(ref.channel, ref.thread);
  world.sessions.liveThreads();
  assert.equal(world.sessions.remembered, 0);
});

test("a thread that remembers nothing leaves nothing behind when its session closes", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new PlainAgent() });
  const ref = await world.opened("hello");
  await world.sessions.get(ref.channel, ref.thread)?.close();
  assert.equal(world.sessions.remembered, 0);
});
