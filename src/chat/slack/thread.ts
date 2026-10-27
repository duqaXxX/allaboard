/**
 * The Slack provider (`ChatProvider` of the chat seam) and one Slack thread as its session uses
 * it (`ThreadChat`), composed from what the provider already has: a `ReplySink` per reply, the
 * `StatusReaction` on the thread's root, the `ThreadStatus` line under its last message, and the
 * request messages of `requests.ts`.
 *
 * What the thread adds to those parts is their wiring: every pass of a reply that wrote, and every
 * notice, tells the status line (Slack clears a thread's status when the app replies); the
 * seam's four statuses are the four reactions; an answered question is rewritten on the budget
 * every reply draws from; and a failed post or rewrite crosses the seam as a `ChatError` named
 * by Slack's code.
 */

import type { Receiver } from "@slack/bolt";
import type { KnownBlock, WebClient } from "@slack/web-api";
import type { AgentBackend, Question } from "../../agent/seam.ts";
import { type Clock, monotonicClock, systemClock } from "../../clock.ts";
import {
  asksOwner,
  Cancelled,
  type CorePort,
  type Listings,
  type Names,
  named,
  texts,
} from "../../core/port.ts";
import { getLogger } from "../../log.ts";
import {
  type ChannelChat,
  type ChatCapabilities,
  ChatError,
  type ChatInbound,
  type ChatProvider,
  type CommandSuggestion,
  type LoopCard,
  type Markup,
  type MessageId,
  type OpenMessageChange,
  type OwnerRequest,
  type Presence,
  type Reply,
  type RootStatus,
  type RunningList,
  type SessionIndex,
  type SessionStatus,
  type StatusOptions,
  type ThreadChat,
  type ThreadRef,
} from "../seam.ts";
import type { AppConfig, Fetch } from "./app/answers.ts";
import { type BuiltApp, buildApp } from "./app/app.ts";
import type { ChannelGuard } from "./app/guards.ts";
import { threadKey } from "./app/order.ts";
import { SlackChannel } from "./channel.ts";
import type { ChannelLine } from "./channel-line.ts";
import { channelLookup, threadLookup } from "./channels.ts";
import type { ThreadDeletion } from "./delete.ts";
import { formatFooter, slackTime } from "./footer.ts";
import { holdBlocks } from "./hold.ts";
import type { Home } from "./home.ts";
import { crossing, deliver, deliverNotice } from "./notice.ts";
import { endReply } from "./repair.ts";
import { contextBlock, footerBlock, noticeText, split } from "./reply/blocks.ts";
import { deleteRequest, describe } from "./reply/errors.ts";
import { markdownEscape, mrkdwnEscape, quietMentions } from "./reply/escape.ts";
import type { Limiter } from "./reply/limiter.ts";
import { positionOf, ThreadPlaces } from "./reply/places.ts";
import { ReplySink } from "./reply/sinks.ts";
import { REACTIONS, Status, StatusReaction, ThreadStatus } from "./reply/status.ts";
import {
  answeredBlocks,
  approvalBlocks,
  questionBlocks,
  shellBlocks,
  terminalBlocks,
} from "./requests.ts";
import { type SetupDraw, setupBlocks } from "./setup.ts";
import type { RootEditor } from "./tag.ts";

export const logger = getLogger("allaboard.chat.slack.thread");

/** Who a reply's stream is addressed to, and whose messages are read back after a reset. */
export interface SlackIdentity {
  readonly teamId: string;
  readonly ownerUserId: string;
  readonly botUserId: string;
}

/** What `start` builds the Bolt app from: the Slack side's own parts, and the core. */
export interface SlackApp {
  /** The core; read when the connection opens, which is after the provider was built. */
  readonly core: () => CorePort;
  /** The bot token downloads a message's files with; the folder sessions may start under. */
  readonly config: AppConfig;
  readonly guard: ChannelGuard;
  /** The session index: the Home tab. */
  readonly home: Home;
  /**
   * Absent without the owner's user token: the provider then declares no `threadDelete` and has
   * no `deleteThread`.
   */
  readonly deletion?: ThreadDeletion;
  /** The folder a message's files that are no image are saved in (`ChatContext.scratchDir`). */
  readonly uploads: string;
  /** Where Slack's payloads come from: `socketReceiver(appToken)` in the daemon. */
  readonly receiver: Receiver;
  /**
   * The key of the app-level token the receiver connects with, `appTokenKey(appToken)`: a digest,
   * since the token itself stays in the Slack module. It is what `ChatProvider.identities` says
   * of the connection.
   */
  readonly appKey: string;
  /** How a file is downloaded; `attachments.download` with the bot token when absent. */
  readonly fetch?: Fetch;
  /** Wall-clock seconds as a Slack ts counts them; `Date.now` when absent. */
  readonly now?: () => number;
  /** `!open`'s listings; made over the core's `repository` when absent. */
  readonly listings?: Listings;
}

