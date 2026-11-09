/**
 * The title of each thread's Slack agent session (Agents & tools): `<channel> - <title>`, where
 * `<title>` is the root's uncut label. `agents.sessions.rename` and `setStatus` read from docs.slack.dev/reference/methods/,
 * 2026-11-08: `setStatus` takes a title only when it creates the session, so a title is only ever
 * set by `rename` (`session_not_found` when no session exists). On a thread session `rename`
 * applies the rules of a channel name, measured 2026-11-09 where the docs say 1 to 200
 * characters: 80 at most, and `REFUSED_CHARACTERS` answer `invalid_name`.
 *
 * One record per thread outlives the status entry. Every input is synchronous on the record and
 * followed by `pump`; one sender per record sends the latest wanted title and nothing else, so a
 * title written while a call is in flight is the one Slack ends with. A rename is sent only once
 * a `setStatus` made the session in this process.
 */
import type { WebClient } from "@slack/web-api";
import type { Clock } from "../../../clock.ts";
import { getLogger, type Logger } from "../../../log.ts";
import type { ThreadRef } from "../../seam.ts";
import { rootFirstLine } from "../channel-line.ts";
import { isTombstone } from "../channels.ts";
import { SESSION_REFUSED, SESSION_RETRY_SECONDS } from "./agent-session.ts";
import { describe, gone } from "./errors.ts";

export const logger = getLogger("allaboard.chat.slack.reply.agent-titles");

// The longest title `rename` takes on a thread session, measured 2026-11-09 (81 is refused). Counted
// in UTF-16 units, which holds whether Slack counts those or code points.
export const TITLE_LIMIT = 80;

