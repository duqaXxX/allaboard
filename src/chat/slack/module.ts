/**
 * The Slack module: the chat registry's entry for Slack. `build` makes everything of the Slack
 * side that does not need the core (the clients, the identity `auth.test` gives, the provider,
 * the thread deleter, the Home tab, the channel guard, the uploads folder); what needs the core
 * is read through `context.core()` when it is first used, which is after `build` returned.
 */

import { createHash } from "node:crypto";
import type { Receiver } from "@slack/bolt";
import {
  type ChatContext,
  type ChatEntry,
  ConfigError,
  type Listings,
  type Names,
  type SessionsPort,
} from "../../core/port.ts";
import { getLogger } from "../../log.ts";
import { setupGuide } from "../../version.ts";
import { ChatError, type ChatProvider } from "../seam.ts";
import type { Fetch } from "./app/answers.ts";
import { socketReceiver } from "./app/app.ts";
import { ChannelGuard, type Identity } from "./app/guards.ts";
import { prepareUploads } from "./attachments.ts";
import { ChannelLine, lineThread } from "./channel-line.ts";
import { type DeleterState, ThreadDeleter } from "./delete.ts";
import { Home } from "./home.ts";
import { MENTION_VARIABLE, mentionsOn, type ProbeClient, slackSetup } from "./onboarding.ts";
import { type ClientOptions, repliesClient, sharedClient } from "./reply/clients.ts";
import { describe } from "./reply/errors.ts";
import { UpdateLimiter } from "./reply/limiter.ts";
import { RootEditor } from "./tag.ts";
import { SETUP_SLACK_APP } from "./texts.ts";
import { SlackChat } from "./thread.ts";
import { wrongKind } from "./tokens.ts";
import { MODULE_WORDS } from "./words.ts";

export const logger = getLogger("allaboard.chat.slack.module");

/** The client of the Slack packages every call goes through; its type is all this file names. */
export type SlackClient = ReturnType<typeof sharedClient>;

/** The Slack clients of the daemon, one constructor for each way it calls. */
export interface Clients {
  /**
   * The shared client and the one replies are written with, on the bot token. `stopped` aborts
   * when the daemon stops (`ClientOptions.stopped`).
   */
  bot(token: string, stopped?: AbortSignal): readonly [shared: SlackClient, replies: SlackClient];
  /** The owner's own client, on the user token. */
  owner(token: string): SlackClient;
}

/**
 * The daemon's two Slack clients on one token (the retry policy is in `reply/clients.ts`): the
 * shared one for everything but a reply, and the one replies are written with.
 */
export function makeClients(
  botToken: string,
  options: ClientOptions = {},
): readonly [shared: SlackClient, replies: SlackClient] {
  return [sharedClient(botToken, options), repliesClient(botToken, options)];
}

export const CLIENTS: Clients = {
  bot: (token, stopped) => makeClients(token, stopped === undefined ? {} : { stopped }),
  owner: (token) => sharedClient(token),
};

/** What a test replaces; the real thing is the default of each. */
export interface SlackOptions {
  readonly clients?: Clients | undefined;
  /** Where Slack's payloads come from: `socketReceiver`. */
  readonly receiver?: ((appToken: string) => Receiver) | undefined;
  /** The folder of the files saved from messages; `ChatContext.scratchDir` when absent. */
  readonly uploads?: string | undefined;
  /** How a file is downloaded. */
  readonly fetch?: Fetch | undefined;
  /** `!open`'s listings. */
  readonly listings?: Listings | undefined;
  /** Wall-clock seconds, as a Slack ts counts them. */
  readonly now?: (() => number) | undefined;
  /** The client `allaboard setup` checks a pasted token with; a bare `WebClient` by default. */
  readonly probe?: ((token: string) => ProbeClient) | undefined;
}

/** The text of a field `auth.test` must answer, which a log line and an identity rely on. */
export function authField(
  answer: { readonly user_id?: string | undefined; readonly team_id?: string | undefined },
  key: "user_id" | "team_id",
): string {
  const value = answer[key];
  if (typeof value !== "string" || value === "") throw new Error(`auth.test answered no ${key}`);
  return value;
}

/** The owner's client and the scopes Slack reports for its token. */
export interface OwnerClient {
  readonly client: SlackClient;
  /** Null when Slack reported none: the client sets `response_metadata.scopes` from the response's `X-OAuth-Scopes` header. */
  readonly scopes: readonly string[] | null;
}

/**
 * The client of the owner's user token with the token's scopes, or null when no token is
 * configured. The token must be the owner's own, in the bot's workspace: what it writes is
 * written as whoever it belongs to, so it is checked once here for everything that uses it (the
 * thread deleter, the root editor). The scopes are read from the same `auth.test`: the Web API
 * reference for `auth.test` lists none (read 2026-10-19), but `@slack/web-api` 8.2.0 types
 * `WebAPICallResult.response_metadata.scopes` and fills it from the `X-OAuth-Scopes` header of
 * every response (`WebClient.js`), and a user token's `auth.test` answered
 * `identify,chat:write,pins:write` on a dev app on 2026-10-19.
 */
