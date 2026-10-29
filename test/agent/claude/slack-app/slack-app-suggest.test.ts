/**
 * A `!word` that is no command, as the Slack app draws it: the field and the buttons only
 * the owner sees, Enter, a pick, and what each hands to the core. The harness is
 * `test/support/slack-app.ts`; the core is the real one over a scripted agent whose commands are
 * the recorded `server-info.json`. The click is an ephemeral one (`ephemeralClick`), and what
 * Bolt's `respond` posts is caught at the global `fetch` (`respondedTo`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import {
  parsePick,
  SUGGEST_EDIT,
  SUGGEST_MENU,
  SUGGEST_PICK,
  SUGGEST_SEND,
  suggestionBlocks,
  typedMessage,
} from "../../../../src/chat/slack/suggest.ts";
import * as slackTexts from "../../../../src/chat/slack/texts.ts";
import * as texts from "../../../../src/core/texts.ts";
import { fill } from "../../../../src/core/texts.ts";
import { BOT, CHANNEL, OWNER, STRANGER, THREAD } from "../../../support/fake-slack.ts";
import { NAMES } from "../../../support/names.ts";
import {
  type Body,
  ephemeralPick,
  fieldEnter,
  fieldSend,
  reply,
  respondedTo,
  type World,
  worldOf,
} from "../../../support/slack-app.ts";

const SESSION = "68da9311-0000-4000-8000-0000000005e5";

/** A thread that holds a session the daemon resumes on the next message. */
function threadWithSession(world: World): void {
  world.state.openThread(CHANNEL, THREAD, SESSION);
}

/** The ephemeral posts of the suggestion, in order. */
function suggestions(world: World): Body[] {
  return world.slack
    .callsTo("chat.postEphemeral")
    .filter((args) => (args as Body).text === slackTexts.SUGGEST_FALLBACK) as Body[];
}

/** The field of a suggestion, its Send button, its rows and its menus. */
function parts(post: Body): { field: Body; send: Body; rows: Body[]; actions: Body[] } {
  const blocks = post.blocks as Body[];
  return {
    field: blocks[0] as Body,
    send: (blocks[1] as Body).elements[0] as Body,
    rows: blocks.filter((block) => block.type === "section"),
    actions: blocks.slice(2).filter((block) => block.type === "actions"),
  };
}

test("an unknown word in a thread posts the field, holding what was typed, and the nearest commands", async (t) => {
  const world = worldOf(t);
  threadWithSession(world);
  const typed = reply("!mo opus", THREAD);
  await world.dispatch(typed);
  await world.settle();
  const [post] = suggestions(world);
  assert.ok(post);
  assert.equal(post.channel, CHANNEL);
  assert.equal(post.thread_ts, THREAD);
  assert.equal(post.user, OWNER);
  const { field, rows } = parts(post);
  assert.equal(field.type, "input");
  assert.equal(field.dispatch_action, true);
  assert.equal(field.element.type, "plain_text_input");
  assert.equal(field.element.action_id, SUGGEST_EDIT);
  assert.equal(field.element.initial_value, "!mo opus", "exactly what was typed");
  assert.deepEqual(field.element.dispatch_action_config, {
    trigger_actions_on: ["on_enter_pressed"],
  });
  assert.equal(typedMessage(field.block_id), typed.event.ts, "the owner's own message");
  const { send } = parts(post);
  assert.equal(send.action_id, SUGGEST_SEND, "Send sits right under the field");
  assert.equal(send.text.text, slackTexts.SUGGEST_SEND);
  assert.equal(send.value, field.block_id, "the button names the field");
  const buttons = rows.map((row) => row.accessory);
  assert.ok(buttons.length > 0 && buttons.length <= 5);
  assert.ok(buttons.every((button) => button.action_id === SUGGEST_PICK));
  assert.ok(buttons.some((button) => button.text.text === "!model opus"));
  assert.deepEqual(world.queries(), [], "nothing reached the agent");
});

