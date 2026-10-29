import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { Presence, ThreadRef } from "../../src/chat/seam.ts";
import {
  type ChannelLookup,
  Cleanups,
  clean,
  forgetGoneChannels,
  forgetGoneThreads,
  type ThreadLookup,
} from "../../src/core/cleanup.ts";
import { StateStore } from "../../src/core/state.ts";
import type { Logger } from "../../src/log.ts";
import { AsyncEvent } from "../support/fake-clock.ts";

const CHANNEL = "chan-1";
const GONE_CHANNEL = "chan-gone";
const OTHER_GONE = "chan-gone-2";
const THREAD = "thread-1";
const GONE_THREAD = "thread-gone";
const SESSION = "68da9311-0000-4000-8000-00000000000a";
const NOBODY: readonly ThreadRef[] = [];
/** A thread's name read as its opening time in epoch seconds, as a chat whose names are times does. */
// When the chat says each thread was opened, in epoch seconds.
const OPENED_AT: Record<string, number> = {
  "thread-1": 1789000000.0001,
  "thread-gone": 1789000500.0001,
  "thread-late": 1789000900.0001,
};
const opened = (ref: ThreadRef): number | null => OPENED_AT[ref.thread] ?? null;

function nothingLive(): readonly ThreadRef[] {
  return NOBODY;
}

const made: string[] = [];

after(() => {
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

/** The lines a pass logs, by level. */
interface Logged extends Pick<Logger, "info" | "warning"> {
  readonly lines: string[];
}

function logged(): Logged {
  const lines: string[] = [];
  return {
    lines,
    info: (message) => lines.push(`INFO ${message}`),
    warning: (message) => lines.push(`WARNING ${message}`),
  };
}

let directory: string;
let state: StateStore;
let log: Logged;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "awd-cleanup-"));
  made.push(directory);
  state = new StateStore(join(directory, "state.json"), { warn: () => undefined });
  state.bind(CHANNEL, join(directory, "project"));
  state.bind(GONE_CHANNEL, join(directory, "old"));
  state.openThread(CHANNEL, THREAD, SESSION);
  state.openThread(GONE_CHANNEL, GONE_THREAD, SESSION);
  log = logged();
});

/** What the chat can answer about a channel: a `Presence`, or an exception. */
type Reply = Presence | Error;

/**
 * The lookup a chat provider supplies for a channel, over fake answers: it answers per channel id
 * with what is named, else `otherwise`. An exception is `no answer`, which is what a provider
 * makes of a failed call.
 */
function channelsInChat(replies: Record<string, Reply>, otherwise: Reply = "there"): ChannelLookup {
  return async (channelId) => {
    const reply = replies[channelId] ?? otherwise;
    return reply instanceof Error ? "no answer" : reply;
  };
}

/**
 * The lookup a chat provider supplies for a thread, over fake answers keyed by thread id (`there`
 * when a thread is not named): an exception is thrown as a provider may. `asked` collects the
 * threads it was asked about.
 */
function threadsInChat(
  replies: Record<string, Presence | Error>,
  asked: ThreadRef[] = [],
): ThreadLookup {
  return async (ref) => {
    asked.push(ref);
    const reply = replies[ref.thread] ?? "there";
    if (reply instanceof Error) throw reply;
    return reply;
  };
}

const found = [CHANNEL];
const GONE_ROOT = "thread-late";
const SECOND_SESSION = "68da9311-0000-4000-8000-00000000000b";

test("a channel the chat no longer has is forgotten with its threads", async () => {
  const lookup = channelsInChat({ [GONE_CHANNEL]: "gone" });
  assert.deepEqual(
    (await forgetGoneChannels(lookup, state, nothingLive, "Memory chat", log)).forgotten,
    [GONE_CHANNEL],
  );
  assert.deepEqual(state.channels(), [CHANNEL]);
  assert.equal(state.thread(GONE_CHANNEL, GONE_THREAD), null);
  assert.notEqual(state.thread(CHANNEL, THREAD), null);
  const text = log.lines.join("\n");
  assert.ok(text.includes(GONE_CHANNEL) && text.includes("1 thread"));
});

