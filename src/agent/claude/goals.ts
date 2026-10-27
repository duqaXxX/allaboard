/**
 * A session's goal (`/goal`), read off the transcript Claude Code mirrors to a session store.
 *
 * The query's stream says when a goal is set (the command's `Goal set:` text) and when a check
 * fails (a `Stop hook feedback` user record), never when one is achieved or cleared, and
 * `active_goal`, which `sdk.d.ts` declares, never reaches it (measured 2026-10-20, SDK 0.3.304). The terminal reads a `goal_status` attachment for each change, and an
 * `Options.sessionStore` with `sessionStoreFlush: 'eager'` receives the same entries as they are
 * written. `SessionStoreEntry` is declared opaque ("CLI-internal"): the shape below was read off
 * real entries, recorded in `test/fixtures/sdk/goal-lifecycle-store.json`.
 *
 * The same store carries the one account of what the owner's stop hooks said at a turn's end,
 * which the terminal draws from it: the `stop_hook_summary` entry. The stream says at most a
 * refusal's words (a `Stop hook feedback` user record), never how many hooks ran, an added context
 * or why a hook stopped the session (measured 2026-10-27, SDK 0.3.310,
 * `test/fixtures/sdk/stop-hook-block-store.json`).
 */

import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";
import { isRecord } from "../../values.ts";
import type { GoalChange, SavedMessage, SessionEvent } from "../seam.ts";
import { integer, words } from "./wire.ts";

/**
 * The command, without the slash, that drops a session's goal: it answers `Goal cleared:
 * <condition>`, or `No goal set` (measured 2026-10-20, Claude Code 2.1.304).
 */
export const GOAL_CLEAR = "goal clear";

/**
 * A `goal_status` attachment as a change, or null for any other entry. `sentinel` marks the
 * entries of the command: the goal set (`met` false) and the goal cleared (`met` true). Without
 * it, `met` false is a check that failed and `met` true the goal achieved, with its counts.
 */
export function goalChange(entry: unknown): GoalChange | null {
  if (!isRecord(entry) || entry.type !== "attachment" || !isRecord(entry.attachment)) return null;
  const status = entry.attachment;
  const condition = words(status.condition);
  if (status.type !== "goal_status" || condition === null || typeof status.met !== "boolean") {
    return null;
  }
  if (status.sentinel === true) return { state: status.met ? "cleared" : "set", condition };
  if (!status.met) return { state: "not_met", condition };
  return {
    state: "achieved",
    condition,
    turns: integer(status.iterations),
    durationMs: integer(status.durationMs),
    tokens: integer(status.tokens),
  };
}

/** The strings of `value` that say something, when it is a list; `[]` otherwise. */
function sayings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(words).filter((said) => said !== null) : [];
}

/**
 * A `stop_hook_summary` entry as the event, or null for any other entry and for a summary that
 * says nothing. Claude Code writes one after every Stop with output, a goal's check included, with
 * no error, no added context and nothing stopped (measured 2026-10-27 on real transcripts): the
 * terminal draws a summary only with one of the three, and so does this. The count leaves out the
 * daemon's own Stop callback, which a terminal session does not run and the entry lists as
 * `callback`.
 */
export function stopHookSummary(entry: unknown): SessionEvent | null {
  if (!isRecord(entry) || entry.type !== "system" || entry.subtype !== "stop_hook_summary") {
    return null;
  }
  const count = integer(entry.hookCount);
  const errors = sayings(entry.hookErrors);
  const context = sayings(entry.hookAdditionalContext);
  const stopped = entry.preventedContinuation === true;
  if (count === null || (errors.length === 0 && context.length === 0 && !stopped)) return null;
  const callbacks = Array.isArray(entry.hookInfos)
    ? entry.hookInfos.filter((info) => isRecord(info) && info.command === "callback").length
    : 0;
  return {
    type: "stop_hooks_ran",
    hooks: Math.max(count - callbacks, 0),
    stopReason: stopped ? words(entry.stopReason) : null,
    errors,
    context,
  };
}

/**
 * A user or assistant entry of the conversation as the message it saves, or null for any other
 * entry. Each carries its `uuid` and an ISO `timestamp`, as on disk (read off the entries of
 * `test/fixtures/sdk/message-store.json`, recorded 2026-10-27, SDK 0.3.310).
 */
export function savedMessage(entry: unknown): SavedMessage | null {
  if (!isRecord(entry) || (entry.type !== "user" && entry.type !== "assistant")) return null;
  if (typeof entry.uuid !== "string" || typeof entry.timestamp !== "string") return null;
  const at = Date.parse(entry.timestamp);
  return Number.isNaN(at) ? null : { id: entry.uuid, at };
}

/**
 * The store a session is given: it keeps nothing, and hands each goal change and each account of
 * the stop hooks of the main transcript to `deliver` (a subagent's transcript has a `subpath`),
 * and the last message of each batch the session saved (what `turnsAfter` reads after). `load`
 * answers that nothing was stored, and a resume then reads the transcript Claude Code keeps on
 * disk (measured 2026-10-20, SDK 0.3.304; the contract of `load` does not say).
 */
export function goalStore(deliver: (event: SessionEvent) => void): SessionStore {
  return {
    append: async (key, entries) => {
      if (key.subpath !== undefined) return;
      let saved: SavedMessage | null = null;
      for (const entry of entries) {
        const goal = goalChange(entry);
        if (goal !== null) deliver({ type: "goal_changed", goal });
        const hooks = stopHookSummary(entry);
        if (hooks !== null) deliver(hooks);
        saved = savedMessage(entry) ?? saved;
      }
      if (saved !== null) deliver({ type: "message_saved", message: saved });
    },
    load: async () => null,
  };
}
