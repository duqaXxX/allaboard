import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  AlreadyRunning,
  ChatIdentityTaken,
  CLAIM_STALE_MS,
  chatIdentityLock,
  chatIdentityLocks,
  directoryHeld,
  identityDirectory,
  listenLocal,
  PROBE_TRIES,
  singleInstance,
  socketHeld,
  socketLock,
  UpdateUnderWay,
  updateDirectory,
  updateHeld,
  updateLock,
} from "../../src/core/lock.ts";

const LOCK_MODULE = pathToFileURL(join(import.meta.dirname, "..", "..", "src", "core", "lock.ts"));
const POSIX_ONLY = {
  skip:
    process.platform === "win32" &&
    "the lock is a named pipe on Windows, with no socket file or claim, and folder modes are POSIX",
};
// The directory lock is the macOS mechanism; the others run the socket one.
const MACOS_ONLY = {
  skip: process.platform === "darwin" ? false : "the directory lock is the macOS mechanism",
};
const made: string[] = [];

/**
 * A fresh directory for a lock. A Unix socket path is limited to 104 bytes on macOS (103
 * usable), whose own `os.tmpdir()` is far longer than that, so on POSIX it lives under `/tmp`.
 */
function scratch(): string {
  const directory =
    process.platform === "win32" ? mkdtempSync(join(tmpdir(), "awd-")) : mkdtempSync("/tmp/awd-");
  made.push(directory);
  return directory;
}

after(() => {
  for (const directory of made) rmSync(directory, { recursive: true, force: true });
});

/**
 * A child process that prints `held` once `script` has run and then waits to be killed. The
 * child's stdout is read to the first `held`, never by a pause.
 */
async function child(command: string, args: string[]): Promise<ChildProcess> {
  const spawned = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  spawned.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    let out = "";
    spawned.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("held\n")) resolve();
    });
    spawned.once("exit", (code, signal) =>
      reject(new Error(`the child exited (${code ?? signal}) before holding: ${stderr}`)),
    );
  }).catch((error: unknown) => {
    spawned.kill("SIGKILL");
    throw error;
  });
  return spawned;
}

/** A Node child that takes the lock on `directory` with `taker`, prints `held` and waits. */
function holder(directory: string, taker: "singleInstance" | "socketLock"): Promise<ChildProcess> {
  const script = `
    const { ${taker} } = await import(${JSON.stringify(LOCK_MODULE.href)});
    await ${taker}(${JSON.stringify(directory)});
    console.log("held");
    setTimeout(() => {}, 30000);
  `;
  return child(process.execPath, ["--input-type=module", "-e", script]);
}

/** Resolves once `child` has exited, whatever its state now. */
function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

async function killed(child: ChildProcess): Promise<void> {
  child.kill("SIGKILL");
  await exited(child);
}

test("a second holder is refused", async () => {
  const directory = scratch();
  const first = await singleInstance(directory);
  try {
    await assert.rejects(
      singleInstance(directory),
      (error: unknown) =>
        error instanceof AlreadyRunning &&
        error.message === `another allaboard is running (lock on ${directory})`,
    );
  } finally {
    await first.release();
  }
});

test("the lock is released on exit", async () => {
  const directory = scratch();
  await (await singleInstance(directory)).release();
  await (await singleInstance(directory)).release();
});

test("another process is refused", { timeout: 20000 }, async () => {
  const directory = scratch();
  const other = await holder(directory, "singleInstance");
  try {
    await assert.rejects(singleInstance(directory), AlreadyRunning);
  } finally {
    await killed(other);
  }
});

// Where the lock is the socket (every platform but macOS) the lock does add a file, so this one
// runs on macOS alone; the socket's own file is tested below.
test("the lock creates no file", MACOS_ONLY, async () => {
  const directory = scratch();
  const lock = await singleInstance(directory);
  try {
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    await lock.release();
  }
});

test("the lock of a killed process does not block the next start", MACOS_ONLY, async () => {
  const directory = scratch();
  const other = await holder(directory, "singleInstance");
  await killed(other);
  // A killed process cannot clean up, and needs no cleanup: the kernel drops the lock.
  await (await singleInstance(directory)).release();
  assert.deepEqual(readdirSync(directory), []);
});

