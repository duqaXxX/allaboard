/**
 * One daemon at a time. A chat identity takes one daemon: a chat that sends each event to one of
 * the connections open for the same identity would split them between two.
 *
 * What holds, by platform (`singleInstance` picks the mechanism):
 *
 * - macOS, the only supported host: the lock is the open file description of the configuration
 *   directory itself, opened with `O_EXLOCK | O_NONBLOCK`, which is `flock(LOCK_EX | LOCK_NB)` on
 *   the directory. It adds no file, and the kernel drops it when the process dies, a killed one
 *   included, and whatever child processes outlive it (the descriptor is close-on-exec). Renaming
 *   or removing `lock.sock` or any other file in the directory changes nothing.
 * - Linux: a listening Unix socket `lock.sock` in the directory, with `lock.sock.claim` taken
 *   around every start so that the recovery of a stale socket is never raced. Linux has no
 *   `O_EXLOCK`, and Node has no `flock`. A path-named lock has one limit the macOS one lacks:
 *   removing `lock.sock` under a live holder lets a second start in, since the new socket is a
 *   different file. A claim file left behind blocks a start for at most `CLAIM_STALE_MS`.
 * - Windows: a named pipe derived from the directory's real path. The system drops it with its
 *   process and refuses a second one of the same name; no claim file is involved.
 *
 * The update lock (`updateLock`) can also be asked about without being taken (`updateHeld`), by
 * a daemon about to start an agent process: on macOS with a shared lock on the directory
 * (`O_SHLOCK | O_NONBLOCK`) closed at once, which an exclusive take meets for microseconds and
 * answers by trying again; on Linux and Windows by a connection to the socket or the pipe, which
 * changes nothing in the holder or in the files.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { errorCode } from "../values.ts";

// `O_EXLOCK` of macOS's `open(2)`: "atomically obtain an exclusive lock", with flock(2) semantics;
// `#define O_EXLOCK 0x00000020` in `sys/fcntl.h` of the MacOSX SDK (`man 2 open` and that header,
// read on 2026-10-10). Node's `fs.constants` does not export it and Linux has no such flag; Node
// hands the number to `open(2)` through libuv. Measured on macOS the same day, on Node 22 and 26:
// it conflicts with Python's `fcntl.flock(fd, LOCK_EX | LOCK_NB)` on the directory in both
// directions, failing with `EAGAIN` (macOS's `EWOULDBLOCK`, which `open(2)` documents).
const O_EXLOCK = 0x20;

// `O_SHLOCK` of the same page and header (`man 2 open`: "atomically obtain a shared lock", with
// flock(2) semantics, and `EWOULDBLOCK` when the file is locked and `O_NONBLOCK` was given;
// `#define O_SHLOCK 0x00000010` in `sys/fcntl.h`, MacOSX SDK, read 2026-10-17). A shared lock
// conflicts with an exclusive one only: any number of probes at once see nothing of each other.
const O_SHLOCK = 0x10;

// A Unix socket path must fit `sun_path`: 104 bytes on macOS and the BSDs, 108 on Linux, one of
// them the terminating NUL.
const SOCKET_PATH_LIMIT =
  process.platform === "darwin" || process.platform.endsWith("bsd") ? 104 : 108;
const SOCKET_NAME = "lock.sock";

/** Another allaboard process holds the lock. */
export class AlreadyRunning extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlreadyRunning";
  }
}

/**
 * Another daemon holds the lock of this daemon's chat identity: a chat identity takes one daemon,
 * since two instances sharing it would each get a share of its events. Its own class so that the
 * message can tell it from the instance lock's.
 */
export class ChatIdentityTaken extends AlreadyRunning {
  constructor(directory: string) {
    super(
      `another allaboard instance is connected to this chat app (lock on ${directory}): ` +
        "give each instance its own app",
    );
    this.name = "ChatIdentityTaken";
  }
}

/** A held lock; `release` lets the next start in. */
export interface InstanceLock {
  release(): Promise<void>;
}

// Listening on a name that is taken fails with EADDRINUSE; macOS answers EEXIST when two binds
// race for the same name (seen with six starters at once).
function nameTaken(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EADDRINUSE" || code === "EEXIST";
}

