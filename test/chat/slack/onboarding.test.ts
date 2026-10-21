/**
 * The Slack questions of `allaboard setup`, run against fake clients: no real token is sent
 * anywhere. The fake answers by the token it is asked with.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { slackChat } from "../../../src/chat/slack/module.ts";
import {
  APP_NAME_LIMIT,
  creationLink,
  manifestOf,
  slackSetup,
} from "../../../src/chat/slack/onboarding.ts";
import { DEFAULT_INSTANCE } from "../../../src/core/instance.ts";
import type { SetupQuestion } from "../../../src/module-setup.ts";
import {
  FakeSlack,
  networkDown,
  OTHER_TEAM,
  OWNER,
  rejected,
  TEAM,
} from "../../support/fake-slack.ts";

const BOT = `${"xox"}b-000-fake`;
const APP = `${"xap"}p-000-fake`;
const USER = `${"xox"}p-000-fake`;

function clients(answers: Record<string, FakeSlack["responses"]>) {
  const calls: string[] = [];
  const probe = (token: string) => {
    const slack = new FakeSlack();
    Object.assign(slack.responses, answers[token] ?? {});
    calls.push(token);
    return slack;
  };
  return { probe, calls };
}

const WHO = { ok: true, team: "acme", team_id: TEAM, user: "allaboard", user_id: "U000BOT" };
const ME = { ok: true, team: "acme", team_id: TEAM, user: "alice", user_id: OWNER };

function ask(questions: readonly SetupQuestion[], variable: string): SetupQuestion {
  return questions.find((q) => q.variable === variable) as SetupQuestion;
}

test("the questions are the three tokens and the member ID, in the order the screen shows", () => {
  const { questions } = slackSetup(DEFAULT_INSTANCE, clients({}).probe);
  assert.deepEqual(
    questions.map((q) => [q.variable, q.secret, q.optional]),
    [
      ["SLACK_BOT_TOKEN", true, false],
      ["SLACK_APP_TOKEN", true, false],
      ["SLACK_USER_TOKEN", true, true],
      ["SLACK_OWNER_USER_ID", false, false],
    ],
  );
});

test("a token of the wrong kind is refused before Slack is called", async () => {
  const { probe, calls } = clients({});
  const { questions } = slackSetup(DEFAULT_INSTANCE, probe);
  assert.deepEqual(await ask(questions, "SLACK_BOT_TOKEN").check(APP), {
    refusal: "SLACK_BOT_TOKEN must be the Bot User OAuth Token (xoxb-...)",
  });
  assert.deepEqual(await ask(questions, "SLACK_APP_TOKEN").check(BOT), {
    refusal: "SLACK_APP_TOKEN must be the app-level token (xapp-...)",
  });
  assert.deepEqual(await ask(questions, "SLACK_USER_TOKEN").check(BOT), {
    refusal: "SLACK_USER_TOKEN must be the User OAuth Token (xoxp-...)",
  });
  assert.deepEqual(calls, []);
});

test("a bot token Slack accepts shows the workspace and the bot", async () => {
  const { probe } = clients({ [BOT]: { "auth.test": WHO } });
  const { questions } = slackSetup(DEFAULT_INSTANCE, probe);
  assert.deepEqual(await ask(questions, "SLACK_BOT_TOKEN").check(BOT), {
    note: 'workspace "acme", bot "allaboard"',
  });
});

test("each refusal code of Slack is said, and none quotes the token", async () => {
  for (const code of [
    "invalid_auth",
    "not_authed",
    "token_revoked",
    "account_inactive",
    "token_expired",
    "not_allowed_token_type",
    "other_thing",
  ]) {
    const { probe } = clients({ [BOT]: { "auth.test": rejected(code) } });
    const result = await ask(
      slackSetup(DEFAULT_INSTANCE, probe).questions,
      "SLACK_BOT_TOKEN",
    ).check(BOT);
    assert.ok("refusal" in result, code);
    assert.ok(!result.refusal.includes(BOT), code);
    if (code !== "invalid_auth" && code !== "not_authed")
      assert.ok(result.refusal.includes(code), result.refusal);
  }
});

test("a network failure is said as such", async () => {
  const { probe } = clients({ [BOT]: { "auth.test": networkDown() } });
  const result = await ask(slackSetup(DEFAULT_INSTANCE, probe).questions, "SLACK_BOT_TOKEN").check(
    BOT,
  );
  assert.ok("refusal" in result);
  assert.match(result.refusal, /Could not reach Slack/);
});

test("the app-level token is checked with apps.connections.open", async () => {
  const good = clients({
    [APP]: { "apps.connections.open": { ok: true, url: "wss://example.invalid/link" } },
  });
  assert.deepEqual(
    await ask(slackSetup(DEFAULT_INSTANCE, good.probe).questions, "SLACK_APP_TOKEN").check(APP),
    {},
  );
  const bad = clients({ [APP]: { "apps.connections.open": rejected("invalid_auth") } });
  const result = await ask(
    slackSetup(DEFAULT_INSTANCE, bad.probe).questions,
    "SLACK_APP_TOKEN",
  ).check(APP);
  assert.ok("refusal" in result);
});

test("a user token in the bot's workspace sets the owner's ID, which skips its question", async () => {
  const { probe } = clients({ [BOT]: { "auth.test": WHO }, [USER]: { "auth.test": ME } });
  const { questions } = slackSetup(DEFAULT_INSTANCE, probe);
  await ask(questions, "SLACK_BOT_TOKEN").check(BOT);
  assert.deepEqual(await ask(questions, "SLACK_USER_TOKEN").check(USER), {
    note: `you are ${OWNER}`,
    set: { SLACK_OWNER_USER_ID: OWNER },
  });
});

test("a user token of another workspace is refused", async () => {
  const { probe } = clients({
    [BOT]: { "auth.test": WHO },
    [USER]: { "auth.test": { ...ME, team_id: OTHER_TEAM } },
  });
  const { questions } = slackSetup(DEFAULT_INSTANCE, probe);
  await ask(questions, "SLACK_BOT_TOKEN").check(BOT);
  const result = await ask(questions, "SLACK_USER_TOKEN").check(USER);
  assert.ok("refusal" in result);
  assert.match(result.refusal, /another workspace/);
});

test("the member ID is checked by its shape alone", async () => {
  const { questions } = slackSetup(DEFAULT_INSTANCE, clients({}).probe);
  const owner = ask(questions, "SLACK_OWNER_USER_ID");
  assert.deepEqual(await owner.check("U000ALICE"), {});
  assert.deepEqual(await owner.check("W012AB3CD45"), {});
  for (const bad of ["alice", "u000alice", "U12", "C000CHAN1 "]) {
    assert.ok("refusal" in (await owner.check(bad)), bad);
  }
});

test("the link carries the manifest, encoded", () => {
  const { json } = manifestOf(DEFAULT_INSTANCE);
  const link = creationLink(json);
  const url = new URL(link);
  assert.equal(`${url.origin}${url.pathname}`, "https://api.slack.com/apps");
  assert.equal(url.searchParams.get("new_app"), "1");
  assert.equal(url.searchParams.get("manifest_json"), json);
  const manifest = JSON.parse(json);
  assert.equal(manifest.display_information.name, "allaboard");
  assert.equal(manifest.features.bot_user.display_name, "allaboard");
  assert.ok(manifest.settings.socket_mode_enabled);
});

test("a named instance renames the app and the bot; a long name cuts the app's name only", () => {
  const dev = JSON.parse(manifestOf({ name: "dev" }).json);
  assert.equal(dev.display_information.name, "allaboard-dev");
  assert.equal(dev.features.bot_user.display_name, "allaboard-dev");
  const long = "x".repeat(32);
  const { json, cut } = manifestOf({ name: long });
  const manifest = JSON.parse(json);
  assert.ok(cut);
  assert.equal(manifest.display_information.name.length, APP_NAME_LIMIT);
  assert.equal(manifest.features.bot_user.display_name, `allaboard-${long}`);
  assert.ok(
    slackSetup({ name: long }, clients({}).probe).intro.some((line) =>
      line.includes(`${APP_NAME_LIMIT}`),
    ),
  );
  assert.ok(
    !slackSetup({ name: "dev" }, clients({}).probe).intro.some((line) => line.includes("cut")),
  );
});

test("the intro prints the link and the install step", () => {
  const { intro } = slackSetup(DEFAULT_INSTANCE, clients({}).probe);
  assert.match(intro[0] as string, /^1\. Create the Slack app\./);
  assert.match(
    intro[1] as string,
    /^ {3}https:\/\/api\.slack\.com\/apps\?new_app=1&manifest_json=/,
  );
  assert.match(intro.at(-1) as string, /Install App/);
});

test("the Slack entry declares the setup and passes its probe on", async () => {
  const { probe } = clients({ [BOT]: { "auth.test": WHO } });
  const entry = slackChat({ probe });
  assert.ok(entry.setup);
  const bot = ask(entry.setup(DEFAULT_INSTANCE).questions, "SLACK_BOT_TOKEN");
  assert.ok(!("refusal" in (await bot.check(BOT))));
});
