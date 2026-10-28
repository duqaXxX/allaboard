import assert from "node:assert/strict";
import fs, {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ThreadRef } from "../../src/chat/seam.ts";
import {
  channelRecord,
  parseThread,
  StateError,
  StateStore,
  threadState,
  UnknownChannel,
} from "../../src/core/state.ts";

const POSIX_ONLY = {
  skip: process.platform === "win32" && "file modes and a directory's sync are POSIX",
};

const CHANNEL = "C000CHAN";
const OTHER_CHANNEL = "C000OTHR";
const THREAD_TS = "1790549806.565369";
const OTHER_THREAD_TS = "1790549900.100000";
const SESSION = "4e8c1111-2222-3333-4444-555566667777";

/** A thread's name read as its opening time in epoch seconds, as a chat whose names are times does. */
const opened = (ref: ThreadRef): number | null => Number(ref.thread);

const made: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "awd-state-"));
  made.push(directory);
  return directory;
}

after(() => {
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

/** The file as a parsed object, and the one thread the helpers below look at. */
interface StateFile {
  version: number;
  channels: Record<string, { threads: Record<string, Record<string, unknown>> }>;
}

function read(path: string): StateFile {
  return JSON.parse(readFileSync(path, "utf8")) as StateFile;
}

function written(path: string): Record<string, unknown> {
  const thread = read(path).channels[CHANNEL]?.threads[THREAD_TS];
  assert.ok(thread !== undefined);
  return thread;
}

/** The thread, which the test has just created. */
function mustThread(store: StateStore, channelId = CHANNEL, threadTs = THREAD_TS) {
  const thread = store.thread(channelId, threadTs);
  assert.ok(thread !== null);
  return thread;
}

/** A v2 file holding one thread whose keys are `thread`, in the folder `directory`. */
function writeThreadFile(path: string, directory: string, thread: Record<string, unknown>): void {
  const channel = { directory, notice_pending: false, threads: { [THREAD_TS]: thread } };
  writeFileSync(path, JSON.stringify({ version: 2, channels: { [CHANNEL]: channel } }));
}

test("a new store is empty", () => {
  assert.equal(new StateStore(join(scratch(), "state.json")).channel(CHANNEL), null);
});

test("bind creates a channel with no threads", () => {
  const dir = scratch();
  const store = new StateStore(join(dir, "state.json"));
  store.bind(CHANNEL, join(dir, "project"));
  assert.deepEqual(store.channel(CHANNEL), channelRecord(join(dir, "project")));
});

test("open thread stores the channels current folder", () => {
  const dir = scratch();
  const store = new StateStore(join(dir, "state.json"));
  store.bind(CHANNEL, join(dir, "project"));
  const thread = store.openThread(CHANNEL, THREAD_TS);
  assert.deepEqual(thread, threadState(join(dir, "project")));
  assert.deepEqual(store.thread(CHANNEL, THREAD_TS), thread);
});

test("open thread on an unbound channel raises", () => {
  const store = new StateStore(join(scratch(), "state.json"));
  assert.throws(() => store.openThread(CHANNEL, THREAD_TS), UnknownChannel);
});

test("open thread is idempotent", () => {
  const dir = scratch();
  const store = new StateStore(join(dir, "state.json"));
  store.bind(CHANNEL, join(dir, "project"));
  const first = store.openThread(CHANNEL, THREAD_TS, "ignored-on-repeat");
  const second = store.openThread(CHANNEL, THREAD_TS, "also-ignored");
  assert.deepEqual(first, second);
  assert.equal(first.sessionId, "ignored-on-repeat");
});

test("a thread keeps its folder across a rebind", () => {
  const dir = scratch();
  const store = new StateStore(join(dir, "state.json"));
  store.bind(CHANNEL, join(dir, "a"));
  store.openThread(CHANNEL, THREAD_TS);
  store.bind(CHANNEL, join(dir, "b"));
  assert.deepEqual(
    store.channel(CHANNEL),
    channelRecord(join(dir, "b"), {
      threads: new Map([[THREAD_TS, threadState(join(dir, "a"))]]),
    }),
  );
  assert.deepEqual(store.thread(CHANNEL, THREAD_TS), threadState(join(dir, "a")));
});

test("set session bypass and effort round trip", () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  const store = new StateStore(path);
  store.bind(CHANNEL, join(dir, "project"));
  store.openThread(CHANNEL, THREAD_TS);
  store.setSession(CHANNEL, THREAD_TS, SESSION);
  store.setBypass(CHANNEL, THREAD_TS, true);
  store.setEffort(CHANNEL, THREAD_TS, "high");

  const reloaded = new StateStore(path);
  assert.deepEqual(
    reloaded.thread(CHANNEL, THREAD_TS),
    threadState(join(dir, "project"), { sessionId: SESSION, bypass: true, effort: "high" }),
  );
});

test("set session bypass and effort are a no op for an unknown thread", () => {
  const dir = scratch();
  const store = new StateStore(join(dir, "state.json"));
  store.bind(CHANNEL, dir);
  store.setSession(CHANNEL, THREAD_TS, SESSION);
  store.setBypass(CHANNEL, THREAD_TS, true);
  store.setEffort(CHANNEL, THREAD_TS, "high");
  assert.equal(store.thread(CHANNEL, THREAD_TS), null);
});

test("set session does not rewrite when unchanged", () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  const store = new StateStore(path);
  store.bind(CHANNEL, dir);
  store.openThread(CHANNEL, THREAD_TS);
  store.setSession(CHANNEL, THREAD_TS, SESSION);
  const before = statSync(path, { bigint: true });
  store.setSession(CHANNEL, THREAD_TS, SESSION);
  const after = statSync(path, { bigint: true });
  assert.equal(after.mtimeNs, before.mtimeNs);
  // A rewrite renames a new file over the old one, so it would also change the inode.
  assert.equal(after.ino, before.ino);
});

test("remove thread", () => {
  const dir = scratch();
  const store = new StateStore(join(dir, "state.json"));
  store.bind(CHANNEL, dir);
  store.openThread(CHANNEL, THREAD_TS);
  store.removeThread(CHANNEL, THREAD_TS);
  assert.equal(store.thread(CHANNEL, THREAD_TS), null);
  // Removing again, or removing from an unbound channel, is a no-op.
  store.removeThread(CHANNEL, THREAD_TS);
  store.removeThread(OTHER_CHANNEL, THREAD_TS);
});

test("holder finds a session across channels", () => {
  const dir = scratch();
  const store = new StateStore(join(dir, "state.json"));
  store.bind(CHANNEL, join(dir, "a"));
  store.bind(OTHER_CHANNEL, join(dir, "b"));
  store.openThread(CHANNEL, THREAD_TS);
  store.openThread(OTHER_CHANNEL, OTHER_THREAD_TS);
  store.setSession(OTHER_CHANNEL, OTHER_THREAD_TS, SESSION);
  assert.deepEqual(store.holder(SESSION), { channel: OTHER_CHANNEL, thread: OTHER_THREAD_TS });
  assert.equal(store.holder("no-such-session"), null);
});