export async function ownerClient(
  userToken: string | null,
  identity: Identity,
  clients: Pick<Clients, "owner"> = CLIENTS,
): Promise<OwnerClient | null> {
  if (userToken === null) return null;
  const owner = clients.owner(userToken);
  const who = await owner.auth.test();
  if (
    authField(who, "user_id") !== identity.ownerUserId ||
    authField(who, "team_id") !== identity.teamId
  ) {
    throw new ConfigError("SLACK_USER_TOKEN must be the owner's own token, in the bot's workspace");
  }
  return { client: owner, scopes: who.response_metadata?.scopes ?? null };
}

/** The scope `!tag` and `!untag` need beyond what the Home tab's Delete does (`chat:write`). */
export const PINS_SCOPE = "pins:write";

/**
 * Whether the owner's token can pin, which `!tag` needs and a title does not. A token made before
 * the manifest asked for `pins:write` has the Delete's scope alone: tags are then not offered,
 * with one line saying why, and Delete and titles keep working. A token whose scopes Slack did
 * not report is not trusted with tags either.
 */
export function canTag(owner: OwnerClient | null): boolean {
  if (owner === null) return false;
  if (owner.scopes === null) {
    logger.warning(
      `Slack lists no scopes for SLACK_USER_TOKEN, so !tag and !untag are not offered: reinstall the app with the user scope ${PINS_SCOPE} (see ${setupGuide(SETUP_SLACK_APP)})`,
    );
    return false;
  }
  if (!owner.scopes.includes(PINS_SCOPE)) {
    logger.warning(
      `SLACK_USER_TOKEN lacks the scope ${PINS_SCOPE}, so !tag is not offered until the app is reinstalled with that scope (see ${setupGuide(SETUP_SLACK_APP)})`,
    );
    return false;
  }
  return true;
}

/**
 * What deletes a thread for the Home tab and for `!delete-thread`, when the owner has a client of
 * their own.
 */
export function deleter(
  owner: SlackClient | null,
  slack: SlackClient,
  identity: Identity,
  state: DeleterState,
  sessions: Pick<SessionsPort, "release" | "free">,
  names: () => Names,
): ThreadDeleter | null {
  if (owner === null) return null;
  return new ThreadDeleter(slack, owner, {
    botUserId: identity.botUserId,
    ownerUserId: identity.ownerUserId,
    state,
    names,
    release: (channelId, threadId) => sessions.release(channelId, threadId),
    free: (channelId, threadId) => sessions.free(channelId, threadId),
  });
}

/**
 * The lock key of an app-level token: its SHA-256 in hex, so that the key says which app without
 * the token ever leaving this module (Slack documents no call that maps an `xapp-` token to its
 * app).
 */
export function appTokenKey(appToken: string): string {
  return `app-token:${createHash("sha256").update(appToken).digest("hex")}`;
}

/**
 * Whether the messages the owner is told of mention him: `on` or `off` in any case, off when the
 * file does not set it. With Slack's "Thread replies" notifications on, every reply pushes, and
 * the channel's line at the end of the work would push once more. Any other value throws
 * `ConfigError`: a mistyped `on` must not start the daemon silent.
 */
function mentionSwitch(written: string | undefined): boolean {
  if (written === undefined) return false;
  const on = mentionsOn(written);
  if (on === null)
    throw new ConfigError(`${MENTION_VARIABLE} must be on or off; it is "${written}"`);
  return on;
}

/** The variable `context` must hold for `name`: the daemon does not start without the required. */
function variable(context: ChatContext, name: string): string {
  const value = context.variables[name];
  if (value === undefined) throw new ConfigError(`${name} is not set`);
  return value;
}

/** The shape of each token, checked before Slack is called: a swapped pair is told at once. */
function checkTokens(context: ChatContext): void {
  const wrong =
    wrongKind("SLACK_BOT_TOKEN", variable(context, "SLACK_BOT_TOKEN")) ??
    wrongKind("SLACK_APP_TOKEN", variable(context, "SLACK_APP_TOKEN"));
  if (wrong !== null) throw new ConfigError(wrong);
  const userToken = context.variables.SLACK_USER_TOKEN;
  const wrongUser = userToken === undefined ? null : wrongKind("SLACK_USER_TOKEN", userToken);
  if (wrongUser !== null) throw new ConfigError(wrongUser);
}

/** The heading of this module's section of `docs/limits.md`. */
export const LIMITS_HEADING = "Limits of Slack";