// What `rename` refuses with `invalid_name` on a thread session, measured 2026-11-09 one character
// at a time; each becomes a space, so the words around it stay apart.
const REFUSED_CHARACTERS = /[[\]:/#@*+%$<>\\`~^{};]/g;

// Refusals of this title for this thread only: a later title may pass.
const TITLE_REFUSED = ["invalid_arguments", "invalid_name"];

interface TitleRecord {
  readonly ref: ThreadRef;
  latest: string | null; // the label wanted; null: not known yet, the sender reads the root
  named: string | null; // the label Slack last accepted
  refused: string | null; // the label Slack refused for this thread
  exists: boolean; // a `setStatus` succeeded for the thread in this process
  seen: number; // `setStatus` successes reported, to tell one that arrived during a call
  sending: Promise<void> | null;
  retry: AbortController | null;
  failures: number;
  failedCode: string | null;
}

export interface AgentTitlesOptions {
  readonly clock: Clock;
  readonly logger?: Logger;
}

type Outcome = "sent" | "gone" | "missing" | "refused" | "failed";

export class AgentTitles {
  readonly #slack: WebClient;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #records = new Map<string, TitleRecord>();
  readonly #senders = new Set<Promise<void>>();
  // The channel's name, once per channel per process: a name changed meanwhile is not followed.
  readonly #names = new Map<string, Promise<string>>();
  #stopped = false; // the token or the app refuses agent sessions: no rename can succeed
  #closed = false;

  constructor(slack: WebClient, options: AgentTitlesOptions) {
    this.#slack = slack;
    this.#clock = options.clock;
    this.#log = options.logger ?? logger;
  }

  /** A `setStatus` succeeded for the thread: its session exists. */
  exists(ref: ThreadRef): void {
    const record = this.#record(ref);
    record.exists = true;
    record.seen += 1;
    this.#pump(record);
  }

  /** The thread's root now shows `text`, which names its session. */
  title(ref: ThreadRef, text: string): void {
    const record = this.#record(ref);
    record.latest = rootFirstLine({ text });
    this.#pump(record);
  }

  /** Marks the titles closed at once: no sender starts after it. `close` waits for the rest. */
  halt(): void {
    this.#closed = true;
    for (const record of this.#records.values()) this.#disarm(record);
  }

  /** Cancels the retries, then waits for the senders: no call starts after it. */
  async close(): Promise<void> {
    this.halt();
    while (this.#senders.size > 0) await Promise.all([...this.#senders]);
  }

  #record(ref: ThreadRef): TitleRecord {
    const key = `${ref.channel}\n${ref.thread}`;
    let record = this.#records.get(key);
    if (record === undefined) {
      record = {
        ref,
        latest: null,
        named: null,
        refused: null,
        exists: false,
        seen: 0,
        sending: null,
        retry: null,
        failures: 0,
        failedCode: null,
      };
      this.#records.set(key, record);
    }
    return record;
  }

  #pump(record: TitleRecord): void {
    if (this.#closed || this.#stopped || !record.exists || record.sending !== null) return;
    if (
      record.latest !== null &&
      (record.latest === record.named || record.latest === record.refused)
    ) {
      return;
    }
    this.#disarm(record);
    const sender = this.#run(record).finally(() => {
      record.sending = null;
      this.#senders.delete(sender);
      // An input that came while this sender was ending found it running and sent nothing.
      if (this.#records.get(`${record.ref.channel}\n${record.ref.thread}`) === record) {
        if (record.retry === null) this.#pump(record);
      }
    });
    record.sending = sender;
    this.#senders.add(sender);
  }

  async #run(record: TitleRecord): Promise<void> {
    if (record.latest === null) {
      const read = await this.#read(record);
      if (read.outcome !== "sent") return this.#after(record, read.outcome, read.code, read.method);
      // An input that arrived during the read wins over it.
      record.latest ??= read.label;
    }
    while (!this.#closed && !this.#stopped && record.exists) {
      const wanted = record.latest;
      if (wanted === null || wanted === record.named || wanted === record.refused) return;
      const seen = record.seen;
      const { outcome, code, method } = await this.#rename(record, wanted);
      if (outcome === "sent") {
        record.named = wanted;
        record.failures = 0;
        record.failedCode = null;
        continue;
      }
      if (outcome === "refused") {
        record.refused = wanted;
        this.#warn(record, code, method, "refused the title");
        continue; // a title written meanwhile is still sent
      }
      // A `setStatus` success that arrived during the call made the session again: send anew.
      if (outcome === "missing" && record.seen !== seen) continue;
      return this.#after(record, outcome, code, method);
    }
  }

  /** The end of a sender on an outcome other than a sent title or a refused one. */
  #after(record: TitleRecord, outcome: Outcome, code: string, method: string): void {
    if (this.#closed) return;
    if (outcome === "gone") {
      this.#disarm(record);
      this.#records.delete(`${record.ref.channel}\n${record.ref.thread}`);
    } else if (outcome === "missing") {
      // The next successful `setStatus` makes the session again and pumps, with no new read.
      record.exists = false;
    } else if (outcome === "failed") {
      this.#warn(record, code, method, "failed");
      record.failures += 1;
      this.#arm(record);
    }
  }

  async #read(
    record: TitleRecord,
  ): Promise<{ outcome: Outcome; code: string; method: string; label: string }> {
    const { channel, thread } = record.ref;
    const method = "conversations.replies";
    if (this.#closed) return { outcome: "failed", code: "closed", method, label: "" };
    try {
      const answer = await this.#slack.conversations.replies({
        channel,
        ts: thread,
        limit: 1,
        include_all_metadata: true,
      });
      const messages: unknown[] = Array.isArray(answer.messages) ? answer.messages : [];
      const root = messages.find(
        (message): message is Readonly<Record<string, unknown>> =>
          typeof message === "object" &&
          message !== null &&
          (message as { ts?: unknown }).ts === thread,
      );
      // A root the answer lacks, or a tombstone (a root deleted while replies remain), is gone.
      if (root === undefined || isTombstone(root)) {
        return { outcome: "gone", code: "root_not_returned", method, label: "" };
      }
      return { outcome: "sent", code: "", method, label: rootFirstLine(root) };
    } catch (error) {
      return { ...this.#classify(error, method), method, label: "" };
    }
  }

  async #rename(
    record: TitleRecord,
    label: string,
  ): Promise<{ outcome: Outcome; code: string; method: string }> {
    const { channel, thread } = record.ref;
    let method = "conversations.info";
    if (this.#closed) return { outcome: "failed", code: "closed", method };
    try {
      const name = await this.#nameOf(channel);
      if (this.#closed) return { outcome: "failed", code: "closed", method };
      method = "agents.sessions.rename";
      await this.#slack.agents.sessions.rename({
        channel_id: channel,
        thread_ts: thread,
        title: this.#titled(name, label),
      });
      return { outcome: "sent", code: "", method };
    } catch (error) {
      return { ...this.#classify(error, method), method };
    }
  }

  /** `method` is the call that failed: only a rename's `session_not_found` or title refusal count. */
  #classify(error: unknown, method: string): { outcome: Outcome; code: string } {
    const code = describe(error);
    if (gone(error)) return { outcome: "gone", code };
    if (method === "agents.sessions.rename") {
      if (code === "session_not_found") return { outcome: "missing", code };
      if (TITLE_REFUSED.includes(code)) return { outcome: "refused", code };
    }
    if (SESSION_REFUSED.includes(code)) {
      this.#stopped = true;
      this.#log.warning(`${method} refused (${code}): titles stop for this process`);
      return { outcome: "gone", code }; // nothing more to try; the record is dropped
    }
    return { outcome: "failed", code };
  }

  #nameOf(channel: string): Promise<string> {
    let name = this.#names.get(channel);
    if (name === undefined) {
      name = this.#slack.conversations.info({ channel }).then((answer) => {
        const found = answer.channel?.name;
        if (typeof found !== "string" || found === "") throw new Error("no_channel_name");
        return found;
      });
      this.#names.set(channel, name);
      // A failure is not remembered: the retry asks again.
      name.catch(() => {
        if (this.#names.get(channel) === name) this.#names.delete(channel);
      });
    }
    return name;
  }

  /**
   * `channel - label`, each refused character a space and the spaces collapsed, cut to
   * `TITLE_LIMIT` UTF-16 units with `…`, no pair split.
   */
  #titled(channel: string, label: string): string {
    const full = `${channel} - ${label}`
      .replace(REFUSED_CHARACTERS, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (full.length <= TITLE_LIMIT) return full;
    let cut = "";
    for (const char of full) {
      if (cut.length + char.length > TITLE_LIMIT - 1) break;
      cut += char;
    }
    return `${cut}…`;
  }

  #warn(record: TitleRecord, code: string, method: string, what: string): void {
    if (code === record.failedCode) return;
    record.failedCode = code;
    const { channel, thread } = record.ref;
    this.#log.warning(`${method} ${what} on ${channel}/${thread}: ${code}`);
  }

  /** Sends the latest title again after the backoff step of the record's failures. */
  #arm(record: TitleRecord): void {
    this.#disarm(record);
    if (this.#closed || this.#stopped) return;
    const steps = SESSION_RETRY_SECONDS;
    const seconds = steps[Math.min(Math.max(record.failures, 1), steps.length) - 1] as number;
    const timer = new AbortController();
    record.retry = timer;
    this.#clock.sleep(seconds, timer.signal).then(
      () => {
        if (record.retry !== timer) return;
        record.retry = null;
        this.#pump(record);
      },
      () => {},
    );
  }

  #disarm(record: TitleRecord): void {
    record.retry?.abort();
    record.retry = null;
  }
}