for (const [label, value] of [
  ['"true"', "true"],
  ['"false"', "false"],
  ["1", 1],
  ["null", null],
  ["false", false],
] as const) {
  test(`only a literal true turns bypass on and the rest is unset [${label}]`, () => {
    const dir = scratch();
    const path = join(dir, "state.json");
    writeThreadFile(path, dir, { directory: dir, session_id: null, bypass: value, effort: null });
    assert.deepEqual(
      new StateStore(path).thread(CHANNEL, THREAD_TS),
      threadState(dir, { bypass: null }),
    );
  });
}

test("v2 round trips every field", () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  const store = new StateStore(path);
  store.bind(CHANNEL, join(dir, "project"));
  store.openThread(CHANNEL, THREAD_TS);
  store.setSession(CHANNEL, THREAD_TS, SESSION);
  store.setBypass(CHANNEL, THREAD_TS, true);
  store.setEffort(CHANNEL, THREAD_TS, "low");

  assert.deepEqual(read(path), {
    version: 2,
    channels: {
      [CHANNEL]: {
        directory: join(dir, "project"),
        notice_pending: false,
        threads: {
          [THREAD_TS]: {
            directory: join(dir, "project"),
            session_id: SESSION,
            bypass: true,
            effort: "low",
            open_replies: [],
            requests: [],
            request_kinds: {},
            status: null,
            ended: null,
            root_prompt: null,
          },
        },
      },
    },
  });
});

test("a v1 file migrates folder kept session and bypass dropped", () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  const v1 = {
    version: 1,
    channels: {
      [CHANNEL]: { directory: join(dir, "project"), session_id: "old", bypass: true },
    },
  };
  writeFileSync(path, JSON.stringify(v1));

  const store = new StateStore(path);
  assert.deepEqual(
    store.channel(CHANNEL),
    channelRecord(join(dir, "project"), { noticePending: true }),
  );
  assert.deepEqual(store.pendingNotices(), [CHANNEL]);

  // The migration is written back at once, as v2.
  assert.deepEqual(read(path), {
    version: 2,
    channels: {
      [CHANNEL]: { directory: join(dir, "project"), notice_pending: true, threads: {} },
    },
  });
});

test("clear notice", () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      channels: { [CHANNEL]: { directory: dir, session_id: null } },
    }),
  );
  const store = new StateStore(path);
  assert.deepEqual(store.pendingNotices(), [CHANNEL]);
  store.clearNotice(CHANNEL);
  assert.deepEqual(store.pendingNotices(), []);
  // A no-op for an unbound channel or one already clear.
  store.clearNotice(OTHER_CHANNEL);
  store.clearNotice(CHANNEL);
});

test("an unknown version is refused", () => {
  const path = join(scratch(), "state.json");
  writeFileSync(path, JSON.stringify({ version: 4, channels: {} }));
  assert.throws(
    () => new StateStore(path),
    (error: unknown) => error instanceof StateError && /state\.json/.test(error.message),
  );
});

// Version 3 is version 2 plus the names of the agent and the chat that wrote the file.

const MODULES = { agent: "agent-a", chat: "chat-a" };

/** A version 2 file with one bound channel, and the keys it holds at the top. */
function writeV2(path: string, directory: string): void {
  writeFileSync(
    path,
    JSON.stringify({ version: 2, channels: { [CHANNEL]: { directory, notice_pending: false } } }),
  );
}

test("a v2 file is read for the modules running and written as v3 on the first save", () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  writeV2(path, dir);
  const before = readFileSync(path, "utf8");

  const store = new StateStore(path, { modules: MODULES });
  assert.equal(store.channel(CHANNEL)?.directory, dir);
  assert.equal(readFileSync(path, "utf8"), before); // reading writes nothing
  store.openThread(CHANNEL, THREAD_TS);
  assert.deepEqual(Object.keys(read(path)), ["version", "agent", "chat", "channels"]);
  assert.deepEqual(
    { ...read(path), channels: undefined },
    { version: 3, agent: "agent-a", chat: "chat-a", channels: undefined },
  );
  // And it is read back by the same modules.
  assert.notEqual(new StateStore(path, { modules: MODULES }).thread(CHANNEL, THREAD_TS), null);
});

test("a v3 file written for other modules stops the start naming both pairs", () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  new StateStore(path, { modules: MODULES }).bind(CHANNEL, dir);
  const before = readFileSync(path, "utf8");

  for (const other of [
    { agent: "agent-b", chat: "chat-a" },
    { agent: "agent-a", chat: "chat-b" },
  ]) {
    assert.throws(
      () => new StateStore(path, { modules: other }),
      (error: unknown) =>
        error instanceof StateError &&
        error.message.includes("belongs to other modules") &&
        error.message.includes(`agent "agent-a"`) &&
        error.message.includes(`chat "chat-a"`) &&
        error.message.includes(`agent "${other.agent}"`) &&
        error.message.includes(`chat "${other.chat}"`),
    );
  }
  assert.equal(readFileSync(path, "utf8"), before);
});

test("a v3 file whose names are missing or not text cannot be read", () => {
  const path = join(scratch(), "state.json");
  for (const names of [{}, { agent: "agent-a" }, { agent: 1, chat: "chat-a" }]) {
    writeFileSync(path, JSON.stringify({ version: 3, ...names, channels: {} }));
    assert.throws(
      () => new StateStore(path, { modules: MODULES }),
      (error: unknown) => error instanceof StateError && /cannot be read/.test(error.message),
    );
  }
});

test("a store given no names writes no names it was not given and keeps those it read", () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  writeV2(path, dir);
  const plain = new StateStore(path);
  plain.openThread(CHANNEL, THREAD_TS);
  assert.deepEqual(Object.keys(read(path)), ["version", "channels"]);
  assert.equal(read(path).version, 2);

  new StateStore(path, { modules: MODULES }).openThread(CHANNEL, OTHER_THREAD_TS);
  const open = new StateStore(path); // checks nothing
  open.setSession(CHANNEL, THREAD_TS, SESSION);
  assert.deepEqual(Object.keys(read(path)), ["version", "agent", "chat", "channels"]);
  assert.equal(read(path).version, 3);
});

test("a v1 file is migrated to v3 when the store is given names", () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  writeFileSync(path, JSON.stringify({ version: 1, channels: { [CHANNEL]: { directory: dir } } }));
  new StateStore(path, { modules: MODULES });
  assert.deepEqual(Object.keys(read(path)), ["version", "agent", "chat", "channels"]);
  assert.equal(read(path).version, 3);
});

test("a corrupt file is refused not discarded", () => {
  const path = join(scratch(), "state.json");
  writeFileSync(path, "{not json");
  assert.throws(
    () => new StateStore(path),
    (error: unknown) => error instanceof StateError && /state\.json/.test(error.message),
  );
  assert.equal(readFileSync(path, "utf8"), "{not json");
});

test("a missing file is empty", () => {
  assert.equal(new StateStore(join(scratch(), "state.json")).channel(CHANNEL), null);
});

test("file is private and nothing else is left behind", POSIX_ONLY, () => {
  const dir = scratch();
  const store = new StateStore(join(dir, "state.json"));
  store.bind(CHANNEL, dir);
  assert.deepEqual(readdirSync(dir).sort(), ["state.json"]);
  assert.equal(statSync(join(dir, "state.json")).mode & 0o777, 0o600);
});