// The lookup maps every answer but `channel_not_found` to `no answer`, so one row stands for all.
test("anything but not found forgets nothing", async () => {
  // Not an answer about the channel: it cannot be told gone.
  const lookup = channelsInChat({ [GONE_CHANNEL]: "no answer" });
  assert.deepEqual(
    (await forgetGoneChannels(lookup, state, nothingLive, "Memory chat", log)).forgotten,
    [],
  );
  assert.deepEqual(state.channels(), [CHANNEL, GONE_CHANNEL]);
});

test("no channel the chat can see forgets nothing and says so", async () => {
  // Every bound channel not found: the token of another workspace, or the app removed from
  // them all. Wiping every binding on that would be the wrong repair.
  const lookup = channelsInChat({}, "gone");
  assert.deepEqual(
    (await forgetGoneChannels(lookup, state, nothingLive, "Memory chat", log)).forgotten,
    [],
  );
  assert.deepEqual(state.channels(), [CHANNEL, GONE_CHANNEL]);
  assert.ok(log.lines.join("\n").includes("none of the 2 bound channels"));
});

test("a pass in which the chat found no channel forgets nothing", async () => {
  // The lookup of another tenant, and one call that failed for a reason of its own: a
  // channel the chat did not answer about is not a channel it found.
  state.bind(OTHER_GONE, "/srv/elsewhere");
  const gone = "gone";
  const lookup = channelsInChat({
    [CHANNEL]: new Error("network down"),
    [GONE_CHANNEL]: gone,
    [OTHER_GONE]: gone,
  });
  assert.deepEqual(
    (await forgetGoneChannels(lookup, state, nothingLive, "Memory chat", log)).forgotten,
    [],
  );
  assert.deepEqual(state.channels(), [CHANNEL, GONE_CHANNEL, OTHER_GONE]);
  assert.ok(log.lines.join("\n").includes("none of the 3 bound channels"));
});

test("a channel with a live session is left for the next pass", async () => {
  const lookup = channelsInChat({ [GONE_CHANNEL]: "gone" });
  const live: ThreadRef[] = [{ channel: GONE_CHANNEL, thread: GONE_THREAD }];
  assert.deepEqual(
    (await forgetGoneChannels(lookup, state, () => live, "Memory chat", log)).forgotten,
    [],
  );
  assert.deepEqual(state.channels(), [CHANNEL, GONE_CHANNEL]);
});

test("several gone channels go in one pass", async () => {
  state.bind(OTHER_GONE, "/srv/elsewhere");
  const gone = "gone";
  const lookup = channelsInChat({ [GONE_CHANNEL]: gone, [OTHER_GONE]: gone });
  assert.deepEqual(
    (await forgetGoneChannels(lookup, state, nothingLive, "Memory chat", log)).forgotten,
    [GONE_CHANNEL, OTHER_GONE],
  );
  assert.deepEqual(state.channels(), [CHANNEL]);
});

test("clean forgets gone channels then prunes what is left", async () => {
  const lookup = channelsInChat({ [GONE_CHANNEL]: "gone" });
  const asked: string[] = [];

  function alive(folder: string): Set<string> {
    asked.push(folder);
    return new Set(); // the session is gone from the folder
  }

  await clean(lookup, state, {
    threadLookup: threadsInChat({}),
    alive,
    live: nothingLive,
    chat: "Memory chat",
    openedAt: opened,
    logger: log,
  });
  assert.deepEqual(state.channels(), [CHANNEL]);
  assert.equal(state.thread(CHANNEL, THREAD), null); // pruned: its session no longer exists
  // the forgotten channel's folder is not read
  assert.deepEqual(asked, [state.channel(CHANNEL)?.directory]);
  assert.ok(log.lines.join("\n").includes("pruned 1 stale thread"));
});

