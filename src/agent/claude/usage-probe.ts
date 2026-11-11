/**
 * The account's usage limits, read from `/usage` on a session of their own: the limits belong to
 * the account, and a probe inside a channel's session would add to that session's transcript.
 * Each read starts its session and closes it: a process reports the account it started on, while
 * `/usage` answers for the login of the moment, so only a session started for the read names the
 * account its limits belong to (#276).
 */
import { randomUUID } from "node:crypto";
import { type Clock, systemClock } from "../../clock.ts";
import type {
  AgentSession,
  PermissionAnswer,
  QuestionAnswer,
  RequestHandler,
  UsageLimits,
} from "../seam.ts";
import { parseUsage, USAGE_TIMEOUT } from "./usage.ts";

const REFUSAL = "The usage probe asks for nothing.";

// `/usage` runs inside Claude Code and asks nothing; should it ever, the answer is no.
const NO_ANSWERS: RequestHandler = {
  permission: async (): Promise<PermissionAnswer> => ({ allow: false, message: REFUSAL }),
  question: async (): Promise<QuestionAnswer> => ({ answered: false, message: REFUSAL }),
};

/** How the probe starts its session: `ClaudeBackend.startBare`, which takes no option of a thread's. */
export type BareStart = (folder: string, requests: RequestHandler) => Promise<AgentSession>;

export interface UsageProbeOptions {
  readonly clock?: Clock;
  /** Milliseconds one `read` may take, start included. */
  readonly timeout?: number;
  /**
   * The wall time a reset is dated on, in milliseconds since the epoch; `Date.now` when absent.
   * Never `clock`: the daemon gives the back end the monotonic one, which counts from its start.
   */
  readonly now?: () => number;
}

export class UsageProbe {
  readonly #folder: string;
  readonly #start: BareStart;
  readonly #clock: Clock;
  readonly #timeout: number;
  readonly #now: () => number;
  #session: AgentSession | null = null;
  // Counts the closes, so a session still starting when one happens is closed as it arrives.
  #epoch = 0;
  #stopped = false;

  /** `start` is the back end's bare one: the probe session takes nothing of the owner's. */
  constructor(folder: string, start: BareStart, options: UsageProbeOptions = {}) {
    this.#folder = folder;
    this.#start = start;
    this.#clock = options.clock ?? systemClock;
    this.#timeout = options.timeout ?? USAGE_TIMEOUT;
    this.#now = options.now ?? Date.now;
  }

  /**
   * The limits `/usage` reports now, with the account the read's own session started on. One
   * timeout covers the whole call, and the session is closed whatever the outcome; a failure, the
   * timeout included, is rethrown.
   */
  async read(): Promise<UsageLimits> {
    if (this.#stopped) throw new Error("the usage probe is stopped");
    const limit = new AbortController();
    // Settles only by running out: the sleep's own rejection is its cancellation.
    const expiry = new Promise<never>((_, reject) => {
      this.#clock.sleep(this.#timeout / 1000, limit.signal).then(
        () => reject(new DOMException("the usage probe had no answer in time", "TimeoutError")),
        () => undefined,
      );
    });
    try {
      return await Promise.race([this.#ask(), expiry]);
    } finally {
      limit.abort();
      await this.close();
    }
  }

  /** Closes the session of a read in flight, if one is open; that read then fails. */
  async close(): Promise<void> {
    this.#epoch += 1;
    const session = this.#session;
    this.#session = null;
    if (session !== null) await session.close();
  }

  /**
   * The daemon's last close: the session is closed and no `read` starts another. A footer
   * refresh that a listener in flight still asks for would otherwise start a Claude Code process
   * nobody closes.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    await this.close();
  }

  async #ask(): Promise<UsageLimits> {
    const epoch = this.#epoch;
    const session = await this.#start(this.#folder, NO_ANSWERS);
    if (epoch !== this.#epoch) {
      await session.close();
      throw new Error("the usage probe was closed while it started");
    }
    this.#session = session;
    const events = session.events[Symbol.asyncIterator]();
    const { account } = await session.info();
    await session.send({ id: randomUUID(), content: "/usage" });
    for (;;) {
      const next = await events.next();
      if (next.done) throw new Error("the usage probe's session ended");
      const event = next.value;
      if (event.type === "turn_ended") {
        return { ...parseUsage(event.finalText ?? "", this.#now()), account };
      }
      if (event.type === "process_lost") throw new Error("the usage probe lost its process");
    }
  }
}