export interface SlackChatOptions {
  /** The client every call but a reply's goes through. */
  readonly slack: WebClient;
  /**
   * The client replies are written with: one that never sends a create or a stream call twice
   * after a reset (`repliesClient`). Required, with no fallback to `slack`: a wiring that
   * forgot it would send a create twice after a reset and nothing would say so.
   */
  readonly replies: WebClient;
  readonly identity: SlackIdentity;
  /** Shared by every reply in the process and by every `chat.update` made beside them. */
  readonly limiter: Limiter;
  /** Wall-clock seconds and every pause of a reply. */
  readonly clock?: Clock;
  /**
   * The clock the status line counts its refreshes on: a monotonic one, so that a step of the
   * system clock neither delays nor repeats a refresh.
   * A test's one clock serves for both.
   */
  readonly steady?: Clock;
  /**
   * The agent the texts name. Read when a text that names it is first needed, never in `build`:
   * the core, and with it the agent, exists only after the provider was built.
   */
  readonly agent: () => Pick<AgentBackend, "name" | "words">;
  /** `sinks.DEBOUNCE_SECONDS`, unless a test shortens it. */
  readonly debounceSeconds?: number;
  /** `sinks.FINAL_RETRY_SECONDS`, unless a test shortens it. */
  readonly finalRetrySeconds?: number;
  /**
   * What the connection is made of. Absent in a test of the threads alone: `start` then has
   * nothing to open, and there is no session index.
   */
  readonly app?: SlackApp;
  /**
   * Edits a thread's root with the owner's user token. Absent without that token: the provider
   * then declares neither `threadTags` nor `threadTitles`. One editor serves both, so the edits of
   * a root queue behind one another.
   */
  readonly roots?: RootEditor;
  /** Whether the token can pin, which tags need and titles do not (`module.canTag`). */
  readonly canTag?: boolean;
  /**
   * Moves the channel's line to the bottom when the session's work ends (a `notify` status), and
   * when the agent asks the owner for an approval or an answer (`channel-line`), so the channel
   * shows as unread. Absent in a test of the threads alone.
   */
  readonly line?: ChannelLine;
  /**
   * The channel's line mentions the owner, out of sight, when it tells him of an approval, a
   * question or the end of the work (`SLACK_MENTION_OWNER`). With Slack's "Thread replies"
   * notifications off, only those lines push (measured 2026-10-25, iOS).
   */
  readonly mentionOwner?: boolean;
}

/**
 * Whether `request` is the agent's, which waits on the owner wherever he is (`asksOwner`, by the
 * kind `state.json` keeps of it): the setup form, a `!!` command's confirmation and the
 * same-folder hold answer what he has just written in the thread, and he is there to answer them.
 */
function waitsOnOwner(request: OwnerRequest): boolean {
  if (request.type === "terminal") return false; // he has just written, as with a hold
  return asksOwner(request.type === "permission" ? "approval" : request.type);
}

/** The emoji of each root reaction (`REACTIONS`), as a character. */
const STATUS_MARKS: Readonly<Record<SessionStatus, string>> = {
  working: "⏳",
  waiting: "✋",
  done: "✅",
  error: "❌",
};

// The most of a run's words the loop card shows; a markdown block holds 12,000 characters in all.
const LOOP_TEXT_LIMIT = 3000;

/** What Slack draws of the chat seam whatever the configuration. */
const CAPABILITIES = {
  nativeStreaming: true,
  reactions: true,
  activityLine: true,
  fileUpload: true,
  commandSuggestions: true,
  loopCard: true,
} as const satisfies Omit<ChatCapabilities, "threadTags" | "threadTitles" | "threadDelete">;

/** The Slack provider: one `SlackThread` per thread, one `SlackChannel` per channel. */
export class SlackChat implements ChatProvider {
  readonly name = "Slack";
  readonly capabilities: ChatCapabilities;
  /**
   * The bot of the workspace, and the app-level token of the connection when there is one: the
   * two things a copied `.env` can leave the same, each of which makes Socket Mode spread events
   * across the connections of two daemons.
   */
  readonly identities: readonly string[];
  /**
   * Present when the provider holds the Home tab (`SlackApp.home`) or the channels' line
   * (`SlackChatOptions.line`): both show the sessions' status.
   */
  readonly index?: SessionIndex;
  /** Present when the owner's user token is configured (`SlackChatOptions.roots`, `canTag`). */
  readonly tagThread?: (ref: ThreadRef, tag: string | null) => Promise<void>;
  /** Present when the owner's user token is configured (`SlackChatOptions.roots`). */
  readonly titleThread?: (
    ref: ThreadRef,
    title: string,
    keep?: (text: string) => void | Promise<void>,
  ) => Promise<void>;
  /** Present when the owner's user token is configured (`SlackApp.deletion`). */
  readonly deleteThread?: (ref: ThreadRef) => Promise<void>;
  private readonly options: SlackChatOptions;
  private readonly stopping = new AbortController();
  private built: BuiltApp | null = null;
  /**
   * Where each thread's messages sit, by thread, while a thread object that opened a reply in it
   * is open (`users`), and after that while a reply of it is registered.
   */
  private readonly places = new Map<string, { readonly places: ThreadPlaces; users: number }>();
  private named: Names | null = null;