test("releasing the lock twice is harmless", MACOS_ONLY, async () => {
  const directory = scratch();
  const lock = await singleInstance(directory);
  await lock.release();
  const next = await singleInstance(directory);
  try {
    // The second release must not close the descriptor the next lock now holds.
    await lock.release();
    await assert.rejects(singleInstance(directory), AlreadyRunning);
  } finally {
    await next.release();
  }
});

// The socket mechanism, called directly so that it is tested on macOS too.

test("the socket lock refuses a second holder", POSIX_ONLY, async () => {
  const directory = scratch();
  const first = await socketLock(directory);
  try {
    await assert.rejects(
      socketLock(directory),
      (error: unknown) =>
        error instanceof AlreadyRunning &&
        error.message === `another allaboard is running (lock on ${directory})`,
    );
  } finally {
    await first.release();
  }
  await (await socketLock(directory)).release();
});

test("the socket lock of another process is refused", {
  ...POSIX_ONLY,
  timeout: 20000,
}, async () => {
  const directory = scratch();
  const other = await holder(directory, "socketLock");
  try {
    await assert.rejects(socketLock(directory), AlreadyRunning);
  } finally {
    await killed(other);
  }
});

test("the socket lock leaves only its socket, and release removes it", POSIX_ONLY, async () => {
  const directory = scratch();
  const lock = await socketLock(directory);
  assert.deepEqual(readdirSync(directory), ["lock.sock"]);
  await lock.release();
  assert.deepEqual(readdirSync(directory), []);
});

test("the socket is private to the owner", POSIX_ONLY, async () => {
  const directory = scratch();
  const lock = await socketLock(directory);
  try {
    assert.equal(statSync(join(directory, "lock.sock")).mode & 0o777, 0o600);
  } finally {
    await lock.release();
  }
});

test("a socket left by a dead process does not block the next start", {
  ...POSIX_ONLY,
  timeout: 20000,
}, async () => {
  const directory = scratch();
  await killed(await holder(directory, "socketLock"));
  // A killed process cannot clean up: its socket file is still there.
  assert.ok(existsSync(join(directory, "lock.sock")));
  const lock = await socketLock(directory);
  await lock.release();
  assert.deepEqual(readdirSync(directory), []);
});

// A claim file is stale by its mtime, whatever it holds: a recovery takes milliseconds, so one
// older than CLAIM_STALE_MS belongs to a starter that died (review 2026-10-10).

/** A clock that reads `afterMs` past the mtime of `path`. */
function clockPast(path: string, afterMs: number): () => number {
  const mtime = statSync(path).mtimeMs;
  return () => mtime + afterMs;
}

for (const [label, content] of [
  ["empty", ""],
  ["naming a live process", String(process.pid)],
  ["naming no process", "not a pid"],
] as const) {
  test(`a stale claim does not block the next start [${label}]`, POSIX_ONLY, async () => {
    const directory = scratch();
    const claim = join(directory, "lock.sock.claim");
    writeFileSync(claim, content);
    const lock = await socketLock(directory, { now: clockPast(claim, CLAIM_STALE_MS + 1) });
    await lock.release();
    assert.deepEqual(readdirSync(directory), []);
  });

  test(`a claim younger than the stale age refuses the start [${label}]`, POSIX_ONLY, async () => {
    const directory = scratch();
    const claim = join(directory, "lock.sock.claim");
    writeFileSync(claim, content);
    await assert.rejects(
      socketLock(directory, { now: clockPast(claim, CLAIM_STALE_MS) }),
      AlreadyRunning,
    );
    // The refused start leaves the claim of whoever holds it.
    assert.ok(existsSync(claim));
    assert.deepEqual(readdirSync(directory), ["lock.sock.claim"]);
  });
}