test("clean keeps a thread with a live session", async () => {
  const live: ThreadRef[] = [{ channel: CHANNEL, thread: THREAD }];
  await clean(channelsInChat({}), state, {
    threadLookup: threadsInChat({}),
    alive: () => new Set(),
    live: () => live,
    chat: "Memory chat",
    openedAt: opened,
    logger: log,
  });
  assert.notEqual(state.thread(CHANNEL, THREAD), null);
});

test("a thread opened while the folders are read is kept", async () => {
  // The sessions are listed off the event loop: what is opened meanwhile, in a folder the
  // listing did not cover, cannot be told gone.
  const late = "thread-late";

  async function alive(): Promise<Set<string>> {
    state.bind("chan-late", join(directory, "late"));
    state.openThread("chan-late", late, "a-session-no-listing-saw");
    await Promise.resolve();
    return new Set([SESSION]);
  }

  await clean(channelsInChat({}), state, {
    threadLookup: threadsInChat({}),
    alive,
    live: nothingLive,
    chat: "Memory chat",
    openedAt: opened,
    logger: log,
  });
  assert.notEqual(state.thread("chan-late", late), null);
});

test("clean goes on to prune when the channel check itself fails", async () => {
  // The check fails the way it can: `live`, read once the channel is found gone, raises on that
  // first read.
  const lookup = channelsInChat({ [GONE_CHANNEL]: "gone" });
  let reads = 0;

  function live(): readonly ThreadRef[] {
    reads += 1;
    if (reads === 1) throw new Error("unexpected");
    return NOBODY;
  }

  await clean(lookup, state, {
    threadLookup: threadsInChat({}),
    alive: () => new Set(),
    live,
    chat: "Memory chat",
    openedAt: opened,
    logger: log,
  });
  assert.ok(log.lines.join("\n").includes("could not check the bound channels"));
  assert.equal(state.thread(CHANNEL, THREAD), null); // the prune still ran
});

test("clean survives a folder that cannot be read and a chat that fails", async () => {
  const lookup = channelsInChat({}, new Error("network down"));

  function broken(): never {
    throw Object.assign(new Error("transcripts unreadable"), { code: "EACCES" });
  }

  await clean(lookup, state, {
    threadLookup: threadsInChat({}),
    alive: broken,
    live: nothingLive,
    chat: "Memory chat",
    openedAt: opened,
    logger: log,
  }); // never throws
  assert.deepEqual(state.channels(), [CHANNEL, GONE_CHANNEL]);
  assert.notEqual(state.thread(CHANNEL, THREAD), null);
  assert.ok(log.lines.join("\n").includes("could not prune stale threads"));
});

test("a lookup that throws is no answer", async () => {
  const answers: Record<string, Presence> = { [CHANNEL]: "there", [GONE_CHANNEL]: "gone" };
  const lookup: ChannelLookup = async (channelId) => {
    if (channelId === OTHER_GONE) throw new Error("boom");
    return answers[channelId] ?? "no answer";
  };
  state.bind(OTHER_GONE, "/srv/elsewhere");
  assert.deepEqual(
    (await forgetGoneChannels(lookup, state, nothingLive, "Memory chat", log)).forgotten,
    [GONE_CHANNEL],
  );
  assert.deepEqual(state.channels(), [CHANNEL, OTHER_GONE]);
  assert.ok(log.lines.join("\n").includes(`could not read channel ${OTHER_GONE}`));
});

test("a thread with no session is dropped for its age only when the chat dates it", async () => {
  // The chat's names mean nothing to the core: a thread it cannot date is never dropped for age.
  const undated = "not-a-time";
  state.openThread(CHANNEL, undated);
  state.openThread(CHANNEL, GONE_THREAD);
  const later = (OPENED_AT[GONE_THREAD] as number) + 2 * 24 * 60 * 60;
  const dated = (ref: ThreadRef): number | null => (ref.thread === undated ? null : opened(ref));

  await clean(channelsInChat({}), state, {
    threadLookup: threadsInChat({}),
    alive: () => new Set([SESSION]),
    live: nothingLive,
    chat: "Memory chat",
    openedAt: dated,
    now: () => later,
    logger: log,
  });
  assert.equal(state.thread(CHANNEL, GONE_THREAD), null); // dated and older than a day
  assert.notEqual(state.thread(CHANNEL, undated), null);
  assert.notEqual(state.thread(CHANNEL, THREAD), null); // its session is alive
  assert.ok(log.lines.join("\n").includes("pruned 1 stale thread"));
});