  constructor(options: SlackChatOptions) {
    this.options = options;
    this.capabilities = {
      ...CAPABILITIES,
      threadTags: options.roots !== undefined && options.canTag === true,
      threadTitles: options.roots !== undefined,
      threadDelete: options.app?.deletion !== undefined,
    };
    this.identities = [
      `${options.identity.teamId}:${options.identity.botUserId}`,
      ...(options.app !== undefined ? [options.app.appKey] : []),
    ];
    const home = options.app?.home;
    const line = options.line;
    if (home !== undefined || line !== undefined) {
      this.index = {
        refresh: (changed) => {
          // Read once: both take the same refs.
          const refs = changed === undefined ? undefined : [...changed];
          home?.request(refs);
          void line?.refresh(refs);
        },
      };
    }
    const roots = options.roots;
    // The root may have changed even when a later step failed: the Home reads it again.
    const rereading = async <T>(ref: ThreadRef, edit: () => Promise<T>): Promise<T> => {
      try {
        return await edit();
      } finally {
        this.index?.refresh([ref]);
      }
    };
    if (roots !== undefined && options.canTag === true) {
      this.tagThread = (ref, tag) => rereading(ref, () => roots.tag(ref.channel, ref.thread, tag));
    }
    if (roots !== undefined) {
      this.titleThread = async (ref, title, keep) => {
        // A title resolving after the stop began touches neither Slack nor the state.
        if (this.stopped.aborted) return;
        const text = await rereading(ref, () => roots.title(ref.channel, ref.thread, title, keep));
        // The channel's line may have read the root before this title reached it.
        if (!this.stopped.aborted) void options.line?.retitle(ref.channel, ref.thread, text);
      };
    }
    if (options.app?.deletion !== undefined) {
      this.deleteThread = async (ref) => {
        if (this.built === null) throw new Error("the Slack app is not started");
        await this.built.askDelete(ref.channel, ref.thread);
      };
    }
  }

  /** A `!word` that is no command: the field and the commands it could mean, for the owner alone. */
  async suggestCommands(ref: ThreadRef, suggestion: CommandSuggestion): Promise<void> {
    if (this.built === null) throw new Error("the Slack app is not started");
    await this.built.suggest(ref.channel, ref.thread, suggestion);
  }

  /**
   * The `chat.update` budget every reply in the process draws from, so an edit made outside a
   * reply (a handler's own) can share it.
   */
  get limiter(): Limiter {
    return this.options.limiter;
  }

  /**
   * Aborts when the daemon stops. A listener still in flight then does nothing at its next
   * step: the sessions are closed and the lock is released.
   */
  get stopped(): AbortSignal {
    return this.stopping.signal;
  }

  /** Tells every listener, and every call of the chat, that the daemon is stopping. */
  halt(): void {
    this.stopping.abort();
  }

  /** The names the texts take, the agent's and this chat's, made when first asked for. */
  names(): Names {
    this.named ??= texts.namesOf(this.options.agent(), this);
    return this.named;
  }

  /** What the setup posted for `requestId` said to draw, or undefined when it is no longer kept. */
  drawnSetup(requestId: string): SetupDraw | undefined {
    return drawnSetups.get(this.options)?.get(requestId);
  }

  thread(ref: ThreadRef): SlackThread {
    return new SlackThread(
      ref.channel,
      ref.thread,
      this.options,
      () => this.names(),
      this.stopped,
      this.leaseOf(ref.channel, ref.thread),
    );
  }

  /**
   * The owner wrote a message at `ts` in a thread. Called by the listener for every owner
   * message, before anything else of it is decided: a message the core later refuses still sits
   * below the replies above it.
   */
  ownerPosted(channel: string, thread: string, ts: string): void {
    this.places.get(threadKey(channel, thread))?.places.ownerPosted(ts);
  }