test("a failed write keeps the previous file", (t) => {
  const dir = scratch();
  const path = join(dir, "state.json");
  const store = new StateStore(path);
  store.bind(CHANNEL, join(dir, "a"));
  const before = readFileSync(path, "utf8");

  // The rename (Python's `os.replace`) is the step that makes a write take effect: the test
  // fails it.
  t.mock.method(fs, "renameSync", () => {
    throw new Error("disk full");
  });
  assert.throws(() => store.bind(CHANNEL, join(dir, "b")), /disk full/);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.deepEqual(readdirSync(dir).sort(), ["state.json"]);
});

test("a write syncs the file before the rename and the directory after it", POSIX_ONLY, (t) => {
  const dir = scratch();
  const steps: string[] = [];
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: string, to: string) => {
    steps.push("rename");
    rename(from, to);
  });
  const store = new StateStore(join(dir, "state.json"), {
    sync: (fd) => {
      steps.push(fs.fstatSync(fd).isDirectory() ? "directory" : "file");
      fs.fsyncSync(fd);
    },
  });
  store.bind(CHANNEL, join(dir, "a"));
  assert.deepEqual(steps, ["file", "rename", "directory"]);
});

test("a store given no sync flushes with the system's own", POSIX_ONLY, (t) => {
  const dir = scratch();
  const flush = t.mock.method(fs, "fsyncSync");
  const store = new StateStore(join(dir, "state.json"));
  store.bind(CHANNEL, join(dir, "a"));
  assert.equal(flush.mock.callCount(), 2);
});

// TestPrune: `prune` calls `alive` once per distinct folder and reports how many entries it removed.

test("removes a thread whose session is gone", () => {
  const dir = scratch();
  const store = new StateStore(join(dir, "state.json"));
  store.bind(CHANNEL, join(dir, "project"));
  store.openThread(CHANNEL, THREAD_TS);
  store.setSession(CHANNEL, THREAD_TS, SESSION);

  const removed = store.prune(() => [], opened, 1790549806.565369);
  assert.equal(removed, 1);
  assert.equal(store.thread(CHANNEL, THREAD_TS), null);
});

test("keeps a thread whose session is alive", () => {
  const dir = scratch();
  const store = new StateStore(join(dir, "state.json"));
  store.bind(CHANNEL, join(dir, "project"));
  store.openThread(CHANNEL, THREAD_TS);
  store.setSession(CHANNEL, THREAD_TS, SESSION);

  const removed = store.prune(() => [SESSION], opened, 1790549806.565369);
  assert.equal(removed, 0);
  assert.notEqual(store.thread(CHANNEL, THREAD_TS), null);
});

test("removes a no session thread older than a day", () => {
  const dir = scratch();
  const store = new StateStore(join(dir, "state.json"));
  store.bind(CHANNEL, join(dir, "project"));
  store.openThread(CHANNEL, THREAD_TS);

  const rootTime = Number(THREAD_TS);
  const removed = store.prune(() => [], opened, rootTime + 86_401);
  assert.equal(removed, 1);
  assert.equal(store.thread(CHANNEL, THREAD_TS), null);
});

test("keeps a young no session thread", () => {
  const dir = scratch();
  const store = new StateStore(join(dir, "state.json"));
  store.bind(CHANNEL, join(dir, "project"));
  store.openThread(CHANNEL, THREAD_TS);

  const rootTime = Number(THREAD_TS);
  const removed = store.prune(() => [], opened, rootTime + 3_600);
  assert.equal(removed, 0);
  assert.notEqual(store.thread(CHANNEL, THREAD_TS), null);
});

test("calls alive once per distinct folder", () => {
  const calls: string[] = [];
  const alive = (directory: string): string[] => {
    calls.push(directory);
    return [SESSION];
  };

  const dir = scratch();
  const store = new StateStore(join(dir, "state.json"));
  store.bind(CHANNEL, join(dir, "project"));
  store.openThread(CHANNEL, THREAD_TS);
  store.setSession(CHANNEL, THREAD_TS, SESSION);
  store.openThread(CHANNEL, OTHER_THREAD_TS);
  store.setSession(CHANNEL, OTHER_THREAD_TS, SESSION);

  const removed = store.prune(alive, opened, 1790549806.565369);
  assert.equal(removed, 0);
  assert.deepEqual(calls, [join(dir, "project")]);
});

test("alive raising leaves the file untouched", () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  const store = new StateStore(path);
  store.bind(CHANNEL, join(dir, "project"));
  store.openThread(CHANNEL, THREAD_TS);
  store.setSession(CHANNEL, THREAD_TS, SESSION);
  const before = readFileSync(path, "utf8");

  const boom = (): string[] => {
    throw new Error("folder is gone");
  };

  assert.throws(() => store.prune(boom, opened, 1790549806.565369), /folder is gone/);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.notEqual(store.thread(CHANNEL, THREAD_TS), null);
});

test("a v2 file with no repair fields loads with them empty", () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  writeThreadFile(path, join(dir, "project"), {
    directory: join(dir, "project"),
    session_id: SESSION,
    bypass: false,
    effort: null,
  });
  const thread = new StateStore(path).thread(CHANNEL, THREAD_TS);
  assert.deepEqual(thread, threadState(join(dir, "project"), { sessionId: SESSION }));
  assert.ok(thread !== null);
  assert.deepEqual(thread.openReplies, []);
  assert.deepEqual(thread.requests, []);
  assert.equal(thread.status, null);
});

test("a file with 1304c5e s single open reply field loads as nothing open", () => {
  // That field never shipped past the fix round: a file written by it is read exactly like one
  // written before crash repair existed at all.
  const dir = scratch();
  const path = join(dir, "state.json");
  writeThreadFile(path, join(dir, "project"), {
    directory: join(dir, "project"),
    session_id: null,
    bypass: false,
    effort: null,
    open_reply: "1790000000.000001",
  });
  const thread = new StateStore(path).thread(CHANNEL, THREAD_TS);
  assert.ok(thread !== null);
  assert.deepEqual(thread.openReplies, []);
});

test("repair fields round trip and are ignored by code that predates them", () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  const store = new StateStore(path);
  store.bind(CHANNEL, join(dir, "project"));
  store.openThread(CHANNEL, THREAD_TS);
  store.replaceOpenReply(CHANNEL, THREAD_TS, null, "1790000000.000001");
  store.addRequest(CHANNEL, THREAD_TS, "1790000000.000002", "question");
  store.addRequest(CHANNEL, THREAD_TS, "1790000000.000003", "setup");
  store.setStatusPending(CHANNEL, THREAD_TS, "working");

  const reloaded = new StateStore(path).thread(CHANNEL, THREAD_TS);
  assert.deepEqual(
    reloaded,
    threadState(join(dir, "project"), {
      openReplies: ["1790000000.000001"],
      requests: ["1790000000.000002", "1790000000.000003"],
      requestKinds: { "1790000000.000002": "question", "1790000000.000003": "setup" },
      status: "working",
    }),
  );
  // Code that only knows `parseThread`'s old fields ignores the extra keys.
  const raw = written(path);
  const oldShape = {
    directory: raw.directory,
    session_id: raw.session_id,
    bypass: raw.bypass,
    effort: raw.effort,
  };
  assert.deepEqual(parseThread(oldShape), threadState(join(dir, "project")));
});

