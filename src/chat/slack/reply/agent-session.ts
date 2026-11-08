/**
 * The Slack agent session of each thread (Agents & tools), derived from its root status and
 * activity line. `agents.sessions.setStatus` read from docs.slack.dev/reference/methods/
 * agents.sessions.setStatus, 2026-11-04; the bridge (a non-empty `assistant.threads.setStatus`
 * sets `processing`, an empty one `active`) and the one-hour timeout of a session left in
 * `processing` from docs.slack.dev/ai/migrating-to-agent-messaging, same day.
 *
 * One entry per thread lives at the provider: the core builds a new `SlackThread` for every call
 * and draws a session's end status after its `close`. Every change is sent explicitly, one call
 * in flight per thread; a bridged clear is a second writer, so it sends the wanted status again.
 * `closed` is never sent: the thread always responds.
 */
import { WebAPIPlatformError, type WebClient } from "@slack/web-api";
import type { Clock } from "../../../clock.ts";
import { getLogger, type Logger } from "../../../log.ts";
import type { RootStatus, ThreadRef } from "../../seam.ts";
import { describe, gone } from "./errors.ts";

export const logger = getLogger("allaboard.chat.slack.reply.agent-session");

/** The statuses this module sends; `closed` is never one. */
export type SessionState = "active" | "processing" | "suspended";

// A session left in `processing` times out after one hour: set again at half of it.
export const SESSION_REFRESH_SECONDS = 30 * 60;

// A failed call is tried again after these seconds, the last one repeating until a call succeeds.
export const SESSION_RETRY_SECONDS = [5, 15, 45, 300];

// Answers that name the token or the app, never one thread: no later call can succeed.
export const SESSION_REFUSED = ["missing_scope", "not_allowed_token_type", "feature_disabled"];

/** The session status a root status and an activity line ask for. */
export function wantedStatus(root: RootStatus | null, activity: boolean): SessionState {
  if (root === "waiting") return "suspended";
  if (root === "working" || root === "restarting" || activity) return "processing";
  return "active";
}

interface Entry {
  readonly ref: ThreadRef;
  root: RootStatus | null;
  activity: boolean;
  sent: SessionState | null; // null: nothing yet, or to be sent again
  // Bumped when a call is demanded though `sent` is right (bridged clear, Stop, refresh): a call
  // already out when it moved does not count as sent.
  resend: number;
  draining: Promise<void> | null;
  refresh: AbortController | null;
  // The retry of a failed call: a timer of its own, so the refresh above is never touched by it.
  retry: AbortController | null;
  failures: number; // calls of `failedStatus` failed in a row
  failedStatus: SessionState | null;
  failedCode: string | null; // the code last logged for this entry, until a call succeeds
}

// Answers about the service, not the call: they say nothing of whether the initiator is accepted.
const TRANSIENT = [
  "ratelimited",
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout",
];

export interface AgentSessionsOptions {
  readonly clock: Clock;
  /** The user a new session is attributed to (`initiator_user_id`): the owner. Absent: none. */
  readonly initiator?: string;
  readonly refresh?: number;
  readonly logger?: Logger;
}

export class AgentSessions {
  readonly #slack: WebClient;
  readonly #clock: Clock;
  readonly #refresh: number;
  readonly #log: Logger;
  readonly #initiator: string | undefined;
  // Channels whose `initiator_user_id` Slack refused while the call passed without it.
  readonly #bare = new Set<string>();
  readonly #entries = new Map<string, Entry>();
  // Every drain in flight, entries dropped meanwhile included, for `close`.
  readonly #draining = new Set<Promise<void>>();
  #refused = false;
  // One `agents.sessions.setStatus` succeeded since start: agent sessions work on this app.
  #proven = false;
  #closed = false;

  constructor(slack: WebClient, options: AgentSessionsOptions) {
    this.#slack = slack;
    this.#clock = options.clock;
    this.#refresh = options.refresh ?? SESSION_REFRESH_SECONDS;
    this.#log = options.logger ?? logger;
    this.#initiator = options.initiator;
  }

  /** The root status of the thread changed (`null`: no status). */
  root(ref: ThreadRef, status: RootStatus | null): void {
    const entry = status === null ? this.#entries.get(key(ref)) : this.#entry(ref);
    if (entry === undefined) return;
    entry.root = status;
    this.#kick(entry);
  }

