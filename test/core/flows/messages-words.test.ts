/**
 * The daemon's own words, typed as messages, over the memory chat: what each does in the
 * channel, in a session's thread and in a thread that holds no session, and what is answered.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { helpText } from "../../../src/core/commands.ts";
import { type GuideOffer, guideText } from "../../../src/core/guide.ts";
import * as texts from "../../../src/core/texts.ts";
import { fill, named } from "../../../src/core/texts.ts";
import { goalChanged, hold, PLAIN_COMMANDS, type PlainAgent } from "../../support/plain-agent.ts";
import {
  MessagesWorld,
  NoCommands,
  PLAIN_NAMES,
  WithBypass,
  WithGoals,
  WithPlan,
  WithSessionTags,
} from "./messages-world.ts";

const identity = (text: string): string => text;

// --- !help and !guide

// The plain agent has no bypass mode and the memory chat no file upload: `!bypass` and `!open`
// are refused when typed, and the help does not list them; nor `!memory` and `!skills`, since
// the plain agent lists nothing a session loaded.
const UNSERVED = new Set([
  "bypass",
  "plan",
  "memory",
  "skills",
  "open",
  "tag",
  "untag",
  "delete-thread",
  "allaboard",
  "!",
]);
// It keeps no record of trust either, so its `!bind` line speaks of none.
const NO_TRUST = false;

test("!help in the channel lists the daemon's words and says where the agent's commands are", async (t) => {
  const world = await MessagesWorld.make(t);
  await world.says("!help");
  assert.deepEqual(world.inChannel().slice(1), [
    helpText(null, "", identity, PLAIN_NAMES, true, UNSERVED, NO_TRUST),
  ]);
  assert.ok(world.inChannel().at(-1)?.includes(named(texts.HELP_UNBOUND, PLAIN_NAMES)));
  // The plain agent keeps no record of trust: nothing in the list says its folders are trusted.
  assert.ok(!world.inChannel().at(-1)?.includes("trusts"));
  assert.deepEqual(await world.prompts(), []);
});

test("!help in a session's thread adds the commands the session offers, less those a thread refuses", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  await world.says("!help", ref.thread);
  assert.equal(
    world.shown(ref).at(-1),
    helpText(PLAIN_COMMANDS, "", identity, PLAIN_NAMES, true, UNSERVED, NO_TRUST),
  );
  await world.says("!help count", ref.thread);
  assert.equal(
    world.shown(ref).at(-1),
    helpText(PLAIN_COMMANDS, "count", identity, PLAIN_NAMES, true, UNSERVED, NO_TRUST),
  );
});

test("!help for an agent with no commands lists none", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new NoCommands() });
  const ref = await world.opened();
  await world.says("!help", ref.thread);
  const answer = world.shown(ref).at(-1) ?? "";
  assert.equal(answer, helpText(null, "", identity, PLAIN_NAMES, false, UNSERVED, NO_TRUST));
  assert.ok(!answer.includes(named(texts.HELP_AGENT, PLAIN_NAMES)));
  assert.ok(!answer.includes(named(texts.HELP_UNBOUND, PLAIN_NAMES)));
});

test("a mistyped word gets the full list", async (t) => {
  const world = await MessagesWorld.make(t);
  await world.says("!bypass maybe");
  assert.deepEqual(world.inChannel().slice(1), [
    helpText(null, "", identity, PLAIN_NAMES, true, UNSERVED, NO_TRUST),
  ]);
});

// What the plain agent and the memory chat can serve, written out.
const PLAIN_OFFER: GuideOffer = {
  folderTrust: false,
  models: false,
  efforts: true,
  bypass: false,
  plan: false,
  commands: true,
  questions: true,
  backgroundTasks: false,
  sessionListing: true,
  loadedContext: false,
  fileUpload: false,
  threadTags: false,
  threadDelete: false,
  shell: false,
  updates: false,
};

test("!guide is answered where it was typed", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  await world.says("!guide");
  assert.equal(world.inChannel().at(-1), guideText(PLAIN_NAMES, PLAIN_OFFER));
  await world.says("!guide", ref.thread);
  assert.equal(world.shown(ref).at(-1), guideText(PLAIN_NAMES, PLAIN_OFFER));
});

test("!guide offers what the agent and the chat declare", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new WithBypass(), files: true });
  await world.says("!guide");
  assert.equal(
    world.inChannel().at(-1),
    guideText(PLAIN_NAMES, { ...PLAIN_OFFER, bypass: true, fileUpload: true }),
  );
});

// --- !plan

test("!plan belongs to a session", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new WithPlan() });
  await world.says("!plan");
  assert.equal(world.inChannel().at(-1), texts.PLAN_TOP_LEVEL);
});

test("!plan with a request says the word takes none, in the channel and in a thread", async (t) => {
  const agent = new WithPlan();
  const world = await MessagesWorld.make(t, { agent });
  await world.says("!plan\nPrepare a plan for a file");
  assert.equal(world.inChannel().at(-1), texts.PLAN_TAKES_NO_TEXT);
  const ref = await world.opened();
  await world.says("!plan prepare a plan", ref.thread);
  assert.equal(world.shown(ref).at(-1), texts.PLAN_TAKES_NO_TEXT);
  assert.deepEqual(agent.modes, []);
});

test("!plan switches a started session to plan mode and !plan off returns to its mode", async (t) => {
  const agent = new WithPlan();
  const world = await MessagesWorld.make(t, { agent });
  const ref = await world.opened();
  const before = JSON.stringify(world.state.thread(ref.channel, ref.thread));
  await world.says("!plan", ref.thread);
  assert.equal(world.shown(ref).at(-1), named(texts.PLAN_ON_THREAD, PLAIN_NAMES));
  await world.says("!status", ref.thread);
  assert.ok(world.shown(ref).at(-1)?.includes("Mode: `planning`"));
  await world.says("!plan off", ref.thread);
  assert.equal(world.shown(ref).at(-1), texts.PLAN_OFF_THREAD);
  assert.deepEqual(agent.modes, ["planning", "standard"]);
  // Session only: nothing is stored about plan mode.
  assert.equal(JSON.stringify(world.state.thread(ref.channel, ref.thread)), before);
});

test("!plan off with bypass on returns to bypass, and !status shows plan meanwhile", async (t) => {
  const agent = new WithPlan();
  const world = await MessagesWorld.make(t, { agent });
  const ref = await world.opened();
  await world.says("!bypass on", ref.thread);
  await world.says("!plan", ref.thread);
  await world.says("!status", ref.thread);
  assert.ok(world.shown(ref).at(-1)?.includes("Mode: `planning`"));
  await world.says("!plan off", ref.thread);
  assert.deepEqual(agent.modes, ["unrestricted", "planning", "unrestricted"]);
  await world.says("!status", ref.thread);
  assert.ok(world.shown(ref).at(-1)?.includes("Mode: `unrestricted`"));
});

test("!bypass on during plan mode ends plan mode", async (t) => {
  const agent = new WithPlan();
  const world = await MessagesWorld.make(t, { agent });
  const ref = await world.opened();
  await world.says("!plan", ref.thread);
  await world.says("!bypass on", ref.thread);
  await world.says("!status", ref.thread);
  assert.ok(world.shown(ref).at(-1)?.includes("Mode: `unrestricted`"));
});

test("!plan before the setup is started changes nothing", async (t) => {
  const agent = new WithPlan();
  const world = await MessagesWorld.make(t, { agent });
  const ref = world.chat.openThread(world.channel);
  world.sessions.open(ref.channel, ref.thread);
  await world.says("!plan", ref.thread);
  assert.equal(world.shown(ref).at(-1), texts.PLAN_BEFORE_START);
  assert.deepEqual(agent.modes, []);
});

test("!plan for an agent with no plan mode says so and changes nothing", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  await world.says("!plan", ref.thread);
  assert.equal(world.shown(ref).at(-1), named(texts.PLAN_UNAVAILABLE, PLAIN_NAMES));
  await world.says("!plan off", ref.thread);
  assert.equal(world.shown(ref).at(-1), named(texts.PLAN_UNAVAILABLE, PLAIN_NAMES));
});

test("!guide and !help offer plan only to an agent with a plan mode", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new WithPlan() });
  await world.says("!guide");
  assert.equal(
    world.inChannel().at(-1),
    guideText(PLAIN_NAMES, { ...PLAIN_OFFER, bypass: true, plan: true }),
  );
});

// --- !bind and !resume

test("!bind with a folder binds the channel, and alone offers the folders", async (t) => {
  const world = await MessagesWorld.make(t);
  mkdirSync(join(world.folder, "docs"));
  await world.says("!bind docs");
  assert.equal(world.state.channel(world.channel)?.directory, join(world.folder, "docs"));
  assert.equal(
    world.inChannel().at(-1),
    fill(texts.BIND_OK, { directory: join(world.folder, "docs") }),
  );
  await world.says("!bind");
  const lists = world.chat.lists();
  assert.equal(lists.length, 1);
  assert.equal(lists[0]?.list.type, "folders");
});

test("!bind inside a session's thread, or with a folder in a thread without one, says it works in the channel", async (t) => {
  const world = await MessagesWorld.make(t);
  mkdirSync(join(world.folder, "docs"));
  const ref = await world.opened();
  const said = fill(texts.WORD_IN_THREAD, { word: "bind" });
  await world.says("!bind docs", ref.thread);
  await world.says("!bind", ref.thread);
  assert.deepEqual(
    world.shown(ref).filter((line) => line === said),
    [said, said],
  );
  const outside = world.chat.openThread(world.channel);
  await world.says("!bind docs", outside.thread);
  assert.equal(world.shown(outside).at(-1), said);
  assert.equal(world.state.channel(world.channel)?.directory, world.folder);
  await world.says("!bind", outside.thread);
  assert.equal(world.chat.lists().length, 1, "alone it lists the folders, as in the channel");
});

test("!resume offers the folder's sessions in the channel and is refused inside a thread", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  const said = fill(texts.WORD_IN_THREAD, { word: "resume" });
  await world.says("!resume", ref.thread);
  assert.equal(world.shown(ref).at(-1), said);
  const outside = world.chat.openThread(world.channel);
  await world.says("!resume", outside.thread);
  assert.equal(world.shown(outside).at(-1), said);
  assert.deepEqual(world.chat.lists(), []);
  await world.says("!resume");
  assert.equal(world.chat.lists().length, 1);
  assert.equal(world.chat.lists()[0]?.list.type, "sessions");
});

// --- !bypass

test("!bypass belongs to a session", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new WithBypass() });
  await world.says("!bypass on");
  assert.equal(world.inChannel().at(-1), texts.BYPASS_TOP_LEVEL);
});

test("!bypass switches a started session and keeps the choice", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new WithBypass() });
  const ref = await world.opened();
  await world.says("!bypass on", ref.thread);
  assert.equal(world.shown(ref).at(-1), texts.BYPASS_ON_THREAD);
  assert.equal(world.state.thread(ref.channel, ref.thread)?.bypass, true);
  await world.says("!bypass off", ref.thread);
  assert.equal(world.shown(ref).at(-1), named(texts.BYPASS_OFF_THREAD, PLAIN_NAMES));
  assert.equal(world.state.thread(ref.channel, ref.thread)?.bypass, false);
  assert.deepEqual(world.chat.strayCalls(), [], "no reaction on a chat that has none");
});

test("!bypass before the setup is started changes nothing", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new WithBypass() });
  const ref = world.chat.openThread(world.channel);
  world.sessions.open(ref.channel, ref.thread);
  await world.says("!bypass on", ref.thread);
  assert.equal(world.shown(ref).at(-1), texts.BYPASS_BEFORE_START);
  assert.equal(world.state.thread(ref.channel, ref.thread)?.bypass, null);
});

test("!bypass for an agent with no bypass mode says so and stores nothing", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  const before = world.state.thread(ref.channel, ref.thread)?.bypass;
  await world.says("!bypass on", ref.thread);
  assert.equal(world.shown(ref).at(-1), named(texts.BYPASS_UNAVAILABLE, PLAIN_NAMES));
  assert.equal(world.state.thread(ref.channel, ref.thread)?.bypass, before);
  await world.says("!bypass off", ref.thread);
  assert.equal(world.shown(ref).at(-1), named(texts.BYPASS_UNAVAILABLE, PLAIN_NAMES));
  assert.equal(world.state.thread(ref.channel, ref.thread)?.bypass, before);
  assert.notEqual(before, true);
});

test("a word that took effect is marked on the message only where the chat has reactions", async (t) => {
  const plain = await MessagesWorld.make(t, { agent: new WithBypass() });
  const ref = await plain.opened();
  await plain.says("!bypass on", ref.thread);
  assert.deepEqual(plain.chat.strayCalls(), []);

  const reacting = await MessagesWorld.make(t, { agent: new WithBypass(), reactions: true });
  const there = await reacting.opened();
  const word = await reacting.says("!bypass on", there.thread);
  assert.ok(reacting.chat.strayCalls().includes(`acknowledge ${word.id}`));
});

// --- !stop

test("!stop in the channel stops what runs there, and says when nothing does", async (t) => {
  const world = await MessagesWorld.make(t);
  await world.says("!stop");
  assert.equal(world.inChannel().at(-1), texts.NOTHING_TO_STOP);
  const ref = await world.opened();
  (world.agent as PlainAgent).next(hold());
  await world.says("a long job", ref.thread);
  await world.settle();
  assert.equal(world.sessions.get(ref.channel, ref.thread)?.busy, true);
  await world.says("!stop");
  assert.equal(world.inChannel().at(-1), texts.STOPPED_CHANNEL);
  await world.settle();
  assert.equal(world.sessions.get(ref.channel, ref.thread)?.busy, false);
});

test("!stop in the channel drops the goals of its open sessions too", async (t) => {
  // The maintainer, 2026-10-21: a thread's stop keeps the goal, as the terminal's Esc does; the
  // channel's stops everything, goals included.
  const condition = "the files a1.txt to a20.txt exist";
  const agent = new WithGoals();
  const world = await MessagesWorld.make(t, { agent });
  const ref = await world.opened();
  agent.next(goalChanged({ state: "set", condition }), hold());
  await world.says("!goal the files a1.txt to a20.txt exist", ref.thread);
  await world.settle();
  await world.says("!stop");
  assert.equal(world.inChannel().at(-1), texts.STOPPED_CHANNEL);
  assert.equal(agent.cleared, 1);
  assert.equal(world.sessions.get(ref.channel, ref.thread)?.goal, null);
});

test("!stop in a session's thread answers with a post of the thread", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  await world.says("!stop", ref.thread);
  assert.equal(world.shown(ref).at(-1), texts.NOTHING_TO_STOP_THREAD);
  (world.agent as PlainAgent).next(hold());
  await world.says("a long job", ref.thread);
  await world.settle();
  await world.says("!stop", ref.thread);
  assert.equal(world.shown(ref).at(-1), texts.STOPPED_THREAD);
});

test("!stop on a goal says the goal is still set, and not once it is achieved", async (t) => {
  // The stop ends the turn, not the goal: the next message resumes it (measured 2026-10-20).
  const condition = "the files a1.txt to a20.txt exist";
  const world = await MessagesWorld.make(t, { agent: new WithGoals() });
  const ref = await world.opened();
  (world.agent as PlainAgent).next(goalChanged({ state: "set", condition }), hold());
  await world.says("!goal the files a1.txt to a20.txt exist", ref.thread);
  await world.settle();
  await world.says("!stop", ref.thread);
  assert.equal(
    world.shown(ref).at(-1),
    `${texts.STOPPED_THREAD}\n${fill(texts.GOAL_STILL_ACTIVE, { condition })}`,
  );
  (world.agent as PlainAgent).next(
    goalChanged({ state: "achieved", condition, turns: 2, durationMs: 46_068, tokens: 3291 }),
    hold(),
  );
  await world.says("go on", ref.thread);
  await world.settle();
  await world.says("!stop", ref.thread);
  assert.equal(world.shown(ref).at(-1), texts.STOPPED_THREAD);
});

test("!stop in a thread that holds no session stops nothing and says where to send it", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  (world.agent as PlainAgent).next(hold());
  await world.says("a long job", ref.thread);
  await world.settle();
  const outside = world.chat.openThread(world.channel);
  await world.says("!stop", outside.thread);
  assert.equal(world.shown(outside).at(-1), texts.STOP_OUTSIDE_SESSION);
  assert.equal(world.sessions.get(ref.channel, ref.thread)?.busy, true);
});

// --- !open

test("!open belongs to a session", async (t) => {
  const world = await MessagesWorld.make(t, { files: true });
  await world.says("!open notes.md");
  assert.equal(world.inChannel().at(-1), texts.OPEN_TOP_LEVEL);
  assert.deepEqual(world.fileCalls, []);
});

test("!open in a session's thread hands the folder and the words to a chat that can share a file", async (t) => {
  const world = await MessagesWorld.make(t, { files: true });
  const ref = await world.opened();
  await world.says("!open notes.md", ref.thread);
  await world.says("!open", ref.thread);
  assert.deepEqual(world.fileCalls, [
    [ref, world.folder, "notes.md"],
    [ref, world.folder, ""],
  ]);
});

test("!open in a chat that cannot share a file says so", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  await world.says("!open notes.md", ref.thread);
  assert.equal(world.shown(ref).at(-1), named(texts.OPEN_UNAVAILABLE, PLAIN_NAMES));
});

test("a failure of !open reaches the owner where the word was typed", async (t) => {
  const world = await MessagesWorld.make(t, { files: true, openFails: true });
  const ref = await world.opened();
  await world.says("!open notes.md", ref.thread);
  assert.equal(
    world.shown(ref).at(-1),
    fill(named(texts.ERROR_REPLY, PLAIN_NAMES), { error: "Error" }),
  );
});

// --- !tag and !untag

const SESSION_ID = (world: MessagesWorld, ref: { channel: string; thread: string }) =>
  world.state.thread(ref.channel, ref.thread)?.sessionId;

test("!tag and !untag belong to a session, in the channel and in a thread that holds none", async (t) => {
  const agent = new WithSessionTags();
  const world = await MessagesWorld.make(t, { agent, tags: true });
  await world.says("!tag devops");
  await world.says("!untag");
  const answers = () => world.inChannel().filter((line) => line === texts.TAG_TOP_LEVEL);
  assert.equal(answers().length, 2);
  const outside = world.chat.openThread(world.channel);
  await world.says("!tag devops", outside.thread);
  await world.says("!untag", outside.thread);
  assert.equal(answers().length, 4, "a thread that holds no session is answered in the channel");
  assert.deepEqual(world.tagCalls, []);
  assert.deepEqual(agent.tagCalls, []);
});

test("!tag in a session's thread tags the thread, then the agent's session, and marks the word", async (t) => {
  const agent = new WithSessionTags();
  const world = await MessagesWorld.make(t, { agent, tags: true, reactions: true });
  const ref = await world.opened();
  const id = SESSION_ID(world, ref);
  assert.ok(typeof id === "string" && id !== "");
  const word = await world.says("!tag Release-2.1", ref.thread);
  assert.deepEqual(world.tagCalls, [[ref, "Release-2.1"]]);
  assert.deepEqual(agent.tagCalls, [[world.folder, id, "Release-2.1"]]);
  assert.ok(world.chat.strayCalls().includes(`acknowledge ${word.id}`));
  // The mark is the whole answer: the owner's word is the last line of the thread.
  assert.equal(world.shown(ref).at(-1), "!tag Release-2.1");
  // A second tag replaces the first at the agent and the chat alike.
  await world.says("!tag ops", ref.thread);
  assert.deepEqual(world.tagCalls.at(-1), [ref, "ops"]);
  assert.deepEqual(agent.tagCalls.at(-1), [world.folder, id, "ops"]);
});

test("!untag clears the thread's tag, then the agent's", async (t) => {
  const agent = new WithSessionTags();
  const world = await MessagesWorld.make(t, { agent, tags: true, reactions: true });
  const ref = await world.opened();
  const id = SESSION_ID(world, ref) as string;
  const word = await world.says("!untag", ref.thread);
  assert.deepEqual(world.tagCalls, [[ref, null]]);
  assert.deepEqual(agent.tagCalls, [[world.folder, id, null]]);
  assert.ok(world.chat.strayCalls().includes(`acknowledge ${word.id}`));
});

test("!tag with no name, or a name the rule refuses, shows the help and changes nothing", async (t) => {
  const agent = new WithSessionTags();
  const world = await MessagesWorld.make(t, { agent, tags: true });
  const ref = await world.opened();
  for (const typed of ["!tag", "!tag two words", "!tag a/b", `!tag ${"x".repeat(41)}`]) {
    const before = world.shown(ref).length;
    await world.says(typed, ref.thread);
    assert.equal(world.shown(ref).length, before + 2, typed); // the word, then the help
    assert.ok(world.shown(ref).at(-1)?.includes("`!tag <name>`"), typed);
  }
  assert.deepEqual(world.tagCalls, []);
  assert.deepEqual(agent.tagCalls, []);
});

test("!tag in a chat that cannot tag a thread says so, and the help leaves both words out", async (t) => {
  const agent = new WithSessionTags();
  const world = await MessagesWorld.make(t, { agent });
  const ref = await world.opened();
  await world.says("!tag devops", ref.thread);
  assert.equal(world.shown(ref).at(-1), named(texts.TAG_UNAVAILABLE, PLAIN_NAMES));
  await world.says("!untag", ref.thread);
  assert.equal(world.shown(ref).at(-1), named(texts.TAG_UNAVAILABLE, PLAIN_NAMES));
  assert.deepEqual(world.tagCalls, []);
  assert.deepEqual(agent.tagCalls, []);
  await world.says("!help", ref.thread);
  assert.ok(!world.shown(ref).at(-1)?.includes("`!tag"));
  assert.ok(!world.shown(ref).at(-1)?.includes("`!untag"));
});

test("a refusal of the chat reaches the owner in the chat's name, and the agent's session is left alone", async (t) => {
  const agent = new WithSessionTags();
  const world = await MessagesWorld.make(t, { agent, tags: true, tagFails: true, reactions: true });
  const ref = await world.opened();
  const word = await world.says("!tag devops", ref.thread);
  assert.equal(
    world.shown(ref).at(-1),
    fill(named(texts.TAG_FAILED, PLAIN_NAMES), { error: "message_not_found" }),
  );
  assert.deepEqual(agent.tagCalls, []);
  assert.ok(!world.chat.strayCalls().includes(`acknowledge ${word.id}`));
  // The edit may have landed before the pin was refused: the line must not say nothing changed.
  const line = world.shown(ref).at(-1) ?? "";
  assert.ok(!line.includes("nothing changed"), line);
  assert.ok(line.includes("may show part of the change") && line.includes("`!untag`"), line);
});

test("a failure of the agent's tag leaves the chat's tag, tells the owner and still marks the word", async (t) => {
  const agent = new WithSessionTags(true);
  const world = await MessagesWorld.make(t, { agent, tags: true, reactions: true });
  const ref = await world.opened();
  const word = await world.says("!tag devops", ref.thread);
  assert.deepEqual(world.tagCalls, [[ref, "devops"]]);
  assert.equal(world.shown(ref).at(-1), named(texts.TAG_AGENT_FAILED, PLAIN_NAMES));
  assert.ok(world.chat.strayCalls().includes(`acknowledge ${word.id}`));
});

test("a thread whose session has no id yet is tagged in the chat alone", async (t) => {
  const agent = new WithSessionTags();
  const world = await MessagesWorld.make(t, { agent, tags: true });
  const ref = world.chat.openThread(world.channel);
  world.sessions.open(ref.channel, ref.thread);
  assert.equal(SESSION_ID(world, ref), null);
  await world.says("!tag devops", ref.thread);
  assert.deepEqual(world.tagCalls, [[ref, "devops"]]);
  assert.deepEqual(agent.tagCalls, []);
  assert.ok(!world.shown(ref).includes(named(texts.TAG_AGENT_FAILED, PLAIN_NAMES)));
});

test("an agent that declares no session tags is left out: the chat is tagged alone", async (t) => {
  const world = await MessagesWorld.make(t, { tags: true });
  const ref = await world.opened();
  await world.says("!tag devops", ref.thread);
  assert.deepEqual(world.tagCalls, [[ref, "devops"]]);
  assert.equal("tagSession" in world.agent, false);
});

// --- A failure of a word

test("a word that fails in the channel is answered in the channel, and in a thread under the word", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  t.mock.method(world.sessions, "sessionsOf", () => {
    throw new TypeError("boom");
  });
  const failed = fill(named(texts.ERROR_REPLY, PLAIN_NAMES), { error: "TypeError" });
  await world.says("!status");
  assert.equal(world.inChannel().at(-1), failed);
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session !== null);
  t.mock.method(session, "status", async () => {
    throw new TypeError("boom");
  });
  await world.says("!status", ref.thread);
  assert.equal(world.shown(ref).at(-1), failed);
});

// --- !delete-thread

test("!delete-thread belongs to a session, in the channel and in a thread that holds none", async (t) => {
  const world = await MessagesWorld.make(t, { deletes: true });
  await world.says("!delete-thread");
  const answers = () => world.inChannel().filter((line) => line === texts.DELETE_THREAD_TOP_LEVEL);
  assert.equal(answers().length, 1);
  const outside = world.chat.openThread(world.channel);
  await world.says("!delete-thread", outside.thread);
  assert.equal(answers().length, 2, "a thread that holds no session is answered in the channel");
  assert.deepEqual(world.deleteCalls, []);
});

test("!delete-thread in an idle session's thread hands the confirmation to the chat", async (t) => {
  const world = await MessagesWorld.make(t, { deletes: true });
  const ref = await world.opened();
  await world.says("!delete-thread", ref.thread);
  assert.deepEqual(world.deleteCalls, [ref]);
  // The chat asks the owner; the core adds no line of its own.
  assert.equal(world.shown(ref).at(-1), "!delete-thread");
});

test("!delete-thread while the session works is refused, and nothing is asked", async (t) => {
  const world = await MessagesWorld.make(t, { deletes: true });
  const ref = await world.opened();
  (world.agent as PlainAgent).next(hold());
  await world.says("a long job", ref.thread);
  await world.settle();
  await world.says("!delete-thread", ref.thread);
  assert.equal(world.shown(ref).at(-1), texts.DELETE_THREAD_BUSY);
  assert.deepEqual(world.deleteCalls, []);
});

test("!delete-thread in a chat that cannot delete a thread says so, and the help leaves it out", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  await world.says("!delete-thread", ref.thread);
  assert.equal(world.shown(ref).at(-1), named(texts.DELETE_THREAD_UNAVAILABLE, PLAIN_NAMES));
  assert.deepEqual(world.deleteCalls, []);
  await world.says("!help", ref.thread);
  assert.ok(!world.shown(ref).at(-1)?.includes("`!delete-thread"));
});