test("! alone lists every command: the words of allaboard as rows, the session's in one menu", async (t) => {
  const world = worldOf(t);
  threadWithSession(world);
  await world.dispatch(reply("!", THREAD));
  await world.settle();
  const [post] = suggestions(world);
  assert.ok(post);
  const { field, rows, actions } = parts(post);
  assert.equal(field.element.initial_value, "!");
  const labels = rows.map((row) => row.accessory.text.text);
  for (const word of ["!guide", "!help", "!status", "!stop"])
    assert.ok(labels.includes(word), word);
  assert.ok((post.blocks as Body[]).length <= 50);
  const [menu] = actions.flatMap((action) => action.elements as Body[]);
  assert.equal(menu?.type, "static_select");
  assert.equal(menu?.action_id, SUGGEST_MENU);
  assert.ok(menu.options.length > 10 && menu.options.length <= 100);
  assert.ok(menu.options.every((option: Body) => option.text.text.length <= 75));
  assert.deepEqual(world.queries(), []);
});

test("a word nothing looks like is told under the message, with no field", async (t) => {
  const world = worldOf(t);
  threadWithSession(world);
  await world.dispatch(reply("!zzzzzzzzzz", THREAD));
  await world.settle();
  assert.deepEqual(suggestions(world), []);
  assert.deepEqual(world.ephemerals().at(-1), fill(texts.NO_SUCH_COMMAND, { word: "!zzzzzzzzzz" }));
  assert.deepEqual(world.queries(), []);
});

test("a command the session lists runs at once, with no suggestion", async (t) => {
  const world = worldOf(t);
  threadWithSession(world);
  await world.dispatch(reply("!model opus", THREAD));
  await world.until(() => isDeepStrictEqual(world.queries(), ["/model opus"]));
  assert.deepEqual(suggestions(world), []);
});

test("typed text with < & > is shown in the field as typed", async (t) => {
  const world = worldOf(t);
  threadWithSession(world);
  await world.dispatch(reply("!mo a &lt; b &amp; c", THREAD));
  await world.settle();
  const [post] = suggestions(world);
  assert.equal(parts(post as Body).field.element.initial_value, "!mo a < b & c");
});

/** The suggestion for `typedText`, and the field's block id. */
async function suggested(
  world: World,
  typedText: string,
): Promise<{ post: Body; blockId: string; value: (index: number) => string }> {
  threadWithSession(world);
  await world.dispatch(reply(typedText, THREAD));
  await world.settle();
  const [post] = suggestions(world);
  assert.ok(post);
  const { field, rows } = parts(post);
  const first = rows[0]?.accessory.value as string;
  const id = parsePick(first)?.id as string;
  return { post, blockId: field.block_id, value: (index) => `${id}:${index}` };
}

test("Enter takes the suggestion away and hands the text to the core as the typed message: a command runs", async (t) => {
  const responses = respondedTo(t);
  const world = worldOf(t);
  const { blockId } = await suggested(world, "!mo opus");
  await world.dispatch(fieldEnter(SUGGEST_EDIT, blockId, "!model opus", THREAD));
  await world.until(() => isDeepStrictEqual(world.queries(), ["/model opus"]));
  assert.deepEqual(responses, [{ delete_original: true }]);
});

test("Send hands the field's text as edited, never sent with Enter: a command runs", async (t) => {
  const responses = respondedTo(t);
  const world = worldOf(t);
  const { blockId } = await suggested(world, "!mo opus");
  await world.dispatch(fieldSend(SUGGEST_SEND, blockId, SUGGEST_EDIT, "!model sonnet", THREAD));
  await world.until(() => isDeepStrictEqual(world.queries(), ["/model sonnet"]));
  assert.deepEqual(responses, [{ delete_original: true }]);
});

test("Send with no text for its field in the click does nothing", async (t) => {
  const responses = respondedTo(t);
  const world = worldOf(t);
  const { blockId } = await suggested(world, "!mo opus");
  const click = fieldSend(SUGGEST_SEND, blockId, SUGGEST_EDIT, "!model sonnet", THREAD);
  delete click.state;
  await world.dispatch(click);
  await world.settle();
  assert.deepEqual(world.queries(), []);
  assert.deepEqual(responses, []);
});