/** The address the lock listens on: a socket file in `directory`, a named pipe on Windows. */
function lockAddress(directory: string): string {
  if (process.platform === "win32") {
    const real = realpathSync.native(directory).toLowerCase();
    return `\\\\.\\pipe\\allaboard-${createHash("sha256").update(real).digest("hex")}`;
  }
  const path = join(directory, SOCKET_NAME);
  const bytes = Buffer.byteLength(path);
  if (bytes >= SOCKET_PATH_LIMIT) {
    throw new Error(
      `the lock socket path is ${bytes} bytes, over the ${SOCKET_PATH_LIMIT - 1}-byte limit of ` +
        `Unix sockets on this system; use a shorter configuration directory: ${path}`,
    );
  }
  return path;
}

/** Listens on `address`; resolves to the server, rejects with the listen error (`EADDRINUSE`...). */
export type ListenFn = (address: string) => Promise<net.Server>;

export const listenLocal: ListenFn = (address) =>
  new Promise((resolve, reject) => {
    // The lock accepts no data: whoever connects is told nothing and dropped at once.
    const server = net.createServer((connection) => connection.destroy());
    server.once("error", reject);
    server.listen({ path: address }, () => {
      server.off("error", reject);
      resolve(server);
    });
  });

/** Opens the probe's connection; a test passes its own to fail it the way a closing holder does. */
export type ConnectFn = (path: string) => net.Socket;

const connectLocal: ConnectFn = (path) => net.connect({ path });

/** How many times a probe asks before a reset stands as its answer, and the pause between asks. */
export const PROBE_TRIES = 5;
export const PROBE_PAUSE_MS = 10;

/** One ask: true on `connect`, false on `ECONNREFUSED`/`ENOENT`, rejects with any other error. */
function askOnce(path: string, connect: ConnectFn): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = connect(path);
    // The holder drops the connection at once; a reset after the verdict is not an error.
    probe.on("error", (error) => {
      const code = errorCode(error);
      if (code === "ECONNREFUSED" || code === "ENOENT") resolve(false);
      else reject(error);
    });
    probe.once("connect", () => {
      resolve(true);
      probe.destroy();
    });
  });
}

/**
 * True when a process accepts connections at `path`, false when nothing is listening there. A
 * holder that closes while the probe is queued resets it before `connect` (`ECONNRESET`, seen
 * on Linux, never on macOS; `EPIPE` is handled as a precaution and was never seen):
 * the address held a socket that is going, so the probe asks again, `PROBE_TRIES` times in all,
 * and the reset stands only if it persists. Any other error rejects at once.
 */
async function accepts(path: string, connect: ConnectFn = connectLocal): Promise<boolean> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await askOnce(path, connect);
    } catch (error) {
      const code = errorCode(error);
      if ((code !== "ECONNRESET" && code !== "EPIPE") || attempt === PROBE_TRIES) throw error;
    }
    // The closing holder unlinks its socket within a tick of the reset; the next ask finds it gone.
    await new Promise((resolve) => setTimeout(resolve, PROBE_PAUSE_MS));
  }
}

/** A claim older than this by its mtime is dead: a recovery takes milliseconds. */
export const CLAIM_STALE_MS = 5_000;

/**
 * Takes the claim around a start: an exclusive create of `claim`. A claim file older than
 * `CLAIM_STALE_MS` by its mtime is cleared and taken once more, whatever it holds: a starter that
 * died in the milliseconds of its start, or failed to write its pid, leaves one behind. Two
 * starters that both find the same stale claim may both clear it, the second one removing the
 * first's fresh claim; `replaceStale` checks the socket file again for that case.
 */
function takeClaim(claim: string, now: () => number): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(claim, String(process.pid), { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    let age: number;
    try {
      age = now() - statSync(claim).mtimeMs;
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue; // released meanwhile: take it
      throw error;
    }
    if (age <= CLAIM_STALE_MS) return false;
    rmSync(claim, { force: true });
  }
  return false;
}

