/**
 * `!clean-channel` as the Slack app draws it: the question only the owner sees, in the channel, and its two
 * buttons. The harness is `test/support/slack-app.ts`; the click is an ephemeral one
 * (`ephemeralClick`), with no thread in its container, since the question has none.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLEAN_CHANNEL_CANCEL,
  CLEAN_CHANNEL_CONFIRM,
} from "../../../../src/chat/slack/clean-channel.ts";
import * as slackTexts from "../../../../src/chat/slack/texts.ts";
import { fill, named, texts } from "../../../../src/core/port.ts";
import { CHANNEL, OWNER } from "../../../support/fake-slack.ts";
import { NAMES } from "../../../support/names.ts";
import {
  type Body,
  ephemeralClick,
  respondedTo,
  worldFor,
  worldOf,
} from "../../../support/slack-app.ts";

function click(actionId: string): Body {
  const body = ephemeralClick(actionId, "");
  delete body.container.thread_ts;
  return body;
}

test("the question is posted for the owner alone, in the channel, with its two buttons", async (t) => {
  const world = worldOf(t);
  await world.built.askClean(CHANNEL);
  const [post] = world.slack.callsTo("chat.postEphemeral") as [Body];
  assert.equal(post.channel, CHANNEL);
  assert.equal(post.thread_ts, undefined);
  assert.equal(post.user, OWNER);
  const [section, actions] = post.blocks as [Body, Body];
  assert.equal(
    section.text.text,
    `*${slackTexts.HOME_CLEAN_TITLE}*\n${fill(slackTexts.CLEAN_WORD_TEXT, { threads: 3, busy: 1, pinned: 0 })}`,
  );
  assert.deepEqual(
    actions.elements.map((button: Body) => [button.action_id, button.style]),
    [
      [CLEAN_CHANNEL_CONFIRM, "danger"],
      [CLEAN_CHANNEL_CANCEL, undefined],
    ],
  );
  assert.equal(world.slack.callsTo("chat.postMessage").length, 0, "nothing that stays");
});

test("Clean up rewrites the question into the outcome, and adds no message", async (t) => {
  const responses = respondedTo(t);
  const world = worldOf(t);
  world.channelCleanLine = "how it went";
  await world.dispatch(click(CLEAN_CHANNEL_CONFIRM));
  await world.settle();
  assert.deepEqual(
    responses.map((posted) => posted.text),
    [slackTexts.CLEAN_WORD_STARTED, "how it went"],
  );
  assert.ok(responses.every((posted) => posted.replace_original === true));
  assert.deepEqual(world.channelCleans, [CHANNEL]);
  assert.deepEqual(world.ephemerals(), []);
});

test("past what the question can be rewritten, the outcome is a message of its own", async (t) => {
  respondedTo(t, 404);
  const world = worldOf(t);
  world.channelCleanLine = "how it went";
  await world.dispatch(click(CLEAN_CHANNEL_CONFIRM));
  await world.settle();
  assert.deepEqual(world.channelCleans, [CHANNEL]);
  assert.deepEqual(world.ephemerals(), [slackTexts.CLEAN_WORD_STARTED, "how it went"]);
  const told = world.slack.callsTo("chat.postEphemeral").at(-1) as Body;
  assert.equal(told.thread_ts, undefined);
});

test("Cancel takes the question away and cleans nothing", async (t) => {
  const responses = respondedTo(t);
  const world = worldOf(t);
  await world.dispatch(click(CLEAN_CHANNEL_CANCEL));
  await world.settle();
  assert.deepEqual(responses, [{ delete_original: true }]);
  assert.deepEqual(world.channelCleans, []);
});

test("a question left from a run with the token stays, and says why", async (t) => {
  const responses = respondedTo(t);
  const world = worldFor(t)({ noThreadDelete: true });
  await world.dispatch(click(CLEAN_CHANNEL_CONFIRM));
  await world.settle();
  assert.deepEqual(responses, []);
  assert.ok(world.ephemerals().at(-1)?.includes(named(texts.CLEAN_UNAVAILABLE, NAMES)));
});
