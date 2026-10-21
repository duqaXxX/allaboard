/**
 * The update of allaboard as Slack draws it in a channel: the offer `!allaboard update`
 * posts and the line only the owner sees. The Home tab's line is in `home.test.ts`, the owner
 * checks of both buttons in `app/owner-checks.test.ts`, the whole path from the owner's message in
 * `app/slack-app-update.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OwnerList } from "../../../src/chat/seam.ts";
import { UPDATE_ACTION, updateBlocks } from "../../../src/chat/slack/update.ts";
import { CHANNEL, rejected } from "../../support/fake-slack.ts";
import { madeChat } from "../../support/slack-chat.ts";

const OFFER = {
  type: "update",
  from: "0.3.0",
  to: "0.3.1",
  changelog: "https://example.test/changelog/v0.3.1",
  sharing: [],
} satisfies OwnerList;

const TITLE = "Update allaboard 0.3.0 → 0.3.1";

test("the offer is a line with the link and the button, then what a click waits for", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(updateBlocks(OFFER, TITLE))), [
    {
      type: "section",
      block_id: "update",
      text: {
        type: "mrkdwn",
        text: "Update allaboard 0.3.0 → 0.3.1 · <https://example.test/changelog/v0.3.1|What changed>",
      },
      accessory: {
        type: "button",
        action_id: UPDATE_ACTION,
        text: { type: "plain_text", text: "Update to 0.3.1" },
        value: "0.3.1",
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Running turns finish first, for up to 29 minutes, then allaboard restarts.",
        },
      ],
    },
  ]);
});

test("the offer names the other instances that restart with this one", () => {
  const lines = (sharing: OwnerList & { type: "update" }) =>
    updateBlocks(sharing, TITLE)
      .slice(2)
      .map((block) => JSON.stringify(block));
  assert.equal(lines({ ...OFFER, sharing: [] }).length, 0);
  assert.match(
    lines({ ...OFFER, sharing: ["work2"] })[0] ?? "",
    /Instance `work2` runs the same copy and restarts too\./,
  );
  assert.match(
    lines({ ...OFFER, sharing: [null, "work2"] })[0] ?? "",
    /Instances the default instance and `work2` run the same copy and restart too\./,
  );
});

test("a link with markup characters is escaped, not read as markup", () => {
  const [line] = updateBlocks({ ...OFFER, changelog: "https://example.test/a?b=1&c=<2>" }, TITLE);
  assert.match(
    JSON.stringify(line),
    /<https:\/\/example\.test\/a\?b=1&amp;c=&lt;2&gt;\|What changed>/,
  );
});

test("the channel posts the offer as a normal message with a control", async () => {
  const { slack, chat } = madeChat();
  await chat.channel(CHANNEL).offer(OFFER, TITLE);
  const [post] = slack.callsTo("chat.postMessage");
  assert.equal(post?.channel, CHANNEL);
  assert.equal(post?.text, TITLE);
  assert.ok(!("thread_ts" in (post ?? {})));
  assert.deepEqual(post?.blocks, JSON.parse(JSON.stringify(updateBlocks(OFFER, TITLE))));
});

test("the offer is rewritten into a notice with nothing left to press", async () => {
  const { slack, chat } = madeChat();
  await chat.channel(CHANNEL).rewrite("1780000000.000009", "Installing allaboard 0.3.1…");
  const [update] = slack.callsTo("chat.update");
  assert.deepEqual(update?.blocks, [
    { type: "context", elements: [{ type: "mrkdwn", text: "Installing allaboard 0.3.1…" }] },
  ]);
  assert.ok(!JSON.stringify(update).includes("action_id"));
});

test("a withdrawn offer is deleted", async () => {
  const { slack, chat } = madeChat();
  assert.equal(await chat.channel(CHANNEL).withdraw("1780000000.000009"), true);
  assert.deepEqual(slack.callsTo("chat.delete"), [{ channel: CHANNEL, ts: "1780000000.000009" }]);
});

test("tell is an ephemeral line in the channel for the owner, small and grey", async () => {
  const { slack, chat } = madeChat();
  await chat.channel(CHANNEL).tell("An update to 0.3.1 is already under way.");
  assert.deepEqual(slack.callsTo("chat.postEphemeral"), [
    {
      channel: CHANNEL,
      user: "U000ALICE",
      text: "An update to 0.3.1 is already under way.",
      blocks: [
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: "An update to 0.3.1 is already under way." }],
        },
      ],
    },
  ]);
  assert.deepEqual(slack.callsTo("chat.postMessage"), []);
});

test("tell rejects with a ChatError named by Slack's code, and does nothing once stopped", async () => {
  const { slack, chat } = madeChat();
  slack.responses["chat.postEphemeral"] = rejected("channel_not_found");
  await assert.rejects(
    chat.channel(CHANNEL).tell("words"),
    (error: unknown) => error instanceof Error && error.name === "channel_not_found",
  );
  await chat.stop();
  slack.apiCalls.length = 0;
  await chat.channel(CHANNEL).tell("words");
  await chat.channel(CHANNEL).offer(OFFER, TITLE);
  assert.deepEqual(slack.apiCalls, []);
});