/** The inode at `path`, or undefined when there is no file. */
function inodeAt(path: string): number | undefined {
  try {
    return lstatSync(path).ino;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Replaces a socket file whose process is dead by a listener of this one, under the claim. The
 * file is removed only if it is still the inode that was probed and still refuses connections
 * (the removal follows the second look with no await between them): the claim keeps another
 * starter out, and this keeps a holder that started without it, or took a stolen claim, alive.
 * Rejects with `refusal` when the lock is, or is being, taken.
 */
async function replaceStale(
  address: string,
  refusal: AlreadyRunning,
  listenOn: ListenFn,
  connect: ConnectFn,
): Promise<net.Server> {
  const probed = inodeAt(address);
  // A socket file outlives a process killed before it could remove it: a connection that is
  // accepted means the holder is alive, one that is refused means the file is stale.
  if (await accepts(address, connect)) throw refusal;
  if (inodeAt(address) !== probed) throw refusal; // the file was replaced under us
  rmSync(address, { force: true });
  try {
    return await listenOn(address);
  } catch (error) {
    // A starter that found no file listened first: it holds the lock.
    throw nameTaken(error) ? refusal : error;
  }
}

/**
 * What `socketLock` may be given: a test passes its own clock, its own `listen` and its own
 * `connect`.
 */
export interface SocketLockDeps {
  readonly now?: () => number;
  readonly listen?: ListenFn;
  readonly connect?: ConnectFn;
}

/**
 * The socket mechanism (Linux, Windows): takes the lock by listening on a local socket in
 * `directory`, so the kernel drops it when the process dies. Rejects with `AlreadyRunning` while
 * another process holds it. Exported so its tests run on macOS too, where `singleInstance`
 * does not use it.
 *
 * The claim is taken before the first `listen`, not only for a recovery: a starter that has bound
 * its socket and not yet called `listen` refuses connections, and a second starter that probed
 * it then would read it as stale and remove it. A start that finds a fresh claim is refused.
 */
export async function socketLock(
  directory: string,
  deps: SocketLockDeps = {},
): Promise<InstanceLock> {
  const { now = Date.now, listen: listenOn = listenLocal, connect = connectLocal } = deps;
  const address = lockAddress(directory);
  const refusal = new AlreadyRunning(`another allaboard is running (lock on ${directory})`);
  // A named pipe is created whole or refused by the system: no claim is needed there.
  const claim = process.platform === "win32" ? null : `${address}.claim`;
  if (claim !== null && !takeClaim(claim, now)) throw refusal;
  try {
    let server: net.Server;
    try {
      server = await listenOn(address);
    } catch (error) {
      if (!nameTaken(error)) throw error;
      // A named pipe vanishes with its process: one in use is always a live holder.
      if (claim === null) throw refusal;
      server = await replaceStale(address, refusal, listenOn, connect);
    }
    if (claim !== null) {
      // The kernel lets only a user with write access connect to a socket, and a new one takes
      // the umask's mode: close it to everyone else right after listening, without touching the
      // process-wide umask.
      try {
        chmodSync(address, 0o600);
      } catch (error) {
        server.close(); // the file is not ours any more: do not run as a holder nobody can reach
        throw error;
      }
    }
    return {
      // libuv unlinks the socket file when the listener closes.
      release: () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error === undefined ? resolve() : reject(error))),
        ),
    };
  } finally {
    if (claim !== null) rmSync(claim, { force: true });
  }
}

/**
 * The macOS mechanism: the lock is the open file description of `directory`, opened with
 * `O_EXLOCK | O_NONBLOCK`, which is `flock(LOCK_EX | LOCK_NB)` on the directory.
 */
async function directoryLock(directory: string): Promise<InstanceLock> {
  let fd: number;
  try {
    fd = openSync(directory, constants.O_RDONLY | O_EXLOCK | constants.O_NONBLOCK);
  } catch (error) {
    const code = errorCode(error);
    if (code === "EAGAIN" || code === "EWOULDBLOCK") {
      throw new AlreadyRunning(`another allaboard is running (lock on ${directory})`);
    }
    throw error;
  }
  let open = true;
  return {
    release: async () => {
      // A second close would close whatever descriptor the number was handed to since.
      if (!open) return;
      open = false;
      closeSync(fd);
    },
  };
}

/**
 * Takes the lock on `directory` by the mechanism of this platform (see the header). Rejects with
 * `AlreadyRunning` while another process holds it.
 */
export function singleInstance(directory: string): Promise<InstanceLock> {
  return process.platform === "darwin" ? directoryLock(directory) : socketLock(directory);
}

/**
 * The folder whose lock stands for `identity` (one of `ChatProvider.identities`): per user and outside
 * every instance's folder. The underscore keeps it apart from them, since an instance name
 * cannot hold one (`core/instance.ts`).
 */
export function identityDirectory(home: string, identity: string): string {
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return join(home, ".config", "allaboard_identities", digest);
}

/**
 * Takes the lock of a chat identity by the mechanism of this platform (see the header), in
 * `identityDirectory(home, identity)`, which it creates private to the owner. Rejects with
 * `ChatIdentityTaken` while another process holds it. Held until `release`, which the daemon
 * calls after its chat has stopped.
 */