test("a request is stored with one word for its kind, and the word leaves with it", () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  const store = new StateStore(path);
  store.bind(CHANNEL, join(dir, "project"));
  store.openThread(CHANNEL, THREAD_TS);
  for (const [ts, kind] of [
    ["ts-1", "question"],
    ["ts-2", "approval"],
    ["ts-3", "setup"],
    ["ts-4", "hold"],
  ] as const) {
    store.addRequest(CHANNEL, THREAD_TS, ts, kind);
  }
  const raw = (): Record<string, unknown> => {
    const channels = read(path).channels as Record<string, { threads: Record<string, unknown> }>;
    return channels[CHANNEL]?.threads[THREAD_TS] as Record<string, unknown>;
  };
  assert.deepEqual(raw().request_kinds, {
    "ts-1": "question",
    "ts-2": "approval",
    "ts-3": "setup",
    "ts-4": "hold",
  });
  store.removeRequest(CHANNEL, THREAD_TS, "ts-2");
  assert.deepEqual(Object.keys(raw().request_kinds as object), ["ts-1", "ts-3", "ts-4"]);
  store.clearRepair(CHANNEL, THREAD_TS);
  assert.deepEqual(raw().request_kinds, {});
});

test("a file from before the kinds loads its requests with no kind and keeps them", () => {
  // Written by the daemon of 663fdf4 and before: `requests` alone. No kind is read as one the
  // repair deletes, and an unknown word or a kind for an id not in `requests` is dropped.
  const dir = scratch();
  const path = join(dir, "state.json");
  writeThreadFile(path, dir, {
    directory: dir,
    session_id: null,
    requests: ["old-1", "old-2"],
  });
  const store = new StateStore(path);
  assert.deepEqual(mustThread(store).requests, ["old-1", "old-2"]);
  assert.deepEqual(mustThread(store).requestKinds, {});
  store.addRequest(CHANNEL, THREAD_TS, "new-1", "approval");
  assert.deepEqual(mustThread(store).requestKinds, { "new-1": "approval" });

  const odd = parseThread({
    directory: dir,
    requests: ["a", "b"],
    request_kinds: { a: "question", b: "poll", c: "hold" },
  });
  assert.deepEqual(odd.requestKinds, { a: "question" });
});

test("replace open reply tracks two sinks independently", () => {
  // The bug the fix round measured: two replies open at once (a background task's own reply
  // outliving the turn that started it) must never step on each other's entry.
  const dir = scratch();
  const store = new StateStore(join(dir, "state.json"));
  store.bind(CHANNEL, dir);
  store.openThread(CHANNEL, THREAD_TS);
  store.replaceOpenReply(CHANNEL, THREAD_TS, null, "a-1"); // sink A's first message
  store.replaceOpenReply(CHANNEL, THREAD_TS, null, "b-1"); // sink B's first message
  assert.deepEqual(mustThread(store).requests, []); // sanity: unrelated field
  assert.deepEqual([...mustThread(store).openReplies].sort(), ["a-1", "b-1"]);
  store.replaceOpenReply(CHANNEL, THREAD_TS, "a-1", null); // sink A settles; B untouched
  assert.deepEqual(mustThread(store).openReplies, ["b-1"]);
  store.replaceOpenReply(CHANNEL, THREAD_TS, "b-1", "b-2"); // sink B's continuation
  assert.deepEqual(mustThread(store).openReplies, ["b-2"]);
  store.replaceOpenReply(CHANNEL, THREAD_TS, "b-2", null);
  assert.deepEqual(mustThread(store).openReplies, []);
});

test("replace open reply is a no op that changes nothing for an unknown thread", () => {
  const dir = scratch();
  const store = new StateStore(join(dir, "state.json"));
  store.bind(CHANNEL, dir);
  store.replaceOpenReply(CHANNEL, THREAD_TS, null, "ts-1");
  assert.equal(store.thread(CHANNEL, THREAD_TS), null);
});

test("remove request drops only the named one", () => {
  const dir = scratch();
  const store = new StateStore(join(dir, "state.json"));
  store.bind(CHANNEL, join(dir, "project"));
  store.openThread(CHANNEL, THREAD_TS);
  store.addRequest(CHANNEL, THREAD_TS, "ts-1", "question");
  store.addRequest(CHANNEL, THREAD_TS, "ts-2", "question");
  store.removeRequest(CHANNEL, THREAD_TS, "ts-1");
  const thread = mustThread(store);
  assert.deepEqual(thread.requests, ["ts-2"]);
  store.removeRequest(CHANNEL, THREAD_TS, "ts-1"); // already gone: a no-op
  assert.deepEqual(store.thread(CHANNEL, THREAD_TS), thread);
});

test("repair setters are a no op for an unknown thread", () => {
  const dir = scratch();
  const store = new StateStore(join(dir, "state.json"));
  store.bind(CHANNEL, dir);
  store.replaceOpenReply(CHANNEL, THREAD_TS, null, "ts-1");
  store.addRequest(CHANNEL, THREAD_TS, "ts-1", "question");
  store.setStatusPending(CHANNEL, THREAD_TS, "error");
  assert.equal(store.thread(CHANNEL, THREAD_TS), null);
});

test("repairs pending lists only threads with something open", () => {
  const dir = scratch();
  const store = new StateStore(join(dir, "state.json"));
  store.bind(CHANNEL, join(dir, "project"));
  store.openThread(CHANNEL, THREAD_TS);
  store.openThread(CHANNEL, OTHER_THREAD_TS);
  store.replaceOpenReply(CHANNEL, OTHER_THREAD_TS, null, "ts-1");
  assert.deepEqual(store.repairsPending(), [
    [CHANNEL, OTHER_THREAD_TS, mustThread(store, CHANNEL, OTHER_THREAD_TS)],
  ]);
});

test("clear repair fields clears all three and is a no op after", () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  const store = new StateStore(path);
  store.bind(CHANNEL, join(dir, "project"));
  store.openThread(CHANNEL, THREAD_TS);
  store.replaceOpenReply(CHANNEL, THREAD_TS, null, "ts-1");
  store.addRequest(CHANNEL, THREAD_TS, "ts-2", "question");
  store.setStatusPending(CHANNEL, THREAD_TS, "error");
  store.clearRepair(CHANNEL, THREAD_TS);
  assert.deepEqual(store.thread(CHANNEL, THREAD_TS), threadState(join(dir, "project")));
  assert.deepEqual(
    new StateStore(path).thread(CHANNEL, THREAD_TS),
    threadState(join(dir, "project")),
  );
  const before = statSync(path, { bigint: true });
  store.clearRepair(CHANNEL, THREAD_TS); // already clear: a no-op, no extra write
  store.clearRepair("unknown-channel", THREAD_TS); // unknown thread: a no-op too
  assert.equal(statSync(path, { bigint: true }).ino, before.ino);
});

