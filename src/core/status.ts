/**
 * The session's status as the owner is told of it: which change of the root's status ends the
 * session's work.
 */
import type { SessionStatus } from "../chat/seam.ts";

/**
 * Whether the root's status going from `previous` to `next` ends the session's work: from working
 * or waiting to done or error. A change into the status already shown ends nothing, so the many
 * ways a session reaches its end (a turn's end, a report, a close, a restart) tell the owner
 * once.
 */
export function endsWork(previous: SessionStatus | null, next: SessionStatus | null): boolean {
  const going = previous === "working" || previous === "waiting";
  return going && (next === "done" || next === "error");
}