test("a stale claim and a dead socket together do not block the next start", {
  ...POSIX_ONLY,
  timeout: 20000,
}, async () => {
  const directory = scratch();
  await killed(await holder(directory, "socketLock"));
  const claim = join(directory, "lock.sock.claim");
  writeFileSync(claim, "");
  const lock = await socketLock(directory, { now: clockPast(claim, CLAIM_STALE_MS + 1) });
  await lock.release();
  assert.deepEqual(readdirSync(directory), []);
});

test("a start between another's claim and its first listen is refused", {
  ...POSIX_ONLY,
  timeout: 20000,
}, async () => {
  // A socket that is bound and not yet listening refuses connections, as the file of a dead
  // holder does: a second starter that probed it would take it for stale and remove it. The dead
  // holder's file stands in for it, and the second start runs inside the first one's `listen`,
  // after its claim and before it holds anything.
  const directory = scratch();
  await killed(await holder(directory, "socketLock"));
  const socket = join(directory, "lock.sock");
  let calls = 0;
  const first = await socketLock(directory, {
    listen: async (address) => {
      if (calls++ === 0) {
        await assert.rejects(socketLock(directory), AlreadyRunning);
        assert.ok(existsSync(socket), "the second start must leave the socket alone");
      }
      return listenLocal(address);
    },
  });
  try {
    assert.equal(calls, 2);
    assert.deepEqual(readdirSync(directory), ["lock.sock"]);
    await assert.rejects(socketLock(directory), AlreadyRunning);
  } finally {
    await first.release();
  }
});

test("two starts racing for a stale socket leave exactly one holder", POSIX_ONLY, async () => {
  const directory = scratch();
  await killed(await holder(directory, "socketLock"));
  const results = await Promise.allSettled([socketLock(directory), socketLock(directory)]);
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  try {
    assert.equal(won.length, 1);
    assert.equal(lost.length, 1);
    assert.ok(lost[0]?.status === "rejected" && lost[0].reason instanceof AlreadyRunning);
  } finally {
    for (const result of won) await result.value.release();
  }
});

test("two starts racing in a clean directory leave exactly one holder", POSIX_ONLY, async () => {
  const directory = scratch();
  const results = await Promise.allSettled([
    socketLock(directory),
    socketLock(directory),
    socketLock(directory),
  ]);
  const won = results.filter((r) => r.status === "fulfilled");
  try {
    assert.equal(won.length, 1);
    for (const result of results) {
      if (result.status === "rejected") assert.ok(result.reason instanceof AlreadyRunning);
    }
  } finally {
    for (const result of won) await result.value.release();
  }
});

test(
  "a path over the system's socket limit is refused with the limit named",
  POSIX_ONLY,
  async () => {
    const directory = join(scratch(), "x".repeat(150));
    mkdirSync(directory);
    await assert.rejects(
      socketLock(directory),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof AlreadyRunning) &&
        /bytes.*limit/.test(error.message),
    );
  },
);

// ---- the lock on a chat identity

const IDENTITY = "T000ACME:U000BOT";

test("the identity's folder is the first 16 hex of its hash, under a name no instance can hold", () => {
  const home = `${"/ho"}me/alice`;
  const digest = createHash("sha256").update(IDENTITY).digest("hex").slice(0, 16);
  assert.equal(
    identityDirectory(home, IDENTITY),
    join(home, ".config", "allaboard_identities", digest),
  );
});

test("a second daemon on the same identity is refused, with its own error", async () => {
  const home = scratch();
  const first = await chatIdentityLock(IDENTITY, home);
  try {
    await assert.rejects(
      chatIdentityLock(IDENTITY, home),
      (error: unknown) =>
        error instanceof ChatIdentityTaken &&
        error instanceof AlreadyRunning &&
        error.message ===
          `another allaboard instance is connected to this chat app (lock on ${identityDirectory(home, IDENTITY)}): give each instance its own app`,
    );
  } finally {
    await first.release();
  }
});

test("the instance lock's refusal is not the identity's", async () => {
  const directory = scratch();
  const first = await singleInstance(directory);
  try {
    await assert.rejects(
      singleInstance(directory),
      (error: unknown) => error instanceof AlreadyRunning && !(error instanceof ChatIdentityTaken),
    );
  } finally {
    await first.release();
  }
});