test("clear repair keeps what an unlanded answer still needs", () => {
  // An answer that never reached Slack leaves its open stream and the root's status for the
  // next start's repair; the requests, which a close deletes itself, are cleared.
  const dir = scratch();
  const path = join(dir, "state.json");
  const store = new StateStore(path);
  store.bind(CHANNEL, join(dir, "project"));
  store.openThread(CHANNEL, THREAD_TS);
  store.replaceOpenReply(CHANNEL, THREAD_TS, null, "ts-1");
  store.addRequest(CHANNEL, THREAD_TS, "ts-2", "question");
  store.setStatusPending(CHANNEL, THREAD_TS, "error");
  store.clearRepair(CHANNEL, THREAD_TS, { keepOpen: true });
  const kept = new StateStore(path).thread(CHANNEL, THREAD_TS);
  assert.deepEqual(
    kept,
    threadState(join(dir, "project"), { openReplies: ["ts-1"], status: "error" }),
  );
});

test("prune keeps every thread of a folder it cannot decide", () => {
  // `alive` returns null when it cannot tell which sessions a folder holds: pruning errs on
  // keeping, so none of that folder's threads is removed.
  const dir = scratch();
  const store = new StateStore(join(dir, "state.json"));
  store.bind("C000CHAN", join(dir, "undecided"));
  store.openThread("C000CHAN", "1700000000.000100", "kept-1");
  store.bind("C000CHAN", join(dir, "decided"));
  store.openThread("C000CHAN", "1700000000.000200", "gone-1");

  const alive = (directory: string): Set<string> | null =>
    directory.endsWith("undecided") ? null : new Set();

  assert.equal(store.prune(alive, opened, 1700000000.0), 1);
  assert.notEqual(store.thread("C000CHAN", "1700000000.000100"), null);
  assert.equal(store.thread("C000CHAN", "1700000000.000200"), null);
});

test("an explicit off is kept apart from never chosen", () => {
  // `bypass` keeps its old meaning (`true` on, `false` not on); an explicit off (`!bypass off`
  // or an unticked Start) adds `bypass_off: true`, which must survive a restart. The two keys are
  // never both set, and clearing to unset removes `bypass_off`.
  const dir = scratch();
  const path = join(dir, "state.json");
  const store = new StateStore(path);
  store.bind(CHANNEL, join(dir, "project"));
  store.openThread(CHANNEL, THREAD_TS);
  assert.equal(mustThread(store).bypass, null);
  assert.ok(written(path).bypass === false && !("bypass_off" in written(path)));
  store.setBypass(CHANNEL, THREAD_TS, false);
  assert.equal(mustThread(new StateStore(path)).bypass, false);
  assert.ok(written(path).bypass === false && written(path).bypass_off === true);
  store.setBypass(CHANNEL, THREAD_TS, true);
  assert.equal(mustThread(new StateStore(path)).bypass, true);
  assert.ok(written(path).bypass === true && !("bypass_off" in written(path)));
  store.setBypass(CHANNEL, THREAD_TS, null);
  assert.equal(mustThread(new StateStore(path)).bypass, null);
  assert.ok(written(path).bypass === false && !("bypass_off" in written(path)));
  assert.equal(read(path).version, 2);
});

for (const [keys, expected] of [
  [{ bypass: true }, true],
  [{ bypass: false }, null], // an old file: a thread that never chose
  [{}, null],
  [{ bypass: false, bypass_off: true }, false],
  [{ bypass_off: true }, false],
] as const) {
  test(`bypass is read from the two keys [${JSON.stringify(keys)}]`, () => {
    const dir = scratch();
    const path = join(dir, "state.json");
    writeThreadFile(path, dir, { directory: dir, session_id: null, effort: null, ...keys });
    assert.equal(mustThread(new StateStore(path)).bypass, expected);
  });
}

test("a written off reads as not on through bypass alone", () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  const store = new StateStore(path);
  store.bind(CHANNEL, join(dir, "project"));
  store.openThread(CHANNEL, THREAD_TS);
  store.setBypass(CHANNEL, THREAD_TS, false);
  assert.notEqual(written(path).bypass, true);
});

test("the ended reaction round trips and a pending one replaces it", () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  const store = new StateStore(path);
  store.bind(CHANNEL, join(dir, "project"));
  store.openThread(CHANNEL, THREAD_TS);

  store.setStatusPending(CHANNEL, THREAD_TS, null, "done");
  assert.equal(written(path).status, null);
  assert.equal(written(path).ended, "done");
  assert.equal(mustThread(new StateStore(path)).ended, "done");

  store.setStatusPending(CHANNEL, THREAD_TS, "working");
  assert.equal(written(path).status, "working");
  assert.equal(written(path).ended, null);
});

test("a cross shown over a kept status keeps both", () => {
  // An answer that never reached Slack: the root shows ❌ and crash repair still owes it.
  const dir = scratch();
  const path = join(dir, "state.json");
  const store = new StateStore(path);
  store.bind(CHANNEL, join(dir, "project"));
  store.openThread(CHANNEL, THREAD_TS);
  store.setStatusPending(CHANNEL, THREAD_TS, "working", "error");
  assert.deepEqual([written(path).status, written(path).ended], ["working", "error"]);
  assert.deepEqual(
    store.repairsPending().map(([, ts]) => ts),
    [THREAD_TS],
  );
});

test("an observer that raises does not break the write", () => {
  const dir = scratch();
  const warnings: string[] = [];
  const store = new StateStore(join(dir, "state.json"), { warn: (m) => warnings.push(m) });
  store.bind(CHANNEL, join(dir, "project"));

  store.onSessionsChange = () => {
    throw new TypeError("no running event loop");
  };
  store.openThread(CHANNEL, THREAD_TS);
  assert.notEqual(store.thread(CHANNEL, THREAD_TS), null);
  assert.ok(warnings.some((message) => message.includes("TypeError")));
  assert.ok(warnings.every((message) => !message.includes("no running event loop")));
});

test("an ended reaction is nothing for crash repair to find", () => {
  const dir = scratch();
  const store = new StateStore(join(dir, "state.json"));
  store.bind(CHANNEL, join(dir, "project"));
  store.openThread(CHANNEL, THREAD_TS);
  store.setStatusPending(CHANNEL, THREAD_TS, null, "error");
  assert.deepEqual(store.repairsPending(), []);
});

test("clear repair keeps the ended reaction", () => {
  const dir = scratch();
  const store = new StateStore(join(dir, "state.json"));
  store.bind(CHANNEL, join(dir, "project"));
  store.openThread(CHANNEL, THREAD_TS);
  store.setStatusPending(CHANNEL, THREAD_TS, null, "error");
  store.addRequest(CHANNEL, THREAD_TS, "1790549807.000001", "question");
  store.clearRepair(CHANNEL, THREAD_TS);
  assert.equal(mustThread(store).ended, "error");
});

test("a file without the ended key loads with none", () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  writeThreadFile(path, dir, { directory: dir, session_id: SESSION, status: null });
  assert.equal(mustThread(new StateStore(path)).ended, null);
});

