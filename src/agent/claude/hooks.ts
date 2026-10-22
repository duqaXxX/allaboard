/**
 * The inputs of the three hooks the daemon registers, into session events.
 *
 * The Stop hook's input carries the effort level Claude Code runs at: the footer's only source
 * for it, since no message reports it. Every hook input carries the `cwd` the session works in;
 * PostToolUse reports it after each tool, so a turn stopped or failed before its Stop still
 * moves the footer's branch. PostModelSwitch reports a model change before the command's result,
 * while the context usage still names the model before it.
 */

import { isRecord } from "../../values.ts";
import type { ScheduledJob, SessionEvent } from "../seam.ts";
import { string, words } from "./wire.ts";

function folderChanged(input: unknown): SessionEvent[] {
  const folder = isRecord(input) ? words(input.cwd) : null;
  return folder === null ? [] : [{ type: "folder_changed", folder }];
}

/** One entry of `session_crons`, or null when it is not a job (`SessionCronSummary`). */
function scheduledJob(entry: unknown): ScheduledJob | null {
  if (!isRecord(entry)) return null;
  const id = words(entry.id);
  const schedule = words(entry.schedule);
  const prompt = string(entry.prompt);
  if (id === null || schedule === null || prompt === null || typeof entry.recurring !== "boolean") {
    return null;
  }
  return { id, schedule, recurring: entry.recurring, prompt };
}

/**
 * The Stop input's `session_crons` as one event, `[]` included. No event when the input holds no
 * list: a CLI that does not report them says nothing of them, which is not "none".
 */
function scheduledJobs(input: unknown): SessionEvent[] {
  if (!isRecord(input) || !Array.isArray(input.session_crons)) return [];
  const jobs = input.session_crons.map(scheduledJob).filter((job) => job !== null);
  return [{ type: "scheduled_jobs", jobs }];
}

/**
 * A Stop hook's input: the effort the session runs at, the jobs it has scheduled, then its
 * folder. The effort is always said: `effort` is in the CLI's Stop input since Claude Code
 * 2.1.280 and absent when the model takes no effort parameter, which reads as null. The jobs are
 * said whenever the input lists them (measured 2026-10-19, CLI 2.1.302: after the turn that set
 * a loop up and after every run).
 */
export function stopHookEvents(input: unknown): SessionEvent[] {
  const effort = isRecord(input) && isRecord(input.effort) ? input.effort : {};
  return [
    { type: "effort_observed", level: string(effort.level) },
    ...scheduledJobs(input),
    ...folderChanged(input),
  ];
}

/** A PostToolUse hook's input: the folder the session works in after the tool. */
export function postToolUseHookEvents(input: unknown): SessionEvent[] {
  return folderChanged(input);
}

/**
 * A PostModelSwitch hook's input: the model the session runs after the switch. Every `source`
 * counts (command, picker, sdk, auto, resume): each is a change of the model the footer names,
 * and the one the daemon's own `setModel` makes is true as well.
 */
export function postModelSwitchHookEvents(input: unknown): SessionEvent[] {
  const model = isRecord(input) ? words(input.to_model) : null;
  return model === null ? [] : [{ type: "model_changed", model }];
}