test("Enter then Send on the same field hands the text over once", async (t) => {
  respondedTo(t);
  const world = worldOf(t);
  const { blockId } = await suggested(world, "!mo opus");
  await world.dispatch(fieldEnter(SUGGEST_EDIT, blockId, "!model opus", THREAD));
  await world.dispatch(fieldSend(SUGGEST_SEND, blockId, SUGGEST_EDIT, "!model opus", THREAD));
  await world.until(() => world.queries().length > 0);
  await world.settle();
  assert.deepEqual(world.queries(), ["/model opus"]);
});

test("Enter with another unknown word is suggested for again, and nothing is sent", async (t) => {
  respondedTo(t);
  const world = worldOf(t);
  const { blockId } = await suggested(world, "!mo opus");
  await world.dispatch(fieldEnter(SUGGEST_EDIT, blockId, "!cmp", THREAD));
  await world.settle();
  const posts = suggestions(world);
  assert.equal(posts.length, 2);
  assert.equal(parts(posts[1] as Body).field.element.initial_value, "!cmp");
  assert.deepEqual(world.queries(), []);
});

test("Enter with an empty field does nothing", async (t) => {
  const responses = respondedTo(t);
  const world = worldOf(t);
  const { blockId } = await suggested(world, "!mo opus");
  await world.dispatch(fieldEnter(SUGGEST_EDIT, blockId, "  ", THREAD));
  await world.settle();
  assert.equal(suggestions(world).length, 1);
  assert.deepEqual(responses, []);
});

test("a button takes the message away and posts a new one, its command and the typed arguments in the field", async (t) => {
  const responses = respondedTo(t);
  const world = worldOf(t);
  const { post, blockId, value } = await suggested(world, "!mo opus");
  const { rows } = parts(post);
  const model = rows.findIndex((row) => row.accessory.text.text === "!model opus");
  assert.ok(model >= 0);
  await world.dispatch(ephemeralPick(SUGGEST_PICK, value(model), THREAD));
  await world.settle();
  assert.deepEqual(responses, [{ delete_original: true }]);
  const posts = suggestions(world);
  assert.equal(posts.length, 2);
  const { field } = parts(posts[1] as Body);
  assert.equal(field.element.initial_value, "!model opus");
  assert.notEqual(field.block_id, blockId, "a new block, or Slack keeps the old text");
  assert.equal(typedMessage(field.block_id), typedMessage(blockId));
  assert.deepEqual(world.queries(), [], "a pick runs nothing");
});

test("a choice from the menu puts the command in the field", async (t) => {
  respondedTo(t);
  const world = worldOf(t);
  const { post } = await suggested(world, "!");
  const [menu] = parts(post).actions.flatMap((action) => action.elements as Body[]);
  assert.ok(menu);
  const option = menu.options[0] as Body;
  await world.dispatch(ephemeralPick(SUGGEST_MENU, option.value, THREAD));
  await world.settle();
  const posts = suggestions(world);
  assert.equal(posts.length, 2);
  const { field } = parts(posts[1] as Body);
  assert.equal(field.element.initial_value, `!${parsedName(posts[0] as Body, option.value)}`);
});

/** The command name a menu value names, read back from the first post's options. */
function parsedName(post: Body, value: string): string {
  const [menu] = parts(post).actions.flatMap((action) => action.elements as Body[]);
  const option = ((menu as Body).options as Body[]).find((o) => o.value === value) as Body;
  return String(option.text.text).split(" ")[0]?.slice(1) ?? "";
}

test("a pick of a suggestion the daemon no longer holds says so", async (t) => {
  const responses = respondedTo(t);
  const world = worldOf(t);
  threadWithSession(world);
  await world.dispatch(ephemeralPick(SUGGEST_PICK, "forgotten-id:0", THREAD));
  await world.settle();
  assert.deepEqual(responses, [{ delete_original: true }]);
  assert.equal(world.ephemerals().at(-1), slackTexts.SUGGEST_EXPIRED);
});