test("the root's prompt round trips, and a file without it reads as none", () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  const store = new StateStore(path);
  store.bind(CHANNEL, join(dir, "project"));
  store.openThread(CHANNEL, THREAD_TS);
  assert.equal(written(path).root_prompt, null);
  store.setRootPrompt(CHANNEL, THREAD_TS, "fix the *footer*\nplease");
  assert.equal(written(path).root_prompt, "fix the *footer*\nplease");
  assert.equal(mustThread(new StateStore(path)).rootPrompt, "fix the *footer*\nplease");
  // Never replaced: the stored text is what the root held, a later one would be the title.
  assert.equal(store.setRootPrompt(CHANNEL, THREAD_TS, "Fix the footer"), false);
  assert.equal(mustThread(new StateStore(path)).rootPrompt, "fix the *footer*\nplease");
  // An unknown thread is a no-op.
  assert.equal(store.setRootPrompt(CHANNEL, "1790000000.000000", "x"), false);
  // Cleared on purpose, and then stored again.
  store.clearRootPrompt(CHANNEL, THREAD_TS);
  assert.equal(written(path).root_prompt, null);
  assert.equal(store.setRootPrompt(CHANNEL, THREAD_TS, ""), true, "an empty text is stored too");
  assert.equal(store.setRootPrompt(CHANNEL, THREAD_TS, "x"), false);
  store.clearRootPrompt(CHANNEL, "1790000000.000000"); // unknown: a no-op
  store.clearRootPrompt(CHANNEL, THREAD_TS);
  store.setRootPrompt(CHANNEL, THREAD_TS, "fix the *footer*\nplease");
  assert.equal(store.thread(CHANNEL, "1790000000.000000"), null);
  const old = join(dir, "old.json");
  writeThreadFile(old, dir, { directory: dir, session_id: SESSION, status: null });
  assert.equal(mustThread(new StateStore(old)).rootPrompt, null);
  // Pruned with its thread, as every field of it is.
  store.removeThread(CHANNEL, THREAD_TS);
  assert.equal(store.thread(CHANNEL, THREAD_TS), null);
});

test("threads lists every thread of every channel", () => {
  const dir = scratch();
  const store = new StateStore(join(dir, "state.json"));
  store.bind(CHANNEL, join(dir, "project"));
  store.bind(OTHER_CHANNEL, join(dir, "other"));
  const first = store.openThread(CHANNEL, THREAD_TS);
  const second = store.openThread(OTHER_CHANNEL, OTHER_THREAD_TS);
  assert.deepEqual(store.threads(), [
    [CHANNEL, THREAD_TS, first],
    [OTHER_CHANNEL, OTHER_THREAD_TS, second],
  ]);
});

test("the observer hears what the session index and the line show, and nothing else", () => {
  const dir = scratch();
  const store = new StateStore(join(dir, "state.json"));
  const heard: (readonly ThreadRef[])[] = [];
  store.onSessionsChange = (changed) => heard.push(changed);

  store.bind(CHANNEL, join(dir, "project")); // a new channel is a new group on the page
  assert.deepEqual(store.channels(), [CHANNEL]);
  assert.deepEqual(heard, [[]]); // no thread of its own yet
  store.openThread(CHANNEL, THREAD_TS);
  store.openThread(CHANNEL, OTHER_THREAD_TS);
  store.setSession(CHANNEL, THREAD_TS, SESSION);
  store.setStatusPending(CHANNEL, THREAD_TS, "working");
  store.setStatusPending(CHANNEL, THREAD_TS, null, "done");
  assert.equal(heard.length, 6);
  // Each time, the thread the write touched and no other.
  assert.deepEqual(heard[1], [{ channel: CHANNEL, thread: THREAD_TS }]);
  assert.deepEqual(heard[2], [{ channel: CHANNEL, thread: OTHER_THREAD_TS }]);
  for (const changed of heard.slice(3))
    assert.deepEqual(changed, [{ channel: CHANNEL, thread: THREAD_TS }]);

  // What neither the index nor the channel's line shows: a reply's bookkeeping, bypass, effort,
  // a rebind.
  store.replaceOpenReply(CHANNEL, THREAD_TS, null, "1790549807.000001");
  store.setBypass(CHANNEL, THREAD_TS, true);
  store.setEffort(CHANNEL, THREAD_TS, "low");
  store.bind(CHANNEL, join(dir, "elsewhere"));
  assert.equal(heard.length, 6);

  store.removeThread(CHANNEL, THREAD_TS);
  assert.deepEqual(heard.slice(6), [[{ channel: CHANNEL, thread: THREAD_TS }]]);
});

test("the observer hears a prune that removed something", () => {
  const dir = scratch();
  const store = new StateStore(join(dir, "state.json"));
  store.bind(CHANNEL, join(dir, "project"));
  store.openThread(CHANNEL, THREAD_TS, SESSION);
  const heard: (readonly ThreadRef[])[] = [];
  store.onSessionsChange = (changed) => heard.push(changed);

  assert.equal(
    store.prune(() => new Set([SESSION]), opened, Number(THREAD_TS)),
    0,
  );
  assert.deepEqual(heard, []);
  assert.equal(
    store.prune(() => new Set(), opened, Number(THREAD_TS)),
    1,
  );
  assert.deepEqual(heard, [[{ channel: CHANNEL, thread: THREAD_TS }]]);
});

// #88: whether a thread asks the owner (an approval or a question open) changes with its
// requests, and the channel's line reads it; the status is written before the request is.
test("a request is announced when it changes whether the thread asks the owner", () => {
  const dir = scratch();
  const store = new StateStore(join(dir, "state.json"));
  store.bind(CHANNEL, join(dir, "project"));
  store.openThread(CHANNEL, THREAD_TS, SESSION);
  const heard: (readonly ThreadRef[])[] = [];
  store.onSessionsChange = (changed) => heard.push(changed);
  // The owner's own form: whether the thread asks him does not change.
  store.addRequest(CHANNEL, THREAD_TS, "1700000000.000001", "setup");
  assert.deepEqual(heard, []);
  store.addRequest(CHANNEL, THREAD_TS, "1700000001.000001", "question");
  store.addRequest(CHANNEL, THREAD_TS, "1700000002.000001", "approval"); // asks already
  store.removeRequest(CHANNEL, THREAD_TS, "1700000001.000001");
  store.removeRequest(CHANNEL, THREAD_TS, "1700000002.000001");
  const ref = { channel: CHANNEL, thread: THREAD_TS };
  assert.deepEqual(heard, [[ref], [ref]]);
});

test("remove channel forgets the channel and its threads and says which", () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  const store = new StateStore(path);
  store.bind(CHANNEL, join(dir, "project"));
  store.bind(OTHER_CHANNEL, join(dir, "other"));
  store.openThread(CHANNEL, THREAD_TS, SESSION);
  store.openThread(OTHER_CHANNEL, OTHER_THREAD_TS);
  const heard: (readonly ThreadRef[])[] = [];
  store.onSessionsChange = (changed) => heard.push(changed);

  store.removeChannel(CHANNEL);
  assert.deepEqual(store.channels(), [OTHER_CHANNEL]);
  assert.equal(store.thread(CHANNEL, THREAD_TS), null);
  assert.deepEqual(Object.keys(read(path).channels), [OTHER_CHANNEL]);
  assert.deepEqual(heard, [[{ channel: CHANNEL, thread: THREAD_TS }]]);
  assert.deepEqual(new StateStore(path).channels(), [OTHER_CHANNEL]); // it stays forgotten after a restart

  store.removeChannel(CHANNEL); // not there any more: nothing written, nothing announced
  assert.deepEqual(heard, [[{ channel: CHANNEL, thread: THREAD_TS }]]);
});