/** The registry's entry for Slack. */
export function slackChat(options: SlackOptions = {}): ChatEntry {
  return {
    required: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_OWNER_USER_ID"],
    optional: ["SLACK_USER_TOKEN", MENTION_VARIABLE],
    limitsHeading: LIMITS_HEADING,
    words: MODULE_WORDS,
    setup: (instance) => slackSetup(instance, options.probe),
    async build(context: ChatContext): Promise<ChatProvider> {
      checkTokens(context);
      try {
        return await assemble(options, context);
      } catch (error) {
        // The daemon logs a start that failed by the name of its error: Slack's code, as before.
        if (error instanceof ConfigError || error instanceof ChatError) throw error;
        throw new ChatError(describe(error), { cause: error });
      }
    },
  };
}

/** Everything of the Slack side that does not need the core. */
async function assemble(options: SlackOptions, context: ChatContext): Promise<ChatProvider> {
  const botToken = variable(context, "SLACK_BOT_TOKEN");
  const appToken = variable(context, "SLACK_APP_TOKEN");
  const mentionOwner = mentionSwitch(context.variables[MENTION_VARIABLE]);
  const clients = options.clients ?? CLIENTS;
  // The clients are built before the chat that stops them: its stop is passed on below.
  const stopping = new AbortController();
  const [slack, replySlack] = clients.bot(botToken, stopping.signal);
  const auth = await slack.auth.test();
  const identity: Identity = {
    ownerUserId: variable(context, "SLACK_OWNER_USER_ID"),
    teamId: authField(auth, "team_id"),
    botUserId: authField(auth, "user_id"),
  };
  const limiter = new UpdateLimiter({ clock: context.steady });
  // What the Slack side asks of the core is read here when it is asked: the core is built
  // after this provider is, and `context.core()` is not ready until then.
  const state = {
    thread: (channelId: string, threadId: string) =>
      context.core().state.thread(channelId, threadId),
    channels: () => context.core().state.channels(),
    threads: () => context.core().state.threads(),
    removeThread: (channelId: string, threadId: string) =>
      context.core().state.removeThread(channelId, threadId),
  };
  // The provider is made last, from these parts; they ask it for the names when they show a
  // line, which is after the core exists.
  const names = (): Names => chat.names();
  const owner = await ownerClient(context.variables.SLACK_USER_TOKEN ?? null, identity, clients);
  // One editor serves tags and titles, so their edits of a root queue behind one another.
  const roots = owner === null ? null : new RootEditor(slack, owner.client);
  const threadDeleter = deleter(
    owner?.client ?? null,
    slack,
    identity,
    state,
    {
      release: (channelId, threadId) => context.core().sessions.release(channelId, threadId),
      free: (channelId, threadId) => context.core().sessions.free(channelId, threadId),
    },
    names,
  );
  const home = new Home(slack, {
    ownerUserId: identity.ownerUserId,
    teamId: identity.teamId,
    state,
    names,
    sessionsOf: async (directory) => (await context.core().agent.listSessions?.(directory)) ?? [],
    ...(threadDeleter !== null && {
      delete: (channelId, threadId) => threadDeleter.delete(channelId, threadId),
      clean: (channelId) => threadDeleter.clean(channelId),
    }),
    update: () => context.core().updates?.line() ?? null,
    cleanup: () => context.core().cleanup ?? null,
    clock: context.clock,
  });
  const uploads = options.uploads ?? context.scratchDir;
  await prepareUploads(uploads);
  const chat = new SlackChat({
    slack,
    replies: replySlack,
    identity,
    limiter,
    clock: context.clock,
    steady: context.steady,
    agent: () => context.core().agent,
    ...(roots !== null && { roots, canTag: canTag(owner) }),
    line: new ChannelLine(slack, {
      botUserId: identity.botUserId,
      // Read when the line changes, after the core exists.
      threads: {
        channels: () => context.core().state.channels(),
        of: (channel) =>
          [...(context.core().state.channel(channel)?.threads ?? [])].map(([thread, t]) =>
            lineThread(thread, t),
          ),
      },
    }),
    mentionOwner,
    app: {
      core: () => context.core(),
      config: { botToken, allowedRoot: context.allowedRoot },
      guard: new ChannelGuard(slack, identity),
      home,
      ...(threadDeleter !== null && {
        deletion: {
          delete: (channelId: string, threadId: string) =>
            threadDeleter.delete(channelId, threadId),
          pinned: (channelId: string, threadId: string) =>
            threadDeleter.pinned(channelId, threadId),
        },
      }),
      uploads,
      receiver: (options.receiver ?? socketReceiver)(appToken),
      appKey: appTokenKey(appToken),
      ...(options.fetch !== undefined && { fetch: options.fetch }),
      ...(options.listings !== undefined && { listings: options.listings }),
      ...(options.now !== undefined && { now: options.now }),
    },
  });
  chat.stopped.addEventListener("abort", () => stopping.abort(), { once: true });
  return chat;
}