test("the suggestion is not a prompt: a thread without a session answers as it always did", async (t) => {
  const world = worldOf(t);
  await world.dispatch(reply("!mo opus", THREAD));
  await world.settle();
  assert.deepEqual(suggestions(world), []);
  assert.deepEqual(world.ephemerals(), [texts.NOT_A_SESSION]);
});

test("the line under the field and its Send button says how to send the word as text", async (t) => {
  const world = worldOf(t);
  threadWithSession(world);
  await world.dispatch(reply("!mo opus", THREAD));
  await world.settle();
  const [post] = suggestions(world);
  const context = ((post as Body).blocks as Body[])[2] as Body;
  assert.equal(context.elements[0].text, slackTexts.SUGGEST_HINT);
  assert.ok(slackTexts.SUGGEST_HINT.includes("as in `\\!important`"));
});

test("a second Enter on the same field hands over nothing", async (t) => {
  respondedTo(t);
  const world = worldOf(t);
  const { blockId } = await suggested(world, "!mo opus");
  await world.dispatch(fieldEnter(SUGGEST_EDIT, blockId, "!model opus", THREAD));
  await world.dispatch(fieldEnter(SUGGEST_EDIT, blockId, "!model opus", THREAD));
  await world.until(() => world.queries().length > 0);
  await world.settle();
  assert.deepEqual(world.queries(), ["/model opus"]);
});

test("a text longer than the field takes is not put in it, cut: the field says so", async (t) => {
  const world = worldOf(t);
  threadWithSession(world);
  await world.dispatch(reply(`!mo ${"x".repeat(3500)}`, THREAD));
  await world.settle();
  const [post] = suggestions(world);
  assert.ok(post);
  const { element } = parts(post).field;
  assert.equal(element.initial_value, undefined);
  assert.equal(element.placeholder.text, slackTexts.SUGGEST_TOO_LONG);
});

test("past 100 commands the menu holds them all, in groups of 100", () => {
  const candidates = Array.from({ length: 250 }, (_, i) => ({
    name: `c${String(i).padStart(3, "0")}`,
    usage: `!c${String(i).padStart(3, "0")}`,
    description: "A command",
    group: "agent" as const,
    text: `!c${String(i).padStart(3, "0")}`,
  }));
  const blocks = suggestionBlocks(
    { typed: "!", message: "1790192011.000009", all: true, candidates },
    "an-id",
    1,
    "!",
    NAMES,
  );
  const menu = (blocks.at(-1) as Body).elements[0] as Body;
  assert.equal(menu.options, undefined);
  const groups = menu.option_groups as Body[];
  assert.deepEqual(
    groups.map((g) => [g.label.text, g.options.length]),
    [
      ["!c000 … !c099", 100],
      ["!c100 … !c199", 100],
      ["!c200 … !c249", 50],
    ],
  );
  assert.equal(groups[2]?.options.at(-1).value, "an-id:249");
});

test("Enter refused for the channel leaves the field working once the channel is allowed", async (t) => {
  respondedTo(t);
  const world = worldOf(t);
  const { blockId } = await suggested(world, "!mo opus");
  world.slack.responses["conversations.members"] = { ok: true, members: [OWNER, BOT, STRANGER] };
  await world.dispatch(fieldEnter(SUGGEST_EDIT, blockId, "!model opus", THREAD));
  await world.settle();
  assert.deepEqual(world.queries(), []);
  world.slack.responses["conversations.members"] = { ok: true, members: [OWNER, BOT] };
  await world.dispatch(fieldSend(SUGGEST_SEND, blockId, SUGGEST_EDIT, "!model opus", THREAD));
  await world.until(() => isDeepStrictEqual(world.queries(), ["/model opus"]));
});

test("a button's text is cut at 75 characters", async (t) => {
  const world = worldOf(t);
  threadWithSession(world);
  await world.dispatch(reply(`!mo ${"y".repeat(200)}`, THREAD));
  await world.settle();
  const [post] = suggestions(world);
  assert.ok(post);
  const labels = parts(post).rows.map((row) => row.accessory.text.text as string);
  assert.ok(labels.length > 0);
  for (const label of labels) assert.ok(Array.from(label).length <= 75, label);
  assert.ok(labels.some((label) => label.endsWith("…")));
});
