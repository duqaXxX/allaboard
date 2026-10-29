/**
 * Waiting for the daemon to come to rest: the real work (a file call, a `git` process) a turn of
 * the event loop does not finish. Agent-neutral, so the tests of the core and the chat use it
 * without the Claude harness of `sessions.ts`.
 */
import { FakeClock } from "./fake-clock.ts";

export const WRITES = [
  "chat.postMessage",
  "chat.startStream",
  "chat.appendStream",
  "chat.stopStream",
  "chat.update",
] as const;

// The work of the daemon that a turn of the event loop does not finish: a file call and the
// close of its handle, a git process and its pipes. The test runner's own pipes are there from
// the start, so what counts is what is in flight beyond them.
const REAL_WORK = new Set([
  "FSReqPromise",
  "FSReqCallback",
  "CloseReq",
  "ProcessWrap",
  "PipeWrap",
  "WriteWrap",
  "ShutdownWrap",
]);

function realWorkInFlight(): number {
  return process.getActiveResourcesInfo().filter((name) => REAL_WORK.has(name)).length;
}

const AT_REST = realWorkInFlight();
// Turns of the event loop with no real work in flight before the daemon counts as at rest.
const CALM_TURNS = 5;
// The footer's own limit on its `git` is 5 seconds; past this a stuck resource is not waited for.
const REAL_WORK_LIMIT_MS = 10_000;

/**
 * What a running daemon keeps open for as long as it runs, and so is no work in flight: outside
 * macOS each of its locks is a listening socket or pipe (`src/core/lock.ts`), the instance's and
 * one per key of its chat identity (`ChatProvider.identities`), and the machine's update lock
 * while it installs (`updating`). On macOS a lock is a `flock` on a folder, which holds nothing
 * open that counts as work.
 */
export function heldByARunningDaemon(identityKeys: number, updating = false): number {
  return process.platform === "darwin" ? 0 : 1 + identityKeys + (updating ? 1 : 0);
}

/**
 * Wait until no real work started by the daemon is in flight (a file call, a `git` process): it
 * answers on the operating system's time, so under load it outlasts any fixed number of turns.
 * Returns at once when nothing is in flight. `held` counts what stays open on purpose while the
 * caller's daemon runs (`heldByARunningDaemon`), which would otherwise be waited for until
 * the limit, every time.
 */
export async function realWorkDone(held = 0): Promise<void> {
  const deadline = Date.now() + REAL_WORK_LIMIT_MS;
  let calm = 0;
  while (calm < CALM_TURNS && Date.now() < deadline) {
    if (realWorkInFlight() > AT_REST + held) {
      calm = 0;
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    } else {
      calm += 1;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

/**
 * One turn of the event loop, then whatever real work it set going: what a test waits between
 * two looks at the daemon. A count of bare turns is not a wait: a file call outlasts any number
 * of them on a loaded machine.
 */
export async function settledTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await realWorkDone();
}

/**
 * A fake clock whose `advance` returns once the real work it set going is done: a timer that
 * fires into an end of turn starts the footer's `git`, and a test that advances a clock and
 * then asserts the end state would otherwise race the operating system.
 */
export class SettledClock extends FakeClock {
  override async advance(seconds: number): Promise<void> {
    await super.advance(seconds);
    await realWorkDone();
  }
}
