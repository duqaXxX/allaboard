/**
 * Forgetting what `state.json` no longer needs: a bound channel the chat no longer has, a thread
 * whose first message the chat no longer has, and a thread that never started a session. Run once on
 * start and then every `CLEAN_EVERY_SECONDS`, so a daemon that stays up for weeks cleans too.
 *
 * Only a certain answer removes anything. A channel is certainly gone only when the chat provider
 * has made it certain (a chat may answer the same for a channel the bot was removed from, which
 * is the provider's to tell apart, or else to keep). A rate limit, a
 * server error or the network is no answer and removes nothing. A thread is asked about only in
 * a channel that answered `there` in the same pass (the credentials of another account of the
 * chat must never wipe threads), and its certain answer is the chat saying its first message does
 * not exist, or has been replaced by a placeholder that keeps the replies. A thread whose session
 * the agent no longer lists is kept, since its messages remain: only `StateStore.prune`'s
 * `never started` rule drops a thread of this kind. The chat provider supplies the lookups that
 * turn its own answers into a `Presence` (the Slack mapping is in `docs/slack-provider.md`).
 */
import type { Presence, ThreadRef } from "../chat/seam.ts";
import { getLogger, type Logger } from "../log.ts";
import { errorName } from "../values.ts";
import type { OpenedAt, StateStore } from "./state.ts";

export const logger = getLogger("allaboard.core.cleanup");

/** What a pass writes to the log, so a test can hand it a smaller object. */
type Log = Pick<Logger, "info" | "warning">;

/** What `forgetGoneChannels` did: the channels removed, and those the chat found. */
export interface ForgottenChannels {
  readonly forgotten: string[];
  readonly found: string[];
}

export const CLEAN_EVERY_SECONDS = 6 * 60 * 60;

/**
 * Asks the chat about one channel by its id; a lookup that throws counts as `no answer`. The
 * answer is `gone` (a certain one), `there`, or `no answer` (a rate limit, a server error, the
 * network, a refused scope).
 */
export type ChannelLookup = (channelId: string) => Promise<Presence>;

/** Asks the chat about one thread; answers like a `ChannelLookup`. */
export type ThreadLookup = (ref: ThreadRef) => Promise<Presence>;

/**
 * The (channelId, threadId) of every thread with a live session in the daemon, read at the moment
 * it is needed: nothing of theirs is removed under them.
 */
export type Live = () => Iterable<ThreadRef>;

export interface CleanOptions {
  readonly threadLookup: ThreadLookup;
  /** True once a stop has begun: the threads not yet asked about wait for the next start. */
  readonly stopping?: () => boolean;
  readonly live: Live;
  /** The chat's name (`ChatProvider.name`), for the log lines that say whose answer it was. */
  readonly chat: string;
  /** When the chat opened a thread (`ChatProvider.openedAt`): a thread it cannot date is kept. */
  readonly openedAt: OpenedAt;
  /** Seconds since the epoch. */
  readonly now?: () => number;
  readonly logger?: Log;
}

/**
 * Remove from `state` each bound channel the chat answers `gone` about, with its threads. Returns
 * the ids it forgot and those it `found` (answered `there`): the channels whose threads may be
 * asked about. A channel with a live session is left for the next pass. When the chat finds
 * none of the bound channels (a channel it gave no answer about is not one it found), nothing is
 * removed: that is what the credentials of another account of the chat, or an app removed from every channel,
 * looks like, and forgetting every binding would be the wrong repair. `chat` is the chat's
 * name, for the log lines. Once `stopping` says a stop has begun no further channel is asked
 * about and nothing is forgotten: the channels left for the next start.
 */
export async function forgetGoneChannels(
  lookup: ChannelLookup,
  state: StateStore,
  live: Live,
  chat: string,
  log: Log = logger,
  stopping: () => boolean = () => false,
): Promise<ForgottenChannels> {
  const bound = state.channels();
  const gone: string[] = [];
  const found: string[] = [];
  for (const channelId of bound) {
    // One call to the chat per channel: a stop that begins meanwhile waits for one, not for all.
    if (stopping()) return { forgotten: [], found };
    let answer: Presence;
    try {
      answer = await lookup(channelId);
    } catch (error) {
      log.warning(`could not read channel ${channelId}: ${errorName(error)}`);
      continue;
    }
    if (answer === "there") {
      found.push(channelId);
    } else if (answer === "gone") {
      gone.push(channelId);
    } else {
      log.warning(`could not read channel ${channelId}: ${answer}`);
    }
  }
  if (gone.length === 0) return { forgotten: [], found };
  if (found.length === 0) {
    log.warning(
      `${chat} finds none of the ${bound.length} bound channels: nothing is forgotten (check the ` +
        "account the credentials belong to, and that the bot is still in its channels)",
    );
    return { forgotten: [], found };
  }
  const busy = new Set([...live()].map((ref) => ref.channel));
  const forgotten: string[] = [];
  for (const channelId of gone) {
    const record = state.channel(channelId);
    if (record === null || busy.has(channelId)) continue;
    state.removeChannel(channelId);
    forgotten.push(channelId);
    log.info(
      `forgot channel ${channelId}: ${chat} no longer has it (${record.threads.size} thread(s))`,
    );
  }
  return { forgotten, found };
}