  /** The activity line of the thread shows (`shown`) or is cleared. */
  activity(ref: ThreadRef, shown: boolean): void {
    const entry = shown ? this.#entry(ref) : this.#entries.get(key(ref));
    if (entry === undefined) return;
    entry.activity = shown;
    this.#kick(entry);
  }

  /**
   * A bridged `assistant.threads.setStatus` returned. An empty one sets `active`: a wanted
   * `processing` or `suspended` is sent again. A non-empty one resends nothing (live check L2).
   */
  bridged(ref: ThreadRef, cleared: boolean): void {
    const entry = this.#entries.get(key(ref));
    if (entry === undefined || !cleared) return;
    if (wantedStatus(entry.root, entry.activity) === "active") return;
    this.#again(entry);
  }

  /**
   * The owner clicked Stop, which changes no status (the event page). Work stopped: the wanted
   * status is sent again. Nothing stopped (a crash, or an idle close that left the root
   * `working`): `active` is sent and becomes the wanted one. Resolves when the queue is empty.
   */
  async stopped(ref: ThreadRef, stoppedSomething: boolean): Promise<void> {
    const known = this.#entries.get(key(ref));
    let entry: Entry;
    if (stoppedSomething && known !== undefined) {
      entry = known;
    } else {
      entry = known ?? this.#entry(ref);
      entry.root = null;
      entry.activity = false;
    }
    this.#again(entry);
    await entry.draining;
  }

  /**
   * The status a `chat.stopStream` should carry (it sets `active` when it carries none): the
   * thread's wanted one. Undefined until one status call succeeded on this app, and for good
   * once one was refused, so a stop never carries a field an app without agent sessions may
   * reject. Read-only.
   */
  wanted(ref: ThreadRef): SessionState | undefined {
    if (this.#refused || !this.#proven) return undefined;
    return this.#wantedOf(ref);
  }

  /**
   * A stream call that may have written the session returned: a stop carried `carried`
   * (`undefined`: no field, so Slack's `active`), a start set `processing`, `null`: unknown. A
   * stream call is a second writer outside the queue: when what it left differs from the wanted
   * status, or is unknown, the wanted status is sent again. A match sends nothing and never
   * clears a resend already demanded.
   */
  afterWrite(ref: ThreadRef, carried: SessionState | undefined | null): void {
    if (this.#refused) return;
    if (carried !== null && (carried ?? "active") === this.#wantedOf(ref)) return;
    this.#again(this.#entry(ref));
  }

  #wantedOf(ref: ThreadRef): SessionState {
    const entry = this.#entries.get(key(ref));
    return entry === undefined ? "active" : wantedStatus(entry.root, entry.activity);
  }

  /** Cancels the timers, then waits for the calls in flight and queued. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const entry of this.#entries.values()) {
      this.#disarm(entry);
      this.#disarmRetry(entry);
    }
    while (this.#draining.size > 0) await Promise.all([...this.#draining]);
  }

  #entry(ref: ThreadRef): Entry {
    const known = this.#entries.get(key(ref));
    if (known !== undefined) return known;
    const made: Entry = {
      ref,
      root: null,
      activity: false,
      sent: null,
      resend: 0,
      draining: null,
      refresh: null,
      retry: null,
      failures: 0,
      failedStatus: null,
      failedCode: null,
    };
    this.#entries.set(key(ref), made);
    return made;
  }

  #again(entry: Entry): void {
    entry.sent = null;
    entry.resend += 1;
    this.#kick(entry);
  }

  #kick(entry: Entry): void {
    if (entry.draining !== null) return;
    const drain = this.#drain(entry).finally(() => this.#draining.delete(drain));
    entry.draining = drain;
    this.#draining.add(drain);
  }

  async #drain(entry: Entry): Promise<void> {
    await Promise.resolve(); // this turn's inputs are in before the first look
    try {
      while (!this.#refused) {
        const wanted = wantedStatus(entry.root, entry.activity);
        if (wanted === entry.sent) break;
        const resend = entry.resend;
        const outcome = await this.#send(entry, wanted);
        if (outcome === "gone") return this.#drop(entry);
        if (outcome === "failed") {
          // A call whose answer was lost may or may not have reached Slack: nothing counts as sent.
          entry.sent = null;
          entry.failures = entry.failedStatus === wanted ? entry.failures + 1 : 1;
          entry.failedStatus = wanted;
          // A change meanwhile is sent at once, else the retry timer tries again.
          if (wanted === wantedStatus(entry.root, entry.activity) && resend === entry.resend) {
            this.#armRetry(entry);
            return;
          }
          continue;
        }
        entry.failures = 0;
        entry.failedStatus = null;
        this.#disarmRetry(entry);
        if (resend === entry.resend) entry.sent = wanted;
        this.#arm(entry, wanted === "processing" ? this.#refresh : null);
      }
      // Active and sent: a later input makes the entry again.
      if (wantedStatus(entry.root, entry.activity) === "active" && entry.sent !== null) {
        this.#drop(entry);
      }
    } finally {
      // Nothing is awaited since the last look: an input after this starts a drain.
      entry.draining = null;
    }
  }

  #drop(entry: Entry): void {
    this.#disarm(entry);
    this.#disarmRetry(entry);
    if (this.#entries.get(key(entry.ref)) === entry) this.#entries.delete(key(entry.ref));
  }

  async #send(entry: Entry, status: SessionState): Promise<"sent" | "failed" | "gone"> {
    const { channel, thread } = entry.ref;
    try {
      await this.#set(entry.ref, status);
      entry.failedCode = null;
      this.#proven = true;
      return "sent";
    } catch (error) {
      const code = describe(error);
      if (code !== entry.failedCode) {
        this.#log.warning(`agents.sessions.setStatus failed on ${channel}/${thread}: ${code}`);
      }
      entry.failedCode = code;
      if (SESSION_REFUSED.includes(code)) this.#refused = true;
      return gone(error) ? "gone" : "failed";
    }
  }

  /**
   * One `setStatus`, attributed to the initiator while Slack takes that: a call that carried
   * it and was refused by an answer of Slack's (it requires the user to be in the channel) is sent
   * again at once without it; the channel is remembered as initiator-less when that passes. A
   * transient failure marks nothing and takes the ordinary retry. Status never depends on it.
   */
  async #set(ref: ThreadRef, status: SessionState): Promise<void> {
    const call = { channel_id: ref.channel, thread_ts: ref.thread, status };
    const initiator = this.#initiator;
    if (initiator === undefined || this.#bare.has(ref.channel)) {
      await this.#slack.agents.sessions.setStatus(call);
      return;
    }
    try {
      await this.#slack.agents.sessions.setStatus({ ...call, initiator_user_id: initiator });
    } catch (first) {
      // A transient failure takes the ordinary retry, which still carries the initiator: only an
      // answer that refuses the call itself sends it again without.
      if (!(first instanceof WebAPIPlatformError) || TRANSIENT.includes(describe(first)))
        throw first;
      await this.#slack.agents.sessions.setStatus(call);
      this.#bare.add(ref.channel);
      this.#log.warning(
        `agents.sessions.setStatus without initiator on ${ref.channel}: ${describe(first)}`,
      );
    }
  }

