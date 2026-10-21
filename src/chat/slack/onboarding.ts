/**
 * What `allaboard setup` asks for Slack: the link that creates the app from the package's manifest,
 * the three tokens, each checked with Slack as it is pasted, and the owner's member ID. The core
 * runs the flow (`core/wizard.ts`); this file holds the questions and what a Slack answer means.
 *
 * A token is checked with the one call that needs no scope (Slack's method reference, read
 * 2026-10-18): `auth.test` for the bot and user tokens, `apps.connections.open` for the app-level
 * token, the only method documented for it. The latter only asks for a WebSocket URL; nothing
 * here connects to it.
 */
import { readFileSync } from "node:fs";
import { WebAPIPlatformError, WebClient } from "@slack/web-api";
import type { Instance } from "../../core/port.ts";
import type { Check, ModuleSetup, SetupQuestion } from "../../module-setup.ts";
import { silentLogger } from "./quiet-logger.ts";
import { REQUEST_TIMEOUT_MS, SENT_ONCE } from "./reply/clients.ts";
import { describe } from "./reply/errors.ts";
import { type TokenVariable, wrongKind } from "./tokens.ts";

/** The two Slack calls a pasted token is checked with. */
export type ProbeClient = Pick<WebClient, "auth" | "apps">;

/** The longest name Slack takes for an app (manifest reference, read 2026-10-17). */
export const APP_NAME_LIMIT = 35;

/** A client that sends each call once and logs nothing: the answer or the error is all there is. */
function probeClient(token: string): ProbeClient {
  return new WebClient(token, {
    ...SENT_ONCE,
    timeout: REQUEST_TIMEOUT_MS,
    logger: silentLogger(),
  });
}

const MANIFEST = new URL("../../../slack-app-manifest.json", import.meta.url);

/**
 * The package's manifest as the JSON that `api.slack.com/apps?new_app=1` takes, named for
 * `instance`: a named instance's app and bot are called `allaboard-<name>`, the app's name cut to
 * `APP_NAME_LIMIT`. `cut` says whether it was.
 */
export function manifestOf(instance: Instance): { json: string; cut: boolean } {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
    display_information: { name: string };
    features: { bot_user: { display_name: string } };
  };
  let cut = false;
  if (instance.name !== null) {
    const name = `${manifest.display_information.name}-${instance.name}`;
    cut = name.length > APP_NAME_LIMIT;
    manifest.display_information.name = name.slice(0, APP_NAME_LIMIT);
    manifest.features.bot_user.display_name = name;
  }
  return { json: JSON.stringify(manifest), cut };
}

/** The link that opens Slack's "create an app" page with `manifest` filled in. */
export function creationLink(manifestJson: string): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(manifestJson)}`;
}

const MEMBER_ID = /^[UW][A-Z0-9]{7,}$/;

/** What Slack's refusal code means for the owner pasting a token. */
function refusalOf(variable: TokenVariable, code: string): string {
  switch (code) {
    case "invalid_auth":
    case "not_authed":
      return `Slack does not accept this ${variable}: check you copied all of it.`;
    case "token_revoked":
    case "token_expired":
    case "account_inactive":
      return `Slack says this token is no longer valid (${code}): create a new one.`;
    case "not_allowed_token_type":
      return `Slack says this is not the kind of token ${variable} takes (${code}).`;
    default:
      return `Slack refused this token (${code}).`;
  }
}

/** Runs `call`; a refusal sentence when Slack refused the token or could not be reached. */
async function answered<T>(
  variable: TokenVariable,
  call: () => Promise<T>,
): Promise<{ answer: T } | { refusal: string }> {
  try {
    return { answer: await call() };
  } catch (error) {
    if (error instanceof WebAPIPlatformError) {
      return { refusal: refusalOf(variable, String(error.data.error)) };
    }
    return {
      refusal: `Could not reach Slack (${describe(error)}): check the connection and try again.`,
    };
  }
}

/** The questions of the Slack setup for `instance`; `probe` makes the client for a token. */
export function slackSetup(
  instance: Instance,
  probe: (token: string) => ProbeClient = probeClient,
): ModuleSetup {
  const { json, cut } = manifestOf(instance);
  // What the bot token turned out to be, which the user token is held against.
  let teamId: string | null = null;

  const bot: SetupQuestion = {
    variable: "SLACK_BOT_TOKEN",
    message: "Bot token (xoxb-…, OAuth & Permissions):",
    secret: true,
    optional: false,
    async check(token): Promise<Check> {
      const wrong = wrongKind("SLACK_BOT_TOKEN", token);
      if (wrong !== null) return { refusal: wrong };
      const result = await answered("SLACK_BOT_TOKEN", () => probe(token).auth.test());
      if ("refusal" in result) return result;
      teamId = result.answer.team_id ?? null;
      return { note: `workspace "${result.answer.team}", bot "${result.answer.user}"` };
    },
  };

  const app: SetupQuestion = {
    variable: "SLACK_APP_TOKEN",
    message: "App-level token (xapp-…, Basic Information > App-Level Tokens):",
    secret: true,
    optional: false,
    async check(token): Promise<Check> {
      const wrong = wrongKind("SLACK_APP_TOKEN", token);
      if (wrong !== null) return { refusal: wrong };
      const result = await answered("SLACK_APP_TOKEN", () => probe(token).apps.connections.open());
      return "refusal" in result ? result : {};
    },
  };

  const user: SetupQuestion = {
    variable: "SLACK_USER_TOKEN",
    message: "User token (xoxp-…, optional, Enter to skip):",
    secret: true,
    optional: true,
    sets: ["SLACK_OWNER_USER_ID"],
    async check(token): Promise<Check> {
      const wrong = wrongKind("SLACK_USER_TOKEN", token);
      if (wrong !== null) return { refusal: wrong };
      const result = await answered("SLACK_USER_TOKEN", () => probe(token).auth.test());
      if ("refusal" in result) return result;
      const { user_id: userId, team_id: owners } = result.answer;
      if (userId === undefined || owners === undefined) {
        return { refusal: "Slack did not say whose token this is." };
      }
      // The Home tab deletes under this token's name: it must be the owner's, in the bot's workspace.
      if (owners !== teamId) {
        return { refusal: "This token belongs to another workspace than the bot token." };
      }
      return { note: `you are ${userId}`, set: { SLACK_OWNER_USER_ID: userId } };
    },
  };

  const owner: SetupQuestion = {
    variable: "SLACK_OWNER_USER_ID",
    message: "Your Slack member ID (Profile > ⋮ > Copy member ID):",
    secret: false,
    optional: false,
    check: async (id): Promise<Check> =>
      MEMBER_ID.test(id)
        ? {}
        : {
            refusal:
              "A member ID is a U or W followed by capital letters and digits, such as U012AB3CD.",
          },
  };

  return {
    intro: [
      "1. Create the Slack app. Open this link, pick your workspace and confirm:",
      `   ${creationLink(json)}`,
      ...(cut
        ? [`   (The app's name is cut to Slack's limit of ${APP_NAME_LIMIT} characters.)`]
        : []),
      "   Then install the app to the workspace (Install App in the sidebar).",
    ],
    questions: [bot, app, user, owner],
  };
}