/**
 * Remove from `state` each thread, among those of the `channels` the chat found, whose first
 * message the chat answers `gone` about, and return them. A thread with a live session (read
 * when it is removed, after the chat was asked) is left for the next pass, as are the threads of
 * a channel after the first one the chat gave no answer about, and every thread not yet asked
 * about once `stopping` says a stop has begun.
 */
export async function forgetGoneThreads(
  lookup: ThreadLookup,
  state: StateStore,
  channels: readonly string[],
  live: Live,
  chat: string,
  log: Log = logger,
  stopping: () => boolean = () => false,
): Promise<ThreadRef[]> {
  const asked = new Set(channels);
  const gone: ThreadRef[] = [];
  for (const [channel, thread] of state.threads()) {
    // One call to the chat per thread: a stop that begins meanwhile waits for one, not for all.
    if (stopping()) break;
    if (!asked.has(channel)) continue;
    const ref = { channel, thread };
    let answer: Presence | string;
    try {
      answer = await lookup(ref);
    } catch (error) {
      answer = errorName(error);
    }
    if (answer === "gone") {
      gone.push(ref);
    } else if (answer !== "there") {
      // What kept the chat from answering (a rate limit, a history it may not read) holds for
      // the channel's other threads too: they wait for the next pass, with one line here.
      log.warning(`could not read thread ${thread} of ${channel}: ${answer}`);
      asked.delete(channel);
    }
  }
  const busy = new Set([...live()].map((ref) => `${ref.channel}\u0000${ref.thread}`));
  const forgotten: ThreadRef[] = [];
  for (const ref of gone) {
    if (
      busy.has(`${ref.channel}\u0000${ref.thread}`) ||
      state.thread(ref.channel, ref.thread) === null
    ) {
      continue;
    }
    state.removeThread(ref.channel, ref.thread);
    forgotten.push(ref);
    log.info(
      `forgot thread ${ref.thread} of ${ref.channel}: ${chat} no longer has its first message`,
    );
  }
  return forgotten;
}

/**
 * One pass: forget the channels that are gone, then the threads of the others whose first message
 * is gone, then prune the threads that never started a session. A thread whose session the agent
 * no longer lists stays: its messages remain, and the Home lists it from the state. Never throws:
 * a pass that fails is logged and the next one tries again.
 */
export async function clean(
  lookup: ChannelLookup,
  state: StateStore,
  options: CleanOptions,
): Promise<void> {
  const { live } = options;
  const now = options.now ?? (() => Date.now() / 1000);
  const log = options.logger ?? logger;
  let found: readonly string[] = [];
  try {
    found = (await forgetGoneChannels(lookup, state, live, options.chat, log, options.stopping))
      .found;
  } catch (error) {
    log.warning(`could not check the bound channels: ${errorName(error)}`);
  }
  try {
    await forgetGoneThreads(
      options.threadLookup,
      state,
      found,
      live,
      options.chat,
      log,
      options.stopping,
    );
  } catch (error) {
    log.warning(`could not check the threads: ${errorName(error)}`);
  }
  // A stop closes the sessions after this pass: the keep set `live` gives would then be empty,
  // and a thread whose setup is still open (no session id yet) would be pruned for its age.
  // The next start prunes.
  if (options.stopping?.()) return;
  try {
    const removed = state.prune(options.openedAt, now(), live());
    for (const { ref } of removed) {
      log.info(`pruned thread ${ref.channel}/${ref.thread}: no session started within a day`);
    }
  } catch (error) {
    log.warning(`could not prune stale threads: ${errorName(error)}`);
  }
}

/**
 * The only way a pass of `clean` starts: the one at start, the scheduled ones and the owner's
 * Refresh all ask here. One pass runs at a time; a request made while one runs shares the single
 * pass that follows it (the first pass may have read a channel before the owner's change), so any
 * number of clicks cost at most one more. Once `stopping` says a stop has begun a request does
 * nothing, and neither does the pass queued behind a running one.
 */
export class Cleanups {
  readonly #run: () => Promise<void>;
  readonly #stopping: () => boolean;
  readonly #log: Log;
  #running: Promise<void> | null = null;
  #next: Promise<void> | null = null;

  constructor(run: () => Promise<void>, stopping: () => boolean, log: Log = logger) {
    this.#run = run;
    this.#stopping = stopping;
    this.#log = log;
  }

  /** Resolves once a pass that began after this call has ended, or at once during a stop. Never rejects. */
  request(): Promise<void> {
    if (this.#stopping()) return Promise.resolve();
    // A pass queued behind the running one is joined before the running one is looked at: the
    // running pass clears `#running` a turn before the queued one starts.
    if (this.#next !== null) return this.#next;
    if (this.#running === null) return this.#launch();
    this.#next ??= this.#running.then(() => {
      this.#next = null;
      return this.#stopping() ? undefined : this.#launch();
    });
    return this.#next;
  }

  /** Resolves once the pass running and the one queued behind it have ended; at once with none. */
  settled(): Promise<void> {
    return this.#next ?? this.#running ?? Promise.resolve();
  }

  #launch(): Promise<void> {
    const pass = (async () => {
      try {
        await this.#run();
      } catch (error) {
        this.#log.warning(`the cleanup failed: ${errorName(error)}`);
      } finally {
        this.#running = null;
      }
    })();
    this.#running = pass;
    return pass;
  }
}