test("a pass over sessions the agent cannot list prunes nothing", async () => {
  // An agent that could not list a folder's sessions (null) says nothing of them: the thread's
  // session may be on disk all the same. The Claude back end answers null on a closed projects
  // folder (`test/agent/claude/listing.test.ts`).
  const root = realpathSync(mkdtempSync(join(tmpdir(), "awd-cleanup-")));
  made.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  const unlisted = new StateStore(join(root, "state.json"), { warn: () => undefined });
  unlisted.bind(CHANNEL, project);
  unlisted.openThread(CHANNEL, THREAD, SESSION);

  await clean(channelsInChat({}), unlisted, {
    threadLookup: threadsInChat({}),
    alive: async () => null,
    live: nothingLive,
    chat: "Memory chat",
    openedAt: opened,
    logger: log,
  });
  assert.notEqual(unlisted.thread(CHANNEL, THREAD), null);
  assert.deepEqual(log.lines, []);
});

test("forgetGoneChannels returns the channels it found as well as those it forgot", async () => {
  const lookup = channelsInChat({ [GONE_CHANNEL]: "gone" });
  assert.deepEqual(await forgetGoneChannels(lookup, state, nothingLive, "Memory chat", log), {
    forgotten: [GONE_CHANNEL],
    found: [CHANNEL],
  });
  const none = channelsInChat({ [GONE_CHANNEL]: "no answer" });
  assert.deepEqual((await forgetGoneChannels(none, state, nothingLive, "Memory chat", log)).found, [
    CHANNEL,
  ]);
});

test("a thread whose first message the chat no longer has is forgotten", async () => {
  state.openThread(CHANNEL, GONE_ROOT, SECOND_SESSION);
  const lookup = threadsInChat({ [GONE_ROOT]: "gone" });
  const forgotten = await forgetGoneThreads(lookup, state, found, nothingLive, "Memory chat", log);
  assert.deepEqual(forgotten, [{ channel: CHANNEL, thread: GONE_ROOT }]);
  assert.equal(state.thread(CHANNEL, GONE_ROOT), null);
  assert.notEqual(state.thread(CHANNEL, THREAD), null);
  const text = log.lines.join("\n");
  assert.ok(text.includes(GONE_ROOT) && text.includes(CHANNEL));
  // Its session is listed again by !resume: no thread holds it any more.
  assert.equal(state.holder(SECOND_SESSION), null);
  assert.notEqual(state.holder(SESSION), null);
});

test("a thread the chat gave no answer about is kept, and the log names the error", async () => {
  state.openThread(CHANNEL, GONE_ROOT, SECOND_SESSION);
  const failing = new Error("boom");
  failing.name = "ratelimited";
  for (const reply of ["no answer", failing] as const) {
    const lookup = threadsInChat({ [GONE_ROOT]: reply });
    assert.deepEqual(
      await forgetGoneThreads(lookup, state, found, nothingLive, "Memory chat", log),
      [],
    );
    assert.notEqual(state.thread(CHANNEL, GONE_ROOT), null);
  }
  const text = log.lines.join("\n");
  assert.ok(text.includes(`could not read thread ${GONE_ROOT} of ${CHANNEL}: ratelimited`));
  assert.ok(text.includes(`could not read thread ${GONE_ROOT} of ${CHANNEL}: no answer`));
});

test("after a thread the chat gave no answer about, its channel is asked no more", async () => {
  // What stops one answer (a rate limit, a history the bot may not read) stops the others.
  state.openThread(CHANNEL, GONE_ROOT, SECOND_SESSION);
  const asked: ThreadRef[] = [];
  const lookup = threadsInChat({ [THREAD]: "no answer", [GONE_ROOT]: "no answer" }, asked);
  await forgetGoneThreads(lookup, state, found, nothingLive, "Memory chat", log);
  assert.equal(asked.length, 1);
  assert.equal(log.lines.filter((line) => line.includes("could not read thread")).length, 1);
});