test("prune leaves alone the threads it is told to keep", () => {
  // A thread with a live session in the daemon: its session id may not be on disk yet, and
  // its setup may have been open for more than a day.
  const dir = scratch();
  const store = new StateStore(join(dir, "state.json"));
  store.bind(CHANNEL, join(dir, "project"));
  store.openThread(CHANNEL, THREAD_TS, SESSION);
  store.openThread(CHANNEL, OTHER_THREAD_TS);
  const later = Number(OTHER_THREAD_TS) + 2 * 24 * 60 * 60;
  const keep: ThreadRef[] = [
    { channel: CHANNEL, thread: THREAD_TS },
    { channel: CHANNEL, thread: OTHER_THREAD_TS },
  ];
  assert.equal(
    store.prune(() => new Set(), opened, later, keep),
    0,
  );
  assert.equal(
    store.prune(() => new Set(), opened, later, [{ channel: CHANNEL, thread: THREAD_TS }]),
    1,
  );
  assert.notEqual(store.thread(CHANNEL, THREAD_TS), null);
  assert.equal(store.thread(CHANNEL, OTHER_THREAD_TS), null);
});

// The status a thread holds is a word. Files written before the words were stored hold the name
// of the reaction that showed it.

test("a file that holds the four reaction names loads as the four words", () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  const names: Array<[string, string]> = [
    ["hourglass_flowing_sand", "working"],
    ["raised_hand", "waiting"],
    ["white_check_mark", "done"],
    ["x", "error"],
  ];
  for (const [name, word] of names) {
    writeThreadFile(path, dir, { directory: dir, status: name, ended: name });
    const thread = mustThread(new StateStore(path));
    assert.deepEqual([thread.status, thread.ended], [word, word], name);
  }
});

test("a file that holds words loads as words", () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  for (const word of ["working", "waiting", "done", "error"]) {
    writeThreadFile(path, dir, { directory: dir, status: word, ended: word });
    const thread = mustThread(new StateStore(path));
    assert.deepEqual([thread.status, thread.ended], [word, word]);
  }
});

test("an unknown status loads as null", () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  writeThreadFile(path, dir, { directory: dir, status: "eyes", ended: 3 });
  const thread = mustThread(new StateStore(path));
  assert.deepEqual([thread.status, thread.ended], [null, null]);
});

test("a save after loading reaction names writes words", () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  writeThreadFile(path, dir, {
    directory: dir,
    status: "hourglass_flowing_sand",
    ended: "x",
  });
  const store = new StateStore(path);
  store.setEffort(CHANNEL, THREAD_TS, "high");
  assert.deepEqual([written(path).status, written(path).ended], ["working", "error"]);
});

// The cases below pin the bytes the store writes and how it reads a file.

// The bytes of `state.json` for the calls below: the form of the Python daemon's file (captured on
// 2026-10-10), with a status stored as a word. The store keeps writing this form.
// Two-space indent, key order of the code, every non-ASCII character and DEL escaped, empty
// containers as `[]` and `{}`, and no trailing newline.
const STATE_BYTES = String.raw`{
  "version": 2,
  "channels": {
    "C000CHAN": {
      "directory": "/work/caf\u00e9 \ud83d\ude80 \"q\" \\ \t\u007f",
      "notice_pending": false,
      "threads": {
        "1790549806.565369": {
          "directory": "/work/caf\u00e9 \ud83d\ude80 \"q\" \\ \t\u007f",
          "session_id": "s-1",
          "bypass": true,
          "effort": "high",
          "open_replies": [
            "1790549807.000001",
            "1790549807.000009"
          ],
          "requests": [
            "1790549807.000002"
          ],
          "request_kinds": {
            "1790549807.000002": "question"
          },
          "status": "working",
          "ended": null,
          "root_prompt": "fix the *footer*\n\u00e9 \"q\""
        },
        "1790549900.100000": {
          "directory": "/work/caf\u00e9 \ud83d\ude80 \"q\" \\ \t\u007f",
          "session_id": "s-\u00e9\u2028",
          "bypass": false,
          "bypass_off": true,
          "effort": null,
          "open_replies": [],
          "requests": [],
          "request_kinds": {},
          "status": null,
          "ended": null,
          "root_prompt": null
        }
      }
    },
    "C000EMPT": {
      "directory": "/work/empty",
      "notice_pending": false,
      "threads": {}
    },
    "C000OTHR": {
      "directory": "/work/other",
      "notice_pending": false,
      "threads": {
        "1790550000.000001": {
          "directory": "/work/other",
          "session_id": null,
          "bypass": false,
          "effort": null,
          "open_replies": [],
          "requests": [],
          "request_kinds": {},
          "status": null,
          "ended": "done",
          "root_prompt": null
        }
      }
    }
  }
}`;

test("the file is written with these exact bytes, and read back into the same state", () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  const [c, e, o] = ["C000CHAN", "C000EMPT", "C000OTHR"];
  const [t1, t2, t3] = [THREAD_TS, OTHER_THREAD_TS, "1790550000.000001"];
  const store = new StateStore(path);
  store.bind(c, '/work/café \u{1F680} "q" \\ \t\x7f');
  store.bind(e, "/work/empty");
  store.bind(o, "/work/other");
  store.openThread(c, t1, "s-1");
  store.openThread(c, t2);
  store.openThread(o, t3);
  store.setBypass(c, t1, true);
  store.setBypass(c, t2, false);
  store.setEffort(c, t1, "high");
  store.replaceOpenReply(c, t1, null, "1790549807.000001");
  store.replaceOpenReply(c, t1, null, "1790549807.000009");
  store.addRequest(c, t1, "1790549807.000002", "question");
  store.setStatusPending(c, t1, "working");
  store.setStatusPending(o, t3, null, "done");
  store.setSession(c, t2, "s-é ");
  store.setRootPrompt(c, t1, 'fix the *footer*\né "q"');
  assert.equal(readFileSync(path, "utf8"), STATE_BYTES);
  // And the same bytes read back into the same state.
  assert.deepEqual(new StateStore(path).threads(), store.threads());
});

test("a file with an unreadable shape is refused with the file named", () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  const shapes: unknown[] = [
    [],
    null,
    { channels: {} },
    { version: 2 },
    { version: 2, channels: [] },
    { version: 2, channels: { [CHANNEL]: null } },
    { version: 2, channels: { [CHANNEL]: { notice_pending: false } } },
    { version: 2, channels: { [CHANNEL]: { directory: 7 } } },
    { version: 2, channels: { [CHANNEL]: { directory: dir, threads: null } } },
    { version: 2, channels: { [CHANNEL]: { directory: dir, threads: { [THREAD_TS]: {} } } } },
    { version: 1, channels: { [CHANNEL]: {} } },
  ];
  for (const shape of shapes) {
    writeFileSync(path, JSON.stringify(shape));
    assert.throws(
      () => new StateStore(path),
      (error: unknown) =>
        error instanceof StateError && error.message.startsWith(`${path} cannot be read (`),
      JSON.stringify(shape),
    );
  }
});

