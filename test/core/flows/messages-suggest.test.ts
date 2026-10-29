/**
 * A `!word` that is no command, in a chat that suggests commands: the owner gets a field
 * holding what they typed and the commands it could mean, and nothing reaches the agent. Over the
 * memory chat; a provider's own side is tested under `test/chat/`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { WORD } from "../../../src/core/commands.ts";
import * as texts from "../../../src/core/texts.ts";
import { fill } from "../../../src/core/texts.ts";
import { OWNER, SOMEONE } from "../../support/memory-chat.ts";
import { hold, PLAIN_COMMANDS, type PlainAgent } from "../../support/plain-agent.ts";
import { MessagesWorld } from "./messages-world.ts";

test("an unknown word in a thread is suggested for, with the typed text and the arguments kept", async (t) => {
  const world = await MessagesWorld.make(t, { suggests: true });
  const ref = await world.opened();
  const typed = await world.says("!ech hello world", ref.thread);
  await world.settle();
  const [shown] = world.chat.suggestions();
  assert.ok(shown);
  assert.deepEqual(shown.ref, ref);
  assert.equal(shown.suggestion.typed, "!ech hello world");
  assert.equal(shown.suggestion.message, typed.id);
  assert.equal(shown.suggestion.all, false);
  assert.ok(shown.suggestion.candidates.length <= 5);
  const [first] = shown.suggestion.candidates;
  assert.deepEqual(first, {
    name: "echo",
    usage: "!echo <text>",
    description: "Say the text back",
    group: "agent",
    text: "!echo hello world",
  });
  assert.deepEqual(await world.prompts(), ["first"], "nothing reached the agent");
});

test("a word nothing looks like is told, and nothing is suggested or sent", async (t) => {
  const world = await MessagesWorld.make(t, { suggests: true });
  const ref = await world.opened();
  await world.says("!zzzzzzzz", ref.thread);
  await world.settle();
  assert.deepEqual(world.chat.suggestions(), []);
  assert.equal(world.shown(ref).at(-1), fill(texts.NO_SUCH_COMMAND, { word: "!zzzzzzzz" }));
  assert.ok(world.shown(ref).at(-1)?.includes("put anything before the `!`, as in `\\!important`"));
  assert.deepEqual(await world.prompts(), ["first"]);
});

test("! alone asks for every command: the daemon's words, then the session's", async (t) => {
  const world = await MessagesWorld.make(t, { suggests: true });
  const ref = await world.opened();
  await world.says("!", ref.thread);
  await world.settle();
  const [shown] = world.chat.suggestions();
  assert.ok(shown);
  assert.equal(shown.suggestion.typed, "!");
  assert.equal(shown.suggestion.all, true);
  const names = shown.suggestion.candidates.map((c) => c.name);
  assert.ok(names.includes(WORD.help) && names.includes(WORD.guide));
  assert.deepEqual(
    shown.suggestion.candidates.filter((c) => c.group === "agent").map((c) => c.name),
    PLAIN_COMMANDS.map((c) => c.name).toSorted(),
  );
  assert.deepEqual(await world.prompts(), ["first"]);
});

test("a command the session lists runs at once, as before", async (t) => {
  const world = await MessagesWorld.make(t, { suggests: true });
  const ref = await world.opened();
  await world.says("!echo hi", ref.thread);
  assert.deepEqual(await world.prompts(), ["first", ":echo hi"]);
  assert.deepEqual(world.chat.suggestions(), []);
});

test("an alias of a listed command is not suggested for: it is sent as before", async (t) => {
  const world = await MessagesWorld.make(t, { suggests: true });
  const ref = await world.opened();
  await world.says("!say hi", ref.thread);
  assert.deepEqual(await world.prompts(), ["first", "!say hi"]);
  assert.deepEqual(world.chat.suggestions(), []);
});

test("a daemon word is answered by the daemon, with no suggestion", async (t) => {
  const world = await MessagesWorld.make(t, { suggests: true });
  const ref = await world.opened();
  await world.says("!status", ref.thread);
  await world.settle();
  assert.deepEqual(world.chat.suggestions(), []);
  assert.deepEqual(await world.prompts(), ["first"]);
});

test("text that does not start with !, and ! followed by a space, are prompts", async (t) => {
  const world = await MessagesWorld.make(t, { suggests: true });
  const ref = await world.opened();
  await world.says("ech hello", ref.thread);
  await world.says("! ech", ref.thread);
  assert.deepEqual(await world.prompts(), ["first", "ech hello", "! ech"]);
  assert.deepEqual(world.chat.suggestions(), []);
});

test("a name the thread refuses is refused, not suggested", async (t) => {
  const world = await MessagesWorld.make(t, { suggests: true });
  const ref = await world.opened();
  await world.says("!restart", ref.thread);
  await world.settle();
  assert.equal(world.shown(ref).at(-1), texts.CLEAR_IN_THREAD);
  assert.deepEqual(world.chat.suggestions(), []);
});

test("a chat that does not suggest sends the word to the agent, and ! alone as a prompt", async (t) => {
  const world = await MessagesWorld.make(t);
  const ref = await world.opened();
  await world.says("!ech hello", ref.thread);
  await world.says("!", ref.thread);
  assert.deepEqual(await world.prompts(), ["first", "!ech hello", "!"]);
  assert.deepEqual(world.chat.suggestions(), []);
});

test("Enter in the field is read as typed text: a known command then runs", async (t) => {
  const world = await MessagesWorld.make(t, { suggests: true });
  const ref = await world.opened();
  await world.says("!ech hello", ref.thread);
  await world.settle();
  const [shown] = world.chat.suggestions();
  assert.ok(shown);
  assert.equal(await world.chat.as(OWNER).types(shown.message, "!echo hello"), true);
  assert.deepEqual(await world.prompts(), ["first", ":echo hello"]);
  assert.deepEqual(world.chat.suggestions(), []);
});

test("Enter with another unknown word is suggested for again, and sends nothing", async (t) => {
  const world = await MessagesWorld.make(t, { suggests: true });
  const ref = await world.opened();
  const typed = await world.says("!ech hello", ref.thread);
  await world.settle();
  const [shown] = world.chat.suggestions();
  assert.ok(shown);
  await world.chat.as(OWNER).types(shown.message, "!cont hello");
  await world.settle();
  const [again] = world.chat.suggestions();
  assert.equal(again?.suggestion.typed, "!cont hello");
  assert.equal(again?.suggestion.message, typed.id, "still the owner's own message");
  assert.deepEqual(await world.prompts(), ["first"]);
});

test("Enter in the field from somebody else reaches nothing", async (t) => {
  const world = await MessagesWorld.make(t, { suggests: true });
  const ref = await world.opened();
  await world.says("!ech hello", ref.thread);
  await world.settle();
  const [shown] = world.chat.suggestions();
  assert.ok(shown);
  assert.equal(await world.chat.as(SOMEONE).types(shown.message, "!echo hello"), false);
  assert.deepEqual(await world.prompts(), ["first"]);
  assert.equal(world.chat.suggestions().length, 1, "the suggestion is still there");
});

test("in the channel an unknown word opens its session and reaches the agent as before", async (t) => {
  const world = await MessagesWorld.make(t, { suggests: true });
  const sending = world.says("!ech hello");
  const { ref } = await world.asked("setup");
  await world.start(ref);
  await sending;
  assert.deepEqual(await world.prompts(), ["!ech hello"]);
  assert.deepEqual(world.chat.suggestions(), []);
});

test("! alone in the channel is a prompt, as before", async (t) => {
  const world = await MessagesWorld.make(t, { suggests: true });
  const sending = world.says("!");
  const { ref } = await world.asked("setup");
  await world.start(ref);
  await sending;
  assert.deepEqual(await world.prompts(), ["!"]);
  assert.deepEqual(world.chat.suggestions(), []);
});

test("a typo beside a busy session of the folder asks no hold; the text sent on Enter asks one", async (t) => {
  const world = await MessagesWorld.make(t, { suggests: true });
  const ref = await world.opened("one");
  const neighbour = await world.opened("two");
  (world.agent as PlainAgent).next(hold());
  await world.says("a long job", neighbour.thread);
  await world.settle();
  await world.says("!ech hi", ref.thread);
  await world.settle();
  assert.deepEqual(
    world.chat.requests().filter((r) => r.request.type === "hold"),
    [],
    "the typo asked nothing",
  );
  const [shown] = world.chat.suggestions();
  assert.ok(shown);
  const entering = world.chat.as(OWNER).types(shown.message, "!echo hi");
  const open = await world.asked("hold", ref);
  await world.chat.as(OWNER).answers(open.requestId, { type: "hold", send: true });
  await entering;
  assert.equal((await world.prompts()).filter((p) => p === ":echo hi").length, 1);
  assert.equal(world.chat.requests().filter((r) => r.request.type === "hold").length, 0);
});

/** A thread whose session ran and whose agent process was then closed, beside a busy one. */
async function closedBesideBusy(t: Parameters<typeof MessagesWorld.make>[0]) {
  const world = await MessagesWorld.make(t, { suggests: true });
  const ref = await world.opened("one");
  const neighbour = await world.opened("two");
  (world.agent as PlainAgent).next(hold());
  await world.says("a long job", neighbour.thread);
  await world.settle();
  await world.sessions.get(ref.channel, ref.thread)?.close();
  await world.settle();
  return { world, ref, started: (world.agent as PlainAgent).sessions.length };
}