test("a stop that has begun asks about no further thread", async () => {
  state.openThread(CHANNEL, GONE_ROOT, SECOND_SESSION);
  const asked: ThreadRef[] = [];
  const lookup = threadsInChat({ [THREAD]: "gone", [GONE_ROOT]: "gone" }, asked);
  const stopping = (): boolean => asked.length >= 1;
  await forgetGoneThreads(lookup, state, found, nothingLive, "Memory chat", log, stopping);
  assert.equal(asked.length, 1);
});

test("only the threads of the channels found are asked about", async () => {
  const asked: ThreadRef[] = [];
  const lookup = threadsInChat({}, asked);
  await forgetGoneThreads(lookup, state, found, nothingLive, "Memory chat", log);
  assert.deepEqual(asked, [{ channel: CHANNEL, thread: THREAD }]);
});

test("a thread with a live session is left for the next pass", async () => {
  const lookup = threadsInChat({ [THREAD]: "gone" });
  const live: ThreadRef[] = [{ channel: CHANNEL, thread: THREAD }];
  assert.deepEqual(
    await forgetGoneThreads(lookup, state, found, () => live, "Memory chat", log),
    [],
  );
  assert.notEqual(state.thread(CHANNEL, THREAD), null);
});

test("a session that went live while the chat was asked keeps its thread", async () => {
  const live: ThreadRef[] = [];
  const lookup: ThreadLookup = async () => {
    live.push({ channel: CHANNEL, thread: THREAD });
    return "gone";
  };
  assert.deepEqual(
    await forgetGoneThreads(lookup, state, found, () => live, "Memory chat", log),
    [],
  );
  assert.notEqual(state.thread(CHANNEL, THREAD), null);
});

test("clean asks about no thread of a channel that gave no answer or was forgotten", async () => {
  const asked: ThreadRef[] = [];
  state.bind(OTHER_GONE, "/srv/elsewhere");
  state.openThread(OTHER_GONE, GONE_ROOT, SECOND_SESSION);
  const channels = channelsInChat({
    [GONE_CHANNEL]: "gone",
    [OTHER_GONE]: "no answer",
  });
  await clean(channels, state, {
    threadLookup: threadsInChat({ [THREAD]: "gone" }, asked),
    alive: () => new Set([SESSION, SECOND_SESSION]),
    live: nothingLive,
    chat: "Memory chat",
    openedAt: () => null,
    logger: log,
  });
  assert.deepEqual(asked, [{ channel: CHANNEL, thread: THREAD }]);
  assert.equal(state.thread(CHANNEL, THREAD), null);
  assert.notEqual(state.thread(OTHER_GONE, GONE_ROOT), null);
  assert.equal(state.thread(GONE_CHANNEL, GONE_THREAD), null);
});

test("clean asks about no thread when no channel was found", async () => {
  const asked: ThreadRef[] = [];
  await clean(channelsInChat({}, "gone"), state, {
    threadLookup: threadsInChat({}, asked),
    alive: () => new Set([SESSION]),
    live: nothingLive,
    chat: "Memory chat",
    openedAt: () => null,
    logger: log,
  });
  assert.deepEqual(asked, []);
  assert.notEqual(state.thread(CHANNEL, THREAD), null);
});

/** A pass a test holds open: each call waits for the next `release`. */
function heldPasses(): { run: () => Promise<void>; started: () => number; release: () => void } {
  let started = 0;
  let gate = new AsyncEvent();
  return {
    run: async () => {
      started += 1;
      await gate.wait();
    },
    started: () => started,
    release: () => {
      const open = gate;
      gate = new AsyncEvent();
      open.set();
    },
  };
}