test("two identities are both held", async () => {
  const home = scratch();
  const first = await chatIdentityLock(IDENTITY, home);
  const second = await chatIdentityLock("T000ACME:U000OTHER", home);
  await first.release();
  await second.release();
});

test("several identities are all taken, and all released together", async () => {
  const home = scratch();
  const keys = [IDENTITY, "app-token:0123abcd"];
  const held = await chatIdentityLocks(keys, home);
  for (const key of keys) {
    await assert.rejects(chatIdentityLock(key, home), ChatIdentityTaken);
  }
  await held.release();
  for (const key of keys) await (await chatIdentityLock(key, home)).release();
});

test("one identity of several taken by another daemon refuses them all, and frees the ones it took", async () => {
  const home = scratch();
  const other = await chatIdentityLock("app-token:0123abcd", home);
  try {
    await assert.rejects(
      chatIdentityLocks([IDENTITY, "app-token:0123abcd"], home),
      (error: unknown) =>
        error instanceof ChatIdentityTaken &&
        error.message ===
          `another allaboard instance is connected to this chat app (lock on ${identityDirectory(home, "app-token:0123abcd")}): give each instance its own app`,
    );
    // The first key was taken before the second was refused: it is free again.
    await (await chatIdentityLock(IDENTITY, home)).release();
  } finally {
    await other.release();
  }
});

test("a released identity is free for the next daemon", async () => {
  const home = scratch();
  await (await chatIdentityLock(IDENTITY, home)).release();
  await (await chatIdentityLock(IDENTITY, home)).release();
});

test("an identity held by another process is refused", { timeout: 20000 }, async () => {
  const home = scratch();
  const directory = identityDirectory(home, IDENTITY);
  mkdirSync(directory, { recursive: true });
  const other = await holder(directory, "singleInstance");
  try {
    await assert.rejects(chatIdentityLock(IDENTITY, home), ChatIdentityTaken);
  } finally {
    await killed(other);
  }
});

test("the identities' folders are private to the owner", POSIX_ONLY, async () => {
  const home = scratch();
  const lock = await chatIdentityLock(IDENTITY, home);
  try {
    assert.equal(statSync(identityDirectory(home, IDENTITY)).mode & 0o777, 0o700);
    assert.equal(statSync(join(home, ".config", "allaboard_identities")).mode & 0o777, 0o700);
  } finally {
    await lock.release();
  }
});

// ---- the lock on an update

test("the update lock's folder is one per user, under a name no instance can hold", () => {
  const home = `${"/ho"}me/alice`;
  assert.equal(updateDirectory(home), join(home, ".config", "allaboard_update"));
});

test("a second update on the machine is refused, with its own error", async () => {
  const home = scratch();
  const first = await updateLock(home);
  try {
    await assert.rejects(
      updateLock(home),
      (error: unknown) =>
        error instanceof UpdateUnderWay &&
        error instanceof AlreadyRunning &&
        !(error instanceof ChatIdentityTaken) &&
        error.message ===
          `an update of allaboard is already under way (lock on ${updateDirectory(home)})`,
    );
  } finally {
    await first.release();
  }
  await (await updateLock(home)).release();
});

test("the update lock stands apart from the chat identities' locks", async () => {
  const home = scratch();
  const update = await updateLock(home);
  const identity = await chatIdentityLock(IDENTITY, home);
  await identity.release();
  await update.release();
});

test("an update lock held by a process that dies is free again", async () => {
  const home = scratch();
  const script = `
    const { updateLock } = await import(${JSON.stringify(LOCK_MODULE.href)});
    await updateLock(${JSON.stringify(home)});
    console.log("held");
    setTimeout(() => {}, 30000);
  `;
  const other = await child(process.execPath, ["--input-type=module", "-e", script]);
  await assert.rejects(updateLock(home), UpdateUnderWay);
  await killed(other);
  await (await updateLock(home)).release();
});

// ---- the question "is an update under way", asked before an agent process starts