  /**
   * The thread's places: one object for every `SlackThread` of it, so that the replies of the
   * thread's successive sessions see each other. A thread object takes it at its first reply and
   * gives it back at its close (`ThreadLease`). It lives while one is open: a reply let go of
   * by an owner message must still be found by the next one. After the last give-back it lives
   * while a reply is registered with it.
   */
  private leaseOf(channel: string, thread: string): ThreadLease {
    const key = threadKey(channel, thread);
    return {
      peek: () => this.places.get(key)?.places,
      take: () => {
        const known = this.places.get(key);
        if (known !== undefined) {
          known.users += 1;
          return known.places;
        }
        const made = new ThreadPlaces(() => {
          const entry = this.places.get(key);
          if (entry?.places === made && entry.users === 0) this.places.delete(key);
        });
        this.places.set(key, { places: made, users: 1 });
        return made;
      },
      give: () => {
        const entry = this.places.get(key);
        if (entry === undefined) return;
        entry.users -= 1;
        if (entry.users === 0 && !entry.places.held) this.places.delete(key);
      },
    };
  }

  /**
   * The thread as a handler answers in it. A post of the app's clears the status line of the
   * session that lives there, not of this object, which only posts: `written` sets that line
   * again.
   */
  answering(ref: ThreadRef, written: () => void): SlackThread {
    return new SlackThread(
      ref.channel,
      ref.thread,
      this.options,
      () => this.names(),
      this.stopped,
      this.leaseOf(ref.channel, ref.thread),
      written,
    );
  }

  channel(channel: string): ChannelChat {
    const { slack, identity, limiter, clock } = this.options;
    return new SlackChannel(channel, {
      slack,
      ownerUserId: identity.ownerUserId,
      limiter,
      clock: clock ?? systemClock,
      stopped: this.stopped,
      names: () => this.names(),
    });
  }

  escape(text: string, markup: Markup): string {
    // `words` is the owner's own text, drawn in a markdown block as written: measured 2026-10-20,
    // the block turns `<!here>` into a broadcast and `<@U…>` into a mention, as they were in the
    // owner's message, and keeps `&&` and code spans as typed, where an entity or a backslash
    // escape shows literally inside code. Its only reader is `!status`, which only the owner sees
    // and which never pushes (`ownerOnly`), so a mention in it reaches no one.
    if (markup === "words") return text;
    // A markdown block stores a mention sequence as one typed would: a zero-width space after
    // its `<` stops it and shows nothing (`reply/escape.quietMentions`).
    if (markup === "written") return quietMentions(text, true);
    return markup === "notice" ? mrkdwnEscape(text) : markdownEscape(text);
  }

  // Slack's channel syntax in a notice. Whether a markdown block renders it was not confirmed
  // (the block's reference names neither mentions nor angle brackets), so `reference` gets the same.
  channelName(channel: string, _markup: Markup): string {
    return `<#${channel}>`;
  }

  // The character of each reaction a root carries (`REACTIONS`): written as such, as the
  // bypass mark of the same lines is, rather than as a `:name:` a reference may not render.
  statusMark(status: SessionStatus): string {
    return STATUS_MARKS[status];
  }

  openedAt(ref: ThreadRef): number | null {
    // A Slack ts is the post time in epoch seconds.
    const seconds = ref.thread.trim() === "" ? Number.NaN : Number(ref.thread);
    return Number.isNaN(seconds) ? null : seconds;
  }

  channelState(channel: string): Promise<Presence> {
    return channelLookup(this.options.slack)(channel);
  }

  threadState(ref: ThreadRef): Promise<Presence> {
    return threadLookup(this.options.slack)(ref);
  }

  async openFile(ref: ThreadRef, folder: string, target: string): Promise<void> {
    if (this.built === null) throw new Error("the Slack app is not started");
    await this.built.openFile(ref.channel, ref.thread, folder, target);
  }

  async start(inbound: ChatInbound): Promise<void> {
    const { app, identity, steady } = this.options;
    if (app === undefined) throw new Error("this Slack provider was built with no app to open");
    const core = app.core();
    this.built = buildApp({
      chat: this,
      slack: this.options.slack,
      config: app.config,
      identity,
      sessions: core.sessions,
      approvals: core.approvals,
      holds: core.holds,
      names: this.names(),
      inbound,
      guard: app.guard,
      state: core.state,
      uploads: app.uploads,
      home: app.home,
      ...(app.deletion !== undefined && { deletion: app.deletion }),
      receiver: app.receiver,
      ...(steady !== undefined && { clock: steady }),
      ...(app.fetch !== undefined && { fetch: app.fetch }),
      ...(app.now !== undefined && { now: app.now }),
      ...(app.listings !== undefined && { listings: app.listings }),
    });
    await this.built.app.start();
    logger.info(`connected to Slack workspace ${identity.teamId}`);
  }

  async stop(): Promise<void> {
    const built = this.built;
    try {
      await built?.app.stop();
    } finally {
      // Even when the connection would not close: what listens must stop all the same.
      this.halt();
      // The timers of clips still waiting for a transcript would keep the process alive.
      built?.close();
    }
  }