test("a file that is not UTF-8 is refused, not repaired", () => {
  const path = join(scratch(), "state.json");
  writeFileSync(path, Buffer.from([0x7b, 0xff, 0x7d]));
  assert.throws(() => new StateStore(path), StateError);
});

// The version of the update the owner was last told of is a top-level key beside
// `channels`. Like `bypass_off` it is additive: a file without it reads as "never told", code
// that does not know it ignores it, so the file stays at its version.
test("the version told of is kept across a restart, and the file keeps its version", () => {
  const path = join(scratch(), "state.json");
  const modules = { agent: "agent-a", chat: "chat-a" };
  const first = new StateStore(path, { modules });
  assert.equal(first.updateNotice, null);
  first.bind(CHANNEL, "/work/app");
  first.setUpdateNotice("0.3.1");
  assert.equal(first.updateNotice, "0.3.1");
  const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.equal(file.version, 3);
  assert.equal(file.update_notice, "0.3.1");
  const second = new StateStore(path, { modules });
  assert.equal(second.updateNotice, "0.3.1");
  assert.ok(second.channel(CHANNEL) !== null, "the channels are as they were");
  // A later write by the same store keeps the key.
  second.bind(OTHER_CHANNEL, "/work/other");
  assert.equal(new StateStore(path, { modules }).updateNotice, "0.3.1");
});

test("a state with no version told writes no key for it", () => {
  const path = join(scratch(), "state.json");
  const store = new StateStore(path, { modules: { agent: "agent-a", chat: "chat-a" } });
  store.bind(CHANNEL, "/work/app");
  assert.ok(!("update_notice" in read(path)));
});

test("a version told that is not a text is read as never told", () => {
  const path = join(scratch(), "state.json");
  writeFileSync(
    path,
    JSON.stringify({ version: 2, update_notice: 7, channels: { [CHANNEL]: { directory: "/a" } } }),
  );
  assert.equal(new StateStore(path).updateNotice, null);
});

test("setting the version told announces no change of the session index", () => {
  const path = join(scratch(), "state.json");
  const store = new StateStore(path);
  store.bind(CHANNEL, "/work/app");
  let announced = 0;
  store.onSessionsChange = () => {
    announced += 1;
  };
  store.setUpdateNotice("0.3.1");
  assert.equal(announced, 0);
});

// The message to rewrite once the daemon is back from a restart it asked for: a
// second top-level key, additive like `update_notice`. `version` is the one an update asked for,
// null for a plain restart.
test("the restart notice is kept across a restart, and the file keeps its version", () => {
  const path = join(scratch(), "state.json");
  const modules = { agent: "agent-a", chat: "chat-a" };
  const first = new StateStore(path, { modules });
  assert.equal(first.restartNotice, null);
  first.bind(CHANNEL, "/work/app");
  first.setRestartNotice({ channel: CHANNEL, message: "1780000000.000100", version: "0.3.1" });
  const file = read(path) as StateFile & { restart_notice?: unknown };
  assert.equal(file.version, 3);
  assert.deepEqual(file.restart_notice, {
    channel: CHANNEL,
    message: "1780000000.000100",
    version: "0.3.1",
  });
  const second = new StateStore(path, { modules });
  assert.deepEqual(second.restartNotice, {
    channel: CHANNEL,
    message: "1780000000.000100",
    version: "0.3.1",
  });
  assert.ok(second.channel(CHANNEL) !== null, "the channels are as they were");
  // A later write by the same store keeps the key, and a restart with no version keeps the null.
  second.bind(OTHER_CHANNEL, "/work/other");
  second.setRestartNotice({ channel: CHANNEL, message: "1780000000.000200", version: null });
  assert.deepEqual(new StateStore(path, { modules }).restartNotice, {
    channel: CHANNEL,
    message: "1780000000.000200",
    version: null,
  });
});

test("a file written before the restart notice reads as none, and writes no key for it", () => {
  const path = join(scratch(), "state.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 2,
      update_notice: "0.3.1",
      channels: { [CHANNEL]: { directory: "/a" } },
    }),
  );
  const store = new StateStore(path);
  assert.equal(store.restartNotice, null);
  store.bind(OTHER_CHANNEL, "/work/other");
  assert.ok(!("restart_notice" in read(path)));
  assert.equal(store.updateNotice, "0.3.1", "the other top-level key is untouched");
});

test("forgetting the restart notice removes the key and is the same when none is kept", () => {
  const path = join(scratch(), "state.json");
  const store = new StateStore(path, { modules: { agent: "agent-a", chat: "chat-a" } });
  store.bind(CHANNEL, "/work/app");
  const kept = { channel: CHANNEL, message: "1780000000.000100", version: null };
  store.clearRestartNotice(kept);
  assert.ok(!("restart_notice" in read(path)));
  store.setRestartNotice(kept);
  store.clearRestartNotice({ ...kept });
  assert.equal(store.restartNotice, null);
  assert.ok(!("restart_notice" in read(path)));
  assert.equal(
    new StateStore(path, { modules: { agent: "agent-a", chat: "chat-a" } }).restartNotice,
    null,
  );
});

for (const [name, value] of [
  ["not an object", "C000CHAN"],
  ["without a message", { channel: CHANNEL, version: null }],
  ["with a channel that is no text", { channel: 7, message: "1.1", version: null }],
  [
    "with a version that is neither text nor null",
    { channel: CHANNEL, message: "1.1", version: 3 },
  ],
] as const) {
  test(`a restart notice ${name} is read as none`, () => {
    const path = join(scratch(), "state.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        restart_notice: value,
        channels: { [CHANNEL]: { directory: "/a" } },
      }),
    );
    assert.equal(new StateStore(path).restartNotice, null);
  });
}

test("setting the restart notice announces no change of the session index", () => {
  const path = join(scratch(), "state.json");
  const store = new StateStore(path);
  store.bind(CHANNEL, "/work/app");
  let announced = 0;
  store.onSessionsChange = () => {
    announced += 1;
  };
  store.setRestartNotice({ channel: CHANNEL, message: "1.1", version: null });
  store.clearRestartNotice({ channel: CHANNEL, message: "1.1", version: null });
  assert.equal(announced, 0);
});

test("forgetting a restart notice leaves a different one in place", () => {
  const path = join(scratch(), "state.json");
  const store = new StateStore(path, { modules: { agent: "agent-a", chat: "chat-a" } });
  store.bind(CHANNEL, "/work/app");
  const newer = { channel: CHANNEL, message: "1780000000.000200", version: null };
  store.setRestartNotice(newer);
  store.clearRestartNotice({ channel: CHANNEL, message: "1780000000.000100", version: null });
  assert.deepEqual(store.restartNotice, newer);
  store.clearRestartNotice({ channel: OTHER_CHANNEL, message: newer.message, version: null });
  assert.deepEqual(store.restartNotice, newer, "the message id alone is not the record");
  assert.deepEqual((read(path) as StateFile & { restart_notice?: unknown }).restart_notice, newer);
});

test("a restart notice that could not be written is not kept in memory", () => {
  const path = join(scratch(), "state.json");
  const store = new StateStore(path, {
    sync: () => {
      throw new Error("disk full");
    },
  });
  assert.throws(() => store.setRestartNotice({ channel: CHANNEL, message: "1.1", version: null }));
  assert.equal(store.restartNotice, null);
});