// `O_SHLOCK` of macOS's `open(2)`: "atomically obtain a shared lock", flock(2) semantics, and
// `EWOULDBLOCK` when the file is locked and `O_NONBLOCK` was given (`man 2 open`);
// `#define O_SHLOCK 0x00000010` in `sys/fcntl.h` of the MacOSX SDK (read 2026-10-17).
const O_SHLOCK = 0x10;

/** The shared lock of a probe, held by the test for as long as it likes (macOS). */
function sharedHold(directory: string): { release(): void } {
  const fd = openSync(directory, constants.O_RDONLY | O_SHLOCK | constants.O_NONBLOCK);
  return { release: () => closeSync(fd) };
}

test("no update lock held is a free machine, even before the folder exists", async () => {
  const home = scratch();
  assert.equal(await updateHeld(home), false, "no folder yet");
  const lock = await updateLock(home);
  await lock.release();
  assert.equal(await updateHeld(home), false, "released");
});

test("an update lock held in this process or in another is told as held", {
  timeout: 20000,
}, async () => {
  const home = scratch();
  const first = await updateLock(home);
  try {
    assert.equal(await updateHeld(home), true, "this process");
  } finally {
    await first.release();
  }
  const script = `
    const { updateLock } = await import(${JSON.stringify(LOCK_MODULE.href)});
    await updateLock(${JSON.stringify(home)});
    console.log("held");
    setTimeout(() => {}, 30000);
  `;
  const other = await child(process.execPath, ["--input-type=module", "-e", script]);
  try {
    assert.equal(await updateHeld(home), true, "another process");
  } finally {
    await killed(other);
  }
  assert.equal(await updateHeld(home), false, "the holder died");
});

test("asking does not hold the lock: the installer's take works right after", async () => {
  const home = scratch();
  await updateLock(home).then((lock) => lock.release()); // the folder exists
  for (let asked = 0; asked < 50; asked += 1) {
    assert.equal(await updateHeld(home), false);
    await (await updateLock(home)).release();
  }
});

test("the directory probe tells held from free and from missing", MACOS_ONLY, async () => {
  const directory = scratch();
  assert.equal(await directoryHeld(join(directory, "nowhere")), false);
  assert.equal(await directoryHeld(directory), false);
  const lock = await singleInstance(directory);
  try {
    assert.equal(await directoryHeld(directory), true);
  } finally {
    await lock.release();
  }
  assert.equal(await directoryHeld(directory), false);
});

test("the directory probe takes its shared lock for an instant only", MACOS_ONLY, async () => {
  const directory = scratch();
  assert.equal(await directoryHeld(directory), false);
  // Nothing of the probe is left: an exclusive take succeeds at once, with no retry.
  await (await singleInstance(directory)).release();
});

test("two probes at once do not see each other", MACOS_ONLY, async () => {
  const directory = scratch();
  const answers = await Promise.all(Array.from({ length: 20 }, () => directoryHeld(directory)));
  assert.deepEqual(new Set(answers), new Set([false]));
});

test(
  "an exclusive take that meets a probe's shared lock tries again and gets the lock",
  MACOS_ONLY,
  async () => {
    const home = scratch();
    const directory = updateDirectory(home);
    mkdirSync(directory, { recursive: true });
    // The plain take is refused while a probe holds its shared lock: the case the retry is for.
    const probe = sharedHold(directory);
    await assert.rejects(singleInstance(directory), AlreadyRunning);
    setTimeout(() => probe.release(), 40);
    const lock = await updateLock(home);
    await lock.release();
  },
);

test(
  "an exclusive take that keeps meeting a lock reports an update under way, after about 200 ms",
  MACOS_ONLY,
  async () => {
    const home = scratch();
    const directory = updateDirectory(home);
    mkdirSync(directory, { recursive: true });
    const probe = sharedHold(directory);
    try {
      const began = Date.now();
      await assert.rejects(updateLock(home), UpdateUnderWay);
      const took = Date.now() - began;
      assert.ok(took >= 150 && took < 2000, `it tried for ${took} ms`);
    } finally {
      probe.release();
    }
  },
);

test("a take that finds the lock held for a moment gets it when it is let go", async () => {
  const home = scratch();
  const first = await updateLock(home);
  setTimeout(() => void first.release(), 40);
  const second = await updateLock(home);
  await second.release();
});

