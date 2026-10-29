/**
 * A recorded SDK stream as the session events the core reads: the records of a recording through
 * the Claude back end's `Translator`, as one live session would give them.
 *
 * The events are cut in turns after each `turn_ended`: a result record gives that one event, and
 * every other record's events stay in its turn. A stretch of records after the last result is a
 * turn when it gave an event.
 */
import { goalChange } from "../../src/agent/claude/goals.ts";
import { Translator } from "../../src/agent/claude/translate.ts";
import type { SessionEvent, SessionEventType } from "../../src/agent/seam.ts";
import { type JsonObject, sdkJson, sdkRecords } from "./fixtures.ts";

export type EventOf<T extends SessionEventType> = Extract<SessionEvent, { type: T }>;

/** The events of `records`, in order, by one translator: pass it to go on with its memory. */
export function translated(
  records: readonly unknown[],
  translator: Translator = new Translator(),
): SessionEvent[] {
  return records.flatMap((record) => translator.translate(record));
}

/**
 * The events of a recording, by one translator, as one session would see them. `sent` are the
 * ids of the prompts the daemon sent: a record that replays one of them is `prompt_taken`.
 */
export function recordedEvents(name: string, sent: readonly string[] = []): SessionEvent[] {
  const translator = new Translator();
  for (const promptId of sent) translator.promptSent(promptId);
  return translated(sdkRecords(name), translator);
}

/**
 * The events of `goal-lifecycle`, with the goal's changes its transcript held, each where it was
 * written: before the stream record its line came ahead of (recorded as a session store's appends).
 */
export function goalLifecycleEvents(): SessionEvent[] {
  const appends = sdkJson("goal-lifecycle-store") as Array<{
    before: number;
    entries: JsonObject[];
  }>;
  const translator = new Translator();
  return sdkRecords("goal-lifecycle").flatMap((record, index) => [
    ...appends
      .filter((append) => append.before === index)
      .flatMap((append) => append.entries.map(goalChange))
      .flatMap((goal): SessionEvent[] => (goal === null ? [] : [{ type: "goal_changed", goal }])),
    ...translator.translate(record),
  ]);
}

/** The turns of a stream of events: cut after each end of turn. */
export function splitTurns(events: readonly SessionEvent[]): SessionEvent[][] {
  const turns: SessionEvent[][] = [[]];
  for (const event of events) {
    turns.at(-1)?.push(event);
    if (event.type === "turn_ended") turns.push([]);
  }
  return turns.filter((turn) => turn.length > 0);
}

/** The events of one type, in order. */
export function eventsOf<T extends SessionEventType>(
  events: readonly SessionEvent[],
  type: T,
): EventOf<T>[] {
  return events.filter((event): event is EventOf<T> => event.type === type);
}
