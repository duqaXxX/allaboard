/**
 * Whether the provider can tag a thread follows the owner's user token: with it, `assemble` hands
 * the provider a `RootEditor` (for tags, and for titles) on the checked owner client (the same client the thread deleter
 * uses); without it, the provider declares no `threadTags` and has no `tagThread`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { logger, slackChat } from "../../../src/chat/slack/module.ts";
import type { ChatContext } from "../../../src/core/port.ts";
import { FakeClock, FakeSlack, OWNER, TEAM } from "../../support/fake-slack.ts";

const BOT_TOKEN = `${"xox"}b-000-fake`;
const APP_TOKEN = `${"xap"}p-000-fake`;
const USER_TOKEN = `${"xox"}p-000-fake`;

// What `auth.test` answers for a user token: the client adds the scopes from the response's
// X-OAuth-Scopes header to `response_metadata.scopes` (@slack/web-api 8.2.0, WebClient.js).
const SCOPES = ["identify", "chat:write", "pins:write"];

async function built(
  userToken: string | null,
  scopes: readonly string[] | null = SCOPES,
  owner = new FakeSlack(),
) {
  const scratch = mkdtempSync(join(tmpdir(), "allaboard-tags-"));
  try {
    const slack = new FakeSlack();
    owner.responses["auth.test"] = {
      ok: true,
      team_id: TEAM,
      user_id: OWNER,
      ...(scopes !== null && { response_metadata: { scopes: [...scopes] } }),
    };
    const clock = new FakeClock();
    const context: ChatContext = {
      variables: {
        SLACK_BOT_TOKEN: BOT_TOKEN,
        SLACK_APP_TOKEN: APP_TOKEN,
        SLACK_OWNER_USER_ID: OWNER,
        ...(userToken !== null && { SLACK_USER_TOKEN: userToken }),
      },
      allowedRoot: "/",
      scratchDir: join(scratch, "uploads"),
      clock,
      steady: clock,
      core: () => assert.fail("the core was read"),
    };
    const chat = await slackChat({
      clients: { bot: () => [slack, slack], owner: () => owner },
      receiver: () => ({ init: () => {}, start: async () => {}, stop: async () => {} }),
    }).build(context);
    return { chat, slack, owner };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("without the owner's token the provider cannot tag a thread", async () => {
  const { chat } = await built(null);
  assert.equal(chat.capabilities.threadTags, false);
  assert.equal(chat.tagThread, undefined);
  assert.equal(chat.capabilities.threadTitles, false);
  assert.equal(chat.titleThread, undefined);
});

test("with the owner's token the provider tags a root through the owner's client", async () => {
  const { chat, slack, owner } = await built(USER_TOKEN);
  assert.equal(chat.capabilities.threadTags, true);
  assert.equal(typeof chat.tagThread, "function");
  const ts = "1780000000.000001";
  slack.responses["conversations.replies"] = {
    ok: true,
    messages: [
      {
        type: "message",
        user: OWNER,
        ts,
        text: "fix the footer",
        blocks: [
          {
            type: "rich_text",
            elements: [
              { type: "rich_text_section", elements: [{ type: "text", text: "fix the footer" }] },
            ],
          },
        ],
      },
    ],
    has_more: false,
  };
  await chat.tagThread?.({ channel: "C000CHAN", thread: ts }, "devops");
  // The bot only reads; the edit and the pin are the owner's (the first message is the owner's).
  // The channel's line, told the thread changed, looks once for a line an earlier run left.
  assert.deepEqual(
    slack.apiCalls.map((call) => call.method),
    ["auth.test", "conversations.replies", "conversations.history"],
  );
  assert.deepEqual(
    owner.apiCalls.map((call) => call.method),
    ["auth.test", "chat.update", "pins.add"],
  );
});

test("a title is written by the owner's client alone, with no pin", async () => {
  const { chat, slack, owner } = await built(USER_TOKEN, ["identify", "chat:write"]);
  const ts = "1780000000.000002";
  slack.responses["conversations.replies"] = {
    ok: true,
    messages: [{ type: "message", user: OWNER, ts, text: "fix the footer" }],
    has_more: false,
  };
  const kept: string[] = [];
  await chat.titleThread?.({ channel: "C000CHAN", thread: ts }, "Footer fix", (text) => {
    kept.push(text);
  });
  assert.deepEqual(kept, ["fix the footer"]);
  assert.deepEqual(
    owner.apiCalls.map((call) => call.method),
    ["auth.test", "chat.update"],
  );
  assert.equal(owner.apiCalls[1]?.args.text, "*Footer fix*");
});

/** The warnings the module's logger got, as one text. */
function warnings(t: TestContext): () => string {
  const warned = t.mock.method(logger, "warning", () => {});
  return () => warned.mock.calls.map((call) => String(call.arguments[0])).join("\n");
}

test("a user token without pins:write offers no tags, says so once, and still deletes and titles", async (t) => {
  const said = warnings(t);
  const { chat, owner } = await built(USER_TOKEN, ["identify", "chat:write"]);
  assert.equal(chat.capabilities.threadTags, false);
  assert.equal(chat.capabilities.threadTitles, true);
  assert.equal(typeof chat.titleThread, "function");
  assert.equal(chat.tagThread, undefined);
  assert.match(said(), /pins:write/);
  assert.match(said(), /!tag is not offered until the app is reinstalled with that scope/);
  assert.equal(said().split("\n").length, 1);
  assert.deepEqual(
    owner.apiCalls.map((call) => call.method),
    ["auth.test"],
  );
});

test("a user token whose scopes Slack does not list offers no tags, and the log says so", async (t) => {
  const said = warnings(t);
  const { chat } = await built(USER_TOKEN, null);
  assert.equal(chat.capabilities.threadTags, false);
  assert.equal(chat.tagThread, undefined);
  assert.match(said(), /lists no scopes/);
});

test("with pins:write nothing is logged", async (t) => {
  const said = warnings(t);
  await built(USER_TOKEN);
  assert.equal(said(), "");
});
