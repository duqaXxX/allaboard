/**
 * Going back in a session: the prompts the owner can return to, the point a truncating resume
 * starts from, and the files a restore changes. Read from `getSessionMessages` and from the
 * SDK's `RewindFilesResult`, as recorded on Claude Code 2.1.312 with the SDK 0.3.312 on
 * 2026-10-29 (`test/fixtures/sdk/session-messages-rewind.json`, `rewind-files.json`).
 */
import type { RewindFilesResult, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { FilesRestore, RewindPoint } from "../seam.ts";
import { isCommandRecord, promptOf } from "./turns.ts";

/**
 * The prompts of a conversation, oldest first, with the id each was sent under. A slash command is
 * no prompt: it has no checkpoint and nothing to go back to.
 */
export function rewindPoints(messages: readonly SessionMessage[]): RewindPoint[] {
  return messages
    .flatMap((message) => {
      const text = promptOf(message);
      return text === null || isCommandRecord(message) ? [] : [{ id: message.uuid, text }];
    })
    .map((point) => ({
      ...point,
      // The first prompt has no earlier entry to resume at (`rewindStart`).
      conversation: rewindStart(messages, point.id) !== null,
    }));
}

/** Where a resume starts so that the prompt `promptId` and all after it are dropped. */
export interface RewindStart {
  /** The last entry of the conversation that is kept. */
  readonly at: string;
  /** The prompt the cut drops when it is the last turn, for the SDK to check the range; else none. */
  readonly drops?: string;
}

/**
 * The resume point for dropping `promptId` and everything after it; null for a prompt the
 * conversation does not hold, and for its first: nothing precedes it to resume at (the rewind to
 * it would need a new session, measured on 2026-10-29).
 *
 * The point is the entry just before the prompt among those the caller read; the SDK says to
 * fork at the kept turn's last chain entry, whatever it is. `getSessionMessages` lists user,
 * assistant and (asked to) system entries only, so an attachment or the marker of an interrupted
 * turn after the kept turn's last listed entry is out of sight: the cut then sits before it. An
 * unguarded cut drops it with the rest; under the guard the SDK may refuse the range, which the
 * caller tells as a refused rewind.
 *
 * The SDK's guard (`resumeDropsTurn`) accepts exactly one turn: it is declared only when no
 * prompt follows, as a safety net; a wider cut goes unguarded (measured on 2026-10-29: the guard
 * refused a range of two turns, the unguarded cut dropped them with the session id kept).
 */
export function rewindStart(
  messages: readonly SessionMessage[],
  promptId: string,
): RewindStart | null {
  const index = messages.findIndex(
    (message) => message.uuid === promptId && promptOf(message) !== null,
  );
  const before = messages[index - 1];
  if (index < 1 || before === undefined) return null;
  const later = messages.slice(index + 1).some((message) => promptOf(message) !== null);
  return later ? { at: before.uuid } : { at: before.uuid, drops: promptId };
}

/** The seam's account of a `rewindFiles` result. */
export function filesRestore(result: RewindFilesResult): FilesRestore {
  return {
    possible: result.canRewind,
    reason: result.canRewind ? null : (result.error ?? "the agent cannot restore the files"),
    files: result.filesChanged ?? [],
    insertions: result.insertions ?? 0,
    deletions: result.deletions ?? 0,
    skipped: result.skippedLinks ?? 0,
  };
}