/** Lets the promise callbacks queued so far run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("Cleanups runs a pass for a request and answers when it ended", async () => {
  let passes = 0;
  const cleanups = new Cleanups(
    async () => {
      passes += 1;
    },
    () => false,
  );
  await cleanups.request();
  assert.equal(passes, 1);
  await cleanups.request();
  assert.equal(passes, 2);
});

test("Cleanups never runs two passes at once, and requests during one share one more", async () => {
  const held = heldPasses();
  const cleanups = new Cleanups(held.run, () => false);
  const first = cleanups.request();
  await settle();
  assert.equal(held.started(), 1);
  // Three more requests while the first runs: one pass follows, not three.
  const later = [cleanups.request(), cleanups.request(), cleanups.request()];
  await settle();
  assert.equal(held.started(), 1, "the second pass waits for the first");
  held.release();
  await first;
  await settle();
  assert.equal(held.started(), 2);
  held.release();
  await Promise.all(later);
  assert.equal(held.started(), 2);
  // The queue is empty again: the next request is a pass of its own.
  const next = cleanups.request();
  await settle();
  assert.equal(held.started(), 3);
  held.release();
  await next;
});

test("Cleanups runs no pass once a stop has begun, and not the one queued behind a pass", async () => {
  const held = heldPasses();
  let stopping = false;
  const cleanups = new Cleanups(held.run, () => stopping);
  const first = cleanups.request();
  const queued = cleanups.request();
  await settle();
  stopping = true;
  held.release();
  await Promise.all([first, queued]);
  assert.equal(held.started(), 1);
  await cleanups.request();
  assert.equal(held.started(), 1);
});

test("Cleanups survives a pass that throws", async () => {
  let passes = 0;
  const cleanups = new Cleanups(
    async () => {
      passes += 1;
      throw new Error("boom");
    },
    () => false,
    log,
  );
  await cleanups.request();
  await cleanups.request();
  assert.equal(passes, 2);
});

test("Cleanups never overlaps two passes, even when a caller asks again as its pass ends", async () => {
  let running = 0;
  let most = 0;
  const gates: Array<() => void> = [];
  const cleanups = new Cleanups(
    async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise<void>((resolve) => gates.push(resolve));
      running -= 1;
    },
    () => false,
  );
  const first = cleanups.request();
  // The first caller asks again from the continuation of its own pass; another joins the queue.
  const chained = first.then(() => cleanups.request());
  const queued = cleanups.request();
  await settle();
  gates.shift()?.();
  await settle();
  await settle();
  const overlapped = most;
  while (gates.length > 0) {
    gates.shift()?.();
    await settle();
  }
  await Promise.all([chained, queued]);
  assert.equal(overlapped, 1);
  assert.equal(most, 1);
});

test("Cleanups.settled waits for the running pass and the one queued behind it", async () => {
  const held = heldPasses();
  const cleanups = new Cleanups(held.run, () => false);
  await cleanups.settled(); // nothing runs: at once
  void cleanups.request();
  void cleanups.request();
  await settle();
  let done = false;
  void cleanups.settled().then(() => {
    done = true;
  });
  held.release();
  await settle();
  assert.equal(done, false, "the queued pass has not ended");
  held.release();
  await settle();
  await settle();
  assert.equal(done, true);
  assert.equal(held.started(), 2);
});

test("a pass caught by a stop asks about no further channel, forgets none and prunes nothing", async () => {
  state.bind("chan-more", join(directory, "more"));
  const asked: string[] = [];
  let stopping = false;
  const lookup: ChannelLookup = async (channelId) => {
    asked.push(channelId);
    stopping = true; // the stop begins during the first answer
    return channelId === GONE_CHANNEL ? "gone" : "there";
  };
  const pruned = (): number => state.threads().length;
  const threads = pruned();
  await clean(lookup, state, {
    threadLookup: threadsInChat({}, []),
    // A folder that lists no session would prune every thread that holds one.
    alive: () => new Set<string>(),
    live: nothingLive,
    chat: "Memory chat",
    openedAt: () => null,
    stopping: () => stopping,
    logger: log,
  });
  assert.equal(asked.length, 1);
  assert.notEqual(state.channel(GONE_CHANNEL), null);
  assert.equal(pruned(), threads);
});