export async function chatIdentityLock(identity: string, home: string): Promise<InstanceLock> {
  const directory = identityDirectory(home, identity);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    return await singleInstance(directory);
  } catch (error) {
    throw error instanceof AlreadyRunning ? new ChatIdentityTaken(directory) : error;
  }
}

/**
 * Takes the lock of every key of `ChatProvider.identities`, in order, each by `chatIdentityLock`.
 * A refusal of one releases the ones already taken and rejects with `ChatIdentityTaken`; the
 * returned lock releases them all, last taken first.
 */
export async function chatIdentityLocks(
  identities: readonly string[],
  home: string,
): Promise<InstanceLock> {
  const taken: InstanceLock[] = [];
  const releaseAll = async (): Promise<void> => {
    let failure: unknown = null;
    for (const lock of taken.splice(0).reverse()) {
      try {
        await lock.release();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== null) throw failure;
  };
  try {
    for (const identity of identities) taken.push(await chatIdentityLock(identity, home));
  } catch (error) {
    await releaseAll().catch(() => {});
    throw error;
  }
  return { release: releaseAll };
}

/** The macOS probe: whether an exclusive lock is held on `directory`, by a shared lock taken and let go. */
export async function directoryHeld(directory: string): Promise<boolean> {
  let fd: number;
  try {
    fd = openSync(directory, constants.O_RDONLY | O_SHLOCK | constants.O_NONBLOCK);
  } catch (error) {
    const code = errorCode(error);
    if (code === "EAGAIN" || code === "EWOULDBLOCK") return true;
    if (code === "ENOENT") return false; // nobody has ever updated: there is no folder yet
    throw error;
  }
  closeSync(fd);
  return false;
}

/**
 * The probe of the socket mechanism (Linux, Windows): whether a process accepts connections at
 * the lock's address. Read-only: it takes no claim and removes no file, so a socket left by a dead
 * process is free, and a holder drops the connection at once. Exported so its tests run on macOS.
 */
export async function socketHeld(
  directory: string,
  connect: ConnectFn = connectLocal,
): Promise<boolean> {
  let address: string;
  try {
    address = lockAddress(directory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false; // Windows resolves the folder to name its pipe
    throw error;
  }
  return accepts(address, connect);
}

/**
 * Whether a process, this one included, holds the machine's update lock now (see the header):
 * false for a machine where no update ever ran. Rejects for what it cannot tell, an error of
 * the system; the caller decides what that means.
 */
export function updateHeld(home: string): Promise<boolean> {
  const directory = updateDirectory(home);
  return process.platform === "darwin" ? directoryHeld(directory) : socketHeld(directory);
}

/**
 * Another process is updating allaboard on this machine: two installs into one npm prefix would
 * race, so the instances of a machine update one at a time.
 */
export class UpdateUnderWay extends AlreadyRunning {
  constructor(directory: string) {
    super(`an update of allaboard is already under way (lock on ${directory})`);
    this.name = "UpdateUnderWay";
  }
}

/**
 * The folder whose lock stands for an update: one per user and outside every instance's folder,
 * beside the identities'. The underscore keeps it apart from an instance's, as for them.
 */
export function updateDirectory(home: string): string {
  return join(home, ".config", "allaboard_update");
}

/**
 * How long an update's take tries again before it reports an update under way: a probe
 * (`updateHeld`) holds a shared lock for microseconds, and an exclusive take that meets one is
 * refused like one that meets a holder. 20 tries 10 ms apart.
 */
export const UPDATE_TAKE_TRIES = 20;
export const UPDATE_TAKE_PAUSE_MS = 10;

/**
 * Takes the lock of the machine's update by the mechanism of this platform (see the header), in
 * `updateDirectory(home)`, which it creates private to the owner. Tries `UPDATE_TAKE_TRIES` times,
 * `UPDATE_TAKE_PAUSE_MS` apart (about 200 ms) before it rejects with `UpdateUnderWay`, so that a
 * daemon's probe never makes it fail. Held until `release`; the kernel drops it with a process
 * that dies on macOS.
 */
export async function updateLock(home: string): Promise<InstanceLock> {
  const directory = updateDirectory(home);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await singleInstance(directory);
    } catch (error) {
      if (!(error instanceof AlreadyRunning)) throw error;
      if (attempt === UPDATE_TAKE_TRIES) throw new UpdateUnderWay(directory);
    }
    await new Promise((resolve) => setTimeout(resolve, UPDATE_TAKE_PAUSE_MS));
  }
}