  /** Calls again in `seconds` unless another call goes out first (`null`: no timer). */
  #arm(entry: Entry, seconds: number | null): void {
    this.#disarm(entry);
    if (seconds === null || this.#refused || this.#closed) return;
    const timer = new AbortController();
    entry.refresh = timer;
    this.#clock.sleep(seconds, timer.signal).then(
      () => {
        if (entry.refresh !== timer) return;
        entry.refresh = null;
        this.#again(entry);
      },
      () => {},
    );
  }

  /** Sends the wanted status again after the backoff step of the entry's failures. */
  #armRetry(entry: Entry): void {
    this.#disarmRetry(entry);
    if (this.#refused || this.#closed) return;
    const steps = SESSION_RETRY_SECONDS;
    const seconds = steps[Math.min(Math.max(entry.failures, 1), steps.length) - 1] as number;
    const timer = new AbortController();
    entry.retry = timer;
    this.#clock.sleep(seconds, timer.signal).then(
      () => {
        if (entry.retry !== timer) return;
        entry.retry = null;
        this.#kick(entry);
      },
      () => {},
    );
  }

  #disarmRetry(entry: Entry): void {
    entry.retry?.abort();
    entry.retry = null;
  }

  #disarm(entry: Entry): void {
    entry.refresh?.abort();
    entry.refresh = null;
  }
}

function key(ref: ThreadRef): string {
  return `${ref.channel}\n${ref.thread}`;
}