  async close(): Promise<void> {
    await this.options.app?.home.close();
  }
}

// The requests a provider withdrew lately, by channel and message, per provider (the options it
// was built over). A rewrite that waited for the budget while its message was withdrawn writes
// nothing.
const WITHDRAWN_KEPT = 64;
const withdrawn = new WeakMap<SlackChatOptions, Set<string>>();

// What the setups posted lately said to draw, by request id, per provider. A click that only
// redraws a setup (a model picked) draws the message again from this, since the hold it finds
// keeps the model list alone.
const SETUPS_KEPT = 64;
const drawnSetups = new WeakMap<SlackChatOptions, Map<string, SetupDraw>>();

/** How a thread object holds its thread's places: taken at its first reply, given back at its close. */
interface ThreadLease {
  take(): ThreadPlaces;
  give(): void;
  /** The thread's places when some thread object holds them, without taking them. */
  peek(): ThreadPlaces | undefined;
}

export class SlackThread implements ThreadChat {
  private readonly channel: string;
  private readonly threadTs: string;
  private readonly options: SlackChatOptions;
  private readonly names: () => Names;
  private readonly slack: WebClient;
  private readonly clock: Clock;
  // One reaction on the session's root message, which `threadTs` always is (a top-level owner
  // message, or the root of a `!resume` thread, the owner's own message).
  private readonly reaction: StatusReaction;
  /** Slack's status line at the bottom of the thread. */
  private readonly line: ThreadStatus;
  private readonly stopped: AbortSignal;
  private readonly lease: ThreadLease;
  /** The places of this thread, once a reply was opened in it and until the close. */
  private places: ThreadPlaces | null = null;
  private readonly onWritten: () => void;
  /** The replies this object opened, with the places each is registered in. */
  private readonly opened: Array<[ThreadPlaces, ReplySink]> = [];
  /** The loop card's message, once posted, until the loop ends. */
  private loopTs: string | null = null;
  /** The loop card's writes, one after the other. */
  private loopWrites: Promise<void> = Promise.resolve();

  /**
   * `written` stands for this object's own status line where something else holds it: the
   * handlers answer through a thread of their own, and the session's line is the one a post
   * clears.
   */
  constructor(
    channelId: string,
    threadTs: string,
    options: SlackChatOptions,
    names: () => Names,
    stopped: AbortSignal,
    lease: ThreadLease,
    written?: () => void,
  ) {
    this.channel = channelId;
    this.threadTs = threadTs;
    this.options = options;
    this.names = names;
    this.stopped = stopped;
    this.lease = lease;
    this.slack = options.slack;
    this.clock = options.clock ?? systemClock;
    this.reaction = new StatusReaction(this.slack, { channel: channelId, rootTs: threadTs });
    this.line = new ThreadStatus(this.slack, {
      channel: channelId,
      threadTs,
      clock: options.steady ?? options.clock ?? monotonicClock,
    });
    this.onWritten = written ?? (() => this.line.wrote());
  }

  openReply(onOpenMessage: OpenMessageChange): Reply {
    const { identity } = this.options;
    this.places ??= this.lease.take();
    const places = this.places;
    const reply = new ReplySink(this.options.replies, {
      channel: this.channel,
      threadTs: this.threadTs,
      teamId: identity.teamId,
      userId: identity.ownerUserId,
      botUserId: identity.botUserId,
      limiter: this.options.limiter,
      clock: this.clock,
      ...(this.options.steady !== undefined && { steady: this.options.steady }),
      onOpenReply: onOpenMessage,
      onWrite: () => this.line.wrote(),
      places,
      ...(this.options.debounceSeconds !== undefined && {
        debounceSeconds: this.options.debounceSeconds,
      }),
      ...(this.options.finalRetrySeconds !== undefined && {
        finalRetrySeconds: this.options.finalRetrySeconds,
      }),
    });
    // A reply the places let go of needs no letting go at close, and must not stay reachable.
    this.opened.splice(
      0,
      this.opened.length,
      ...this.opened.filter(([held, old]) => held.holds(old)),
    );
    this.opened.push([places, reply]);
    return reply;
  }

  showRunning(list: RunningList | null): void {
    // No reply was opened yet: there is nothing for the list to sit under.
    this.places?.showRunning(list);
  }

  showStatus(status: RootStatus, options: StatusOptions = {}): Promise<boolean> {
    // Between these posts, the line follows the root's status in `state.json` (`ChannelLine.refresh`).
    if (options.notify && (status === "done" || status === "error")) {
      const kind = status === "done" ? "done" : "failed";
      void this.options.line?.show(this.channel, this.threadTs, kind);
      const mention = this.mention();
      if (mention !== undefined) void this.tellEnd(kind, mention);
    }
    return this.reaction.show(REACTIONS[status], options.signal);
  }