test("a typo in a closed session beside a busy one asks the hold before its process starts", async (t) => {
  const { world, ref, started } = await closedBesideBusy(t);
  const typing = world.says("!ech hi", ref.thread);
  const open = await world.asked("hold", ref);
  assert.equal((world.agent as PlainAgent).sessions.length, started, "nothing started yet");
  assert.deepEqual(world.chat.suggestions(), []);
  await world.chat.as(OWNER).answers(open.requestId, { type: "hold", send: true });
  await typing;
  await world.settle();
  const [shown] = world.chat.suggestions();
  assert.ok(shown, "suggested for once connected");
  assert.equal(shown.suggestion.typed, "!ech hi");
  assert.ok(!(await world.prompts()).includes("!ech hi"), "nothing reached the agent");
});

test("Cancel on that hold starts no process and suggests nothing", async (t) => {
  const { world, ref, started } = await closedBesideBusy(t);
  const typing = world.says("!ech hi", ref.thread);
  const open = await world.asked("hold", ref);
  await world.chat.as(OWNER).answers(open.requestId, { type: "hold", send: false });
  await typing;
  await world.settle();
  assert.equal((world.agent as PlainAgent).sessions.length, started);
  assert.deepEqual(world.chat.suggestions(), []);
});

test("a word whose usage takes no argument is offered bare, so the suggestion cannot loop", async (t) => {
  const world = await MessagesWorld.make(t, { suggests: true });
  const ref = await world.opened();
  await world.says("!stop now", ref.thread);
  await world.settle();
  const [shown] = world.chat.suggestions();
  assert.ok(shown);
  const texts_ = shown.suggestion.candidates.map((c) => c.text);
  assert.ok(texts_.includes("!stop"));
  assert.ok(!texts_.includes("!stop now"));
});

test("the words a thread refuses are not offered, for a word or for ! alone", async (t) => {
  const world = await MessagesWorld.make(t, { suggests: true });
  const ref = await world.opened();
  await world.says("!bin", ref.thread);
  await world.says("!", ref.thread);
  await world.settle();
  for (const { suggestion } of world.chat.suggestions()) {
    const names = suggestion.candidates.map((c) => c.name);
    for (const refused of ["bind", "resume", "allaboard", "restart"]) {
      assert.ok(!names.includes(refused), refused);
    }
  }
});