test("the socket probe tells held from free, from missing and from a socket left by a dead process", {
  ...POSIX_ONLY,
  timeout: 20000,
}, async () => {
  const directory = scratch();
  assert.equal(await socketHeld(join(directory, "nowhere")), false);
  assert.equal(await socketHeld(directory), false);
  const lock = await socketLock(directory);
  try {
    assert.equal(await socketHeld(directory), true);
  } finally {
    await lock.release();
  }
  assert.equal(await socketHeld(directory), false);
  await killed(await holder(directory, "socketLock"));
  assert.ok(existsSync(join(directory, "lock.sock")));
  assert.equal(await socketHeld(directory), false, "a dead holder's socket is free");
  // Read-only: the probe removed nothing and left no claim file.
  assert.deepEqual(readdirSync(directory), ["lock.sock"]);
});

test("the socket probe finds the socket lock of another process", {
  ...POSIX_ONLY,
  timeout: 20000,
}, async () => {
  const directory = scratch();
  const other = await holder(directory, "socketLock");
  try {
    assert.equal(await socketHeld(directory), true);
    await assert.rejects(socketLock(directory), AlreadyRunning);
  } finally {
    await killed(other);
  }
});

test("the socket probe does not disturb a lock being taken", POSIX_ONLY, async () => {
  const directory = scratch();
  const probes = Promise.all(Array.from({ length: 20 }, () => socketHeld(directory)));
  const lock = await socketLock(directory);
  await probes;
  assert.equal(await socketHeld(directory), true);
  await lock.release();
});

// A holder that is closing resets a connection that was queued but not yet accepted, and the
// probe sees `ECONNRESET` before `connect` (measured on Linux, Node 22).

/** A connect that fails with `code` before `connect` for its first `failures` calls, then is real. */
function resetting(
  code: string,
  failures: number,
): { connect: (path: string) => net.Socket; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    connect: (path) => {
      calls += 1;
      if (calls > failures) return net.connect({ path });
      const socket = new net.Socket();
      setImmediate(() => socket.destroy(Object.assign(new Error(`connect ${code}`), { code })));
      return socket;
    },
  };
}

for (const code of ["ECONNRESET", "EPIPE"]) {
  test(`the socket probe asks again after ${code} before connect`, POSIX_ONLY, async () => {
    const directory = scratch();
    const lock = await socketLock(directory);
    const probe = resetting(code, 2);
    try {
      assert.equal(await socketHeld(directory, probe.connect), true);
      assert.equal(probe.calls(), 3);
    } finally {
      await lock.release();
    }
    // The holder is gone by the next ask: the answer is that nothing is held.
    assert.equal(await socketHeld(directory, resetting(code, 1).connect), false);
  });
}

test("the socket probe gives up on a reset that does not end", POSIX_ONLY, async () => {
  const directory = scratch();
  const lock = await socketLock(directory);
  const probe = resetting("ECONNRESET", Number.POSITIVE_INFINITY);
  try {
    await assert.rejects(
      socketHeld(directory, probe.connect),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ECONNRESET",
    );
    assert.equal(probe.calls(), PROBE_TRIES);
  } finally {
    await lock.release();
  }
});

test("a take over a stale socket survives a reset of its probe", POSIX_ONLY, async () => {
  const directory = scratch();
  await killed(await holder(directory, "socketLock"));
  const probe = resetting("ECONNRESET", 1);
  const lock = await socketLock(directory, { connect: probe.connect });
  await lock.release();
  assert.equal(probe.calls(), 2);
});

// Fails only on Linux: macOS never resets a queued probe, and Windows skips.
test("probing a holder that closes at that moment never fails", {
  ...POSIX_ONLY,
  timeout: 60000,
}, async () => {
  const directory = scratch();
  for (let round = 0; round < 200; round += 1) {
    const lock = await socketLock(directory);
    const probes = Promise.all(Array.from({ length: 8 }, () => socketHeld(directory)));
    await lock.release();
    await probes;
  }
});