  /**
   * Tells the owner `mention`, from the thread, that the session's work ended: a push from a
   * message of the thread opens the thread, where one from the channel opens the channel
   * (measured 2026-10-25 and 2026-10-26, iOS). On the newest reply's last message, out of sight
   * (`ThreadPlaces.tell`); with no reply to carry it (a crash found at a start, a turn that showed
   * nothing), a line of its own, the root's mark and word, whose words are rich text: an
   * invisible `text` mention pushed beside a rich text block and never beside a section (measured
   * 2026-10-26). Never rejects: a failure is logged by its code.
   */
  private async tellEnd(kind: "done" | "failed", mention: string): Promise<void> {
    try {
      if (await (this.places ?? this.lease.peek())?.tell(mention)) return;
      const [emoji, word] = kind === "done" ? [Status.DONE, "Done"] : [Status.ERROR, "Failed"];
      const posted = await this.slack.chat.postMessage({
        channel: this.channel,
        thread_ts: this.threadTs,
        text: `${word} <@${mention}>`,
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  { type: "emoji", name: emoji },
                  { type: "text", text: ` ${word}` },
                ],
              },
            ],
          },
        ],
      });
      this.postedOwn(posted.ts);
    } catch (error) {
      logger.warning(`could not tell the owner of the end in ${this.channel}: ${describe(error)}`);
    }
  }

  /** The owner's id, for the messages he is told of, when he asked for mentions. */
  private mention(): string | undefined {
    return this.options.mentionOwner ? this.options.identity.ownerUserId : undefined;
  }

  clearStatus(): Promise<void> {
    return this.reaction.clear();
  }

  settleStatus(): Promise<void> {
    return this.reaction.settle();
  }

  showActivity(text: string, afterName: string): void {
    this.line.show(text, afterName);
  }

  get activityRefused(): boolean {
    return ThreadStatus.refused();
  }

  written(): void {
    this.onWritten();
  }

  /**
   * A message of the app's own posted in the thread outside a reply: the places learn where it
   * sits, so that no reply posts its closing message below it later. Null for an ephemeral one.
   */
  private postedOwn(ts: unknown): void {
    if (typeof ts === "string" && ts !== "") (this.places ?? this.lease.peek())?.posted(ts);
  }

  async notice(text: string): Promise<void> {
    // mrkdwn reads `&`, `<` and `>` as markup, and a notice can quote the owner's own message.
    const shown = mrkdwnEscape(text);
    try {
      const posted = await this.slack.chat.postMessage({
        channel: this.channel,
        thread_ts: this.threadTs,
        text: shown,
        blocks: [contextBlock(noticeText(shown))],
        unfurl_links: false,
        unfurl_media: false,
      });
      this.postedOwn(posted.ts);
      this.line.wrote(); // a post of the app's clears the thread's status
    } catch (error) {
      logger.error(`could not post in ${this.channel}/${this.threadTs}: ${describe(error)}`);
    }
  }

  showLoop(card: LoopCard): Promise<void> {
    this.loopWrites = this.loopWrites.then(() => this.writeLoop(card));
    return this.loopWrites;
  }

  get loopCardLast(): boolean {
    const at = this.loopTs === null ? null : positionOf(this.loopTs);
    if (at === null) return false;
    const newest = (this.places ?? this.lease.peek())?.newestAt ?? null;
    return newest === null || newest <= at;
  }

  /** Posts the card, or rewrites it; a card Slack lost is posted again by the next run. */
  private async writeLoop(card: LoopCard): Promise<void> {
    // The places track what the owner writes below the card (`loopCardLast`), as for a reply.
    this.places ??= this.lease.take();
    // The time is Slack's control sequence, which must not be escaped.
    const label = `_${mrkdwnEscape(card.label)} · ${slackTime(card.at)}_`;
    const blocks: KnownBlock[] = [contextBlock(noticeText(label))];
    // A markdown block's text may not be empty, and holds 12,000 characters in all.
    const words = quietMentions(card.text.trim(), true);
    if (words !== "") {
      // The end of a long run is what it concluded: that is the part kept.
      const shown =
        words.length > LOOP_TEXT_LIMIT
          ? `…${words.slice(words.length - LOOP_TEXT_LIMIT + 1)}`
          : words;
      blocks.push({ type: "markdown", text: shown } as unknown as KnownBlock);
    }
    // The footer an ordinary reply shows, of the latest run: it is rewritten with the card.
    if (card.footer !== null) {
      const line = formatFooter(card.footer, this.clock.time() * 1000);
      if (line !== "") blocks.push({ type: "divider" }, footerBlock(noticeText(line)));
    }
    try {
      if (this.loopTs === null) {
        const posted = await this.slack.chat.postMessage({
          channel: this.channel,
          thread_ts: this.threadTs,
          text: label,
          blocks,
          unfurl_links: false,
          unfurl_media: false,
        });
        if (typeof posted.ts === "string" && posted.ts !== "") this.loopTs = posted.ts;
        this.postedOwn(posted.ts);
        this.line.wrote();
      } else {
        await this.options.limiter.acquire();
        await this.slack.chat.update({
          channel: this.channel,
          ts: this.loopTs,
          text: label,
          blocks,
        });
      }
    } catch (error) {
      logger.error(
        `could not write the loop card in ${this.channel}/${this.threadTs}: ${describe(error)}`,
      );
      // A card that cannot be edited (deleted by hand) is not tried again: the next run posts one.
      this.loopTs = null;
    }
  }

  endLoop(line: string): Promise<void> {
    // After the card's last write, so the end is the newest message and the card is not reposted.
    this.loopWrites = this.loopWrites.then(async () => {
      this.loopTs = null;
      const shown = `_${mrkdwnEscape(line)}_`;
      try {
        const posted = await this.slack.chat.postMessage({
          channel: this.channel,
          thread_ts: this.threadTs,
          text: shown,
          blocks: [contextBlock(noticeText(shown))],
          unfurl_links: false,
          unfurl_media: false,
        });
        this.postedOwn(posted.ts);
        this.line.wrote();
      } catch (error) {
        logger.error(`could not post in ${this.channel}/${this.threadTs}: ${describe(error)}`);
      }
    });
    return this.loopWrites;
  }

  async ask(requestId: string, request: OwnerRequest, title: string): Promise<MessageId> {
    // Only a wait on the agent's approval or question tells the owner; the rest answers what he
    // has just written, and he is there.
    const mention = waitsOnOwner(request) ? this.mention() : undefined;
    let blocks: readonly object[];
    switch (request.type) {
      case "question":
        blocks = questionBlocks(requestId, request.questions, this.names());
        break;
      case "permission":
        blocks = approvalBlocks(requestId, request, this.names());
        break;
      case "hold":
        blocks = holdBlocks(requestId, request.link);
        break;
      case "setup":
        this.noteSetup(requestId, request);
        blocks = setupBlocks(requestId, request, request.selection);
        break;
      case "shell":
        blocks = shellBlocks(requestId, request);
        break;
      case "terminal":
        blocks = terminalBlocks(requestId, request);
        break;
    }
    // Slack for iOS hides the text of a stream still open once a message lands below it (#25):
    // every reply of the thread ends its live write before any request is posted.
    await (this.places ?? this.lease.peek())?.beforeRequest();
    let ts: unknown;
    try {
      const posted = await this.slack.chat.postMessage({
        channel: this.channel,
        thread_ts: this.threadTs,
        // The owner's mention, out of sight, pushes his phone and opens the thread on a tap, beside
        // the request's rich text heading (measured 2026-10-26, iOS, "Thread replies" off).
        text: mention !== undefined ? `${title} <@${mention}>` : title,
        // Built to Block Kit's reference by the modules that make them: opaque to the library's types.
        blocks: blocks as unknown as KnownBlock[],
        unfurl_links: false,
        unfurl_media: false,
      });
      ts = posted.ts;
    } catch (error) {
      // A wait that was cancelled is no refusal of the chat: it crosses as it is.
      if (error instanceof Cancelled) throw error;
      throw new ChatError(describe(error), { cause: error });
    }
    // The message is the only handle on its buttons: one Slack did not name cannot be removed.
    if (typeof ts !== "string" || ts === "") throw new ChatError("no_ts");
    this.postedOwn(ts);
    this.nameWaiting(request, ts);
    return ts;
  }

  /**
   * Moves the channel's line to name this thread as waiting once each of the agent's approvals
   * and questions is posted, linking the request `ts`: the line makes the channel unread, the
   * request's own mention tells the owner. The others name nothing (`waitsOnOwner`).
   */
  private nameWaiting(request: OwnerRequest, ts: string): void {
    if (!waitsOnOwner(request)) return;
    void this.options.line?.show(this.channel, this.threadTs, "waiting", ts);
  }

  async withdraw(request: MessageId): Promise<boolean> {
    // (sync) Noted before the first await: a rewrite waiting for the budget sees it.
    this.noteWithdrawn(request);
    const deleted = await deleteRequest(this.slack, { channel: this.channel, ts: request });
    // A line that links the request would open a message Slack no longer has.
    if (deleted) void this.options.line?.withdrawn(this.channel, this.threadTs, request);
    return deleted;
  }

  async keepAnswers(
    request: MessageId,
    questions: readonly Question[],
    answers: Readonly<Record<string, string | readonly string[]>>,
  ): Promise<void> {
    try {
      // One more chat.update against the app's budget, which every reply draws from.
      await this.options.limiter.acquire();
      await this.slack.chat.update({
        channel: this.channel,
        ts: request,
        text: named(texts.ANSWERED, this.names()),
        blocks: answeredBlocks(questions, answers, this.names()) as unknown as KnownBlock[],
      });
    } catch (error) {
      throw new ChatError(describe(error), { cause: error });
    }
  }

  rewrite(message: MessageId, text: string): Promise<void> {
    return crossing(async () => {
      await this.options.limiter.acquire();
      // The wait can outlast the message (withdrawn by a `!stop`) and the daemon: nothing is
      // left to edit then, and the edit would only be refused.
      if (this.stopped.aborted || this.wasWithdrawn(message)) return;
      await this.slack.chat.update({
        channel: this.channel,
        ts: message,
        text,
        blocks: [contextBlock(noticeText(text))],
      });
    });
  }

  private noteSetup(requestId: string, request: SetupDraw): void {
    const kept = drawnSetups.get(this.options) ?? new Map<string, SetupDraw>();
    drawnSetups.set(this.options, kept);
    const { models, efforts, bypassOffered } = request;
    kept.set(requestId, { models, efforts, bypassOffered });
    // Only a setup that is waiting right now can be redrawn: the oldest go.
    for (const old of kept.keys()) {
      if (kept.size <= SETUPS_KEPT) break;
      kept.delete(old);
    }
  }

  private noteWithdrawn(message: MessageId): void {
    const kept = withdrawn.get(this.options) ?? new Set<string>();
    withdrawn.set(this.options, kept);
    kept.add(`${this.channel}/${message}`);
    // Only a rewrite that is waiting right now cares: the oldest go.
    for (const old of kept) {
      if (kept.size <= WITHDRAWN_KEPT) break;
      kept.delete(old);
    }
  }

  private wasWithdrawn(message: MessageId): boolean {
    return withdrawn.get(this.options)?.has(`${this.channel}/${message}`) ?? false;
  }

  async tell(text: string, options: { readonly stays?: boolean } = {}): Promise<void> {
    if (this.stopped.aborted) return;
    try {
      this.postedOwn(
        await deliverNotice(this.slack, this.options.identity.ownerUserId, this.place, text, {
          ephemeral: !options.stays,
        }),
      );
      // Slack clears a thread's status line when the app replies: the session's is set
      // again, so `Working…` does not go for a minute after the answer to a word.
      this.written();
    } catch (error) {
      logger.warning(`could not reach the owner in ${this.channel}: ${describe(error)}`);
    }
  }

  async say(markdown: string, options: { readonly ownerOnly?: boolean } = {}): Promise<void> {
    for (const chunk of split(markdown)) {
      if (this.stopped.aborted) return;
      this.postedOwn(
        await crossing(() =>
          deliver(
            this.slack,
            this.options.identity.ownerUserId,
            this.place,
            chunk,
            [{ type: "markdown", text: chunk }],
            { ephemeral: options.ownerOnly ?? false },
          ),
        ),
      );
      this.written();
    }
  }

  async acknowledge(message: MessageId): Promise<void> {
    if (this.stopped.aborted) return;
    try {
      await this.slack.reactions.add({
        channel: this.channel,
        name: "white_check_mark",
        timestamp: message,
      });
    } catch (error) {
      logger.warning(`could not react to a word in ${this.channel}: ${describe(error)}`);
    }
  }

  async link(label: string, markup: Markup): Promise<string | null> {
    let permalink: unknown;
    try {
      ({ permalink } = await this.slack.chat.getPermalink({
        channel: this.channel,
        message_ts: this.threadTs,
      }));
      if (typeof permalink !== "string") throw new TypeError("no permalink");
    } catch (error) {
      logger.warning(
        `could not get a permalink for ${this.channel}/${this.threadTs}: ${describe(error)}`,
      );
      return null;
    }
    // A notice is mrkdwn, which takes `<url|label>`; a reference is Markdown, `[label](url)`.
    return markup === "notice" ? `<${permalink}|${label}>` : `[${label}](${permalink})`;
  }

  endReply(reply: MessageId, note: string): Promise<boolean> {
    return endReply(this.slack, this.options.limiter, this.place, reply, note);
  }

  async close(): Promise<void> {
    // The list that was just taken off a reply the session no longer tracks only debounced:
    // nothing else would write it before the process ends.
    await this.places?.settleListed();
    // The replies this object opened are let go of, their end landed or not: the session that
    // held them is over, and nothing else would drop them from the thread's places.
    for (const [places, reply] of this.opened) places.closed(reply);
    this.opened.length = 0;
    if (this.places !== null) {
      this.places = null;
      this.lease.give();
    }
    await this.line.close();
  }

  private get place(): { readonly channel: string; readonly threadTs: string } {
    return { channel: this.channel, threadTs: this.threadTs };
  }
}
