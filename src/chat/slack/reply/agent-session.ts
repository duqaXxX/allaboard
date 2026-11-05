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
import type { WebClient } from "@slack/web-api";
import type { Clock } from "../../../clock.ts";
import { getLogger, type Logger } from "../../../log.ts";
import type { RootStatus, ThreadRef } from "../../seam.ts";
import { describe, gone } from "./errors.ts";

export const logger = getLogger("allaboard.chat.slack.reply.agent-session");

/** The statuses this module sends; `closed` is never one. */
export type SessionState = "active" | "processing" | "suspended";

// A session left in `processing` times out after one hour: set again at half of it.
export const SESSION_REFRESH_SECONDS = 30 * 60;

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
}

export interface AgentSessionsOptions {
  readonly clock: Clock;
  readonly refresh?: number;
  readonly logger?: Logger;
}

export class AgentSessions {
  readonly #slack: WebClient;
  readonly #clock: Clock;
  readonly #refresh: number;
  readonly #log: Logger;
  readonly #entries = new Map<string, Entry>();
  // Every drain in flight, entries dropped meanwhile included, for `close`.
  readonly #draining = new Set<Promise<void>>();
  #refused = false;
  #closed = false;
  #failed: string | null = null;

  constructor(slack: WebClient, options: AgentSessionsOptions) {
    this.#slack = slack;
    this.#clock = options.clock;
    this.#refresh = options.refresh ?? SESSION_REFRESH_SECONDS;
    this.#log = options.logger ?? logger;
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

  /** Cancels the timers, then waits for the calls in flight and queued. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const entry of this.#entries.values()) this.#disarm(entry);
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
          // `sent` stays; a change meanwhile is sent at once, else the next input or the refresh tries.
          if (wanted === wantedStatus(entry.root, entry.activity) && resend === entry.resend)
            return;
          continue;
        }
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
    if (this.#entries.get(key(entry.ref)) === entry) this.#entries.delete(key(entry.ref));
  }

  async #send(entry: Entry, status: SessionState): Promise<"sent" | "failed" | "gone"> {
    const { channel, thread } = entry.ref;
    try {
      await this.#slack.agents.sessions.setStatus({
        channel_id: channel,
        thread_ts: thread,
        status,
      });
      this.#failed = null;
      return "sent";
    } catch (error) {
      const code = describe(error);
      if (code !== this.#failed) {
        this.#log.warning(`agents.sessions.setStatus failed on ${channel}/${thread}: ${code}`);
      }
      this.#failed = code;
      if (SESSION_REFUSED.includes(code)) this.#refused = true;
      return gone(error) ? "gone" : "failed";
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

  #disarm(entry: Entry): void {
    entry.refresh?.abort();
    entry.refresh = null;
  }
}

function key(ref: ThreadRef): string {
  return `${ref.channel}\n${ref.thread}`;
}
