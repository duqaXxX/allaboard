/** One prompt and its reply, the turn that is running, and the notes about prompts that never ran. */
import { randomUUID } from "node:crypto";
import type { PromptContent } from "../../agent/seam.ts";
import type { Reply } from "../../chat/seam.ts";
import { blank } from "../../text.ts";
import type { TurnRenderer } from "../reply/renderer.ts";
import { oneLine } from "../reply/words.ts";
import * as texts from "../texts.ts";
import { ASKED_LIMIT, NOT_SENT_START } from "./constants.ts";
import { Event } from "./tasks.ts";

export class Turn {
  readonly prompt: PromptContent;
  sink: Reply;
  readonly done = new Event();
  /** The daemon's own id for the prompt, which the agent names when it takes it. */
  readonly uuid: string = randomUUID();

  constructor(prompt: PromptContent, sink: Reply) {
    this.prompt = prompt;
    this.sink = sink;
  }
}

export interface ActiveTurn {
  /** Null for a turn the agent started itself, to report a task. */
  readonly turn: Turn | null;
  readonly renderer: TurnRenderer;
  /**
   * Prompts whose replay arrived while this turn ran: the agent took them into it. When the
   * turn's `turn_ended` says the agent started it, `ThreadSession.finish` releases them
   * (`ThreadSession.settle`: out of `sent`, `Turn.done` set) and adds the note
   * `texts.TAKEN_INTO_REPLY_ONE` to the reply, through the same end notes as a restart's
   * `N messages were not sent`. A prompt whose replay did not come during the turn waits for its
   * own turn. An `AgentSession.interrupt` with such a prompt queued ends a report turn with
   * `error_during_execution`, and the prompt then runs as a turn of its own. A prompt already
   * taken in when `!stop` ends the turn with a result the agent started is released with the
   * note like any other (not measured: what Claude Code does with it on an interrupt). If the
   * session is abandoned first (`ThreadSession.abandon`: a lost process, a close, a restart), the
   * prompt is listed among the messages not sent, whether or not Claude Code had taken it in;
   * its replay is not kept.
   */
  readonly taken: Turn[];
  /**
   * Set by `ThreadSession.finish` when a close cancelled it before the reply was closed out: the
   * turn is then left unsettled, for `abandon` to end. The turn's result had arrived by then: its
   * answer is whole, and only the reply's footer is missing.
   */
  cut: boolean;
  /** With `cut`: the prompts the turn's result released (`taken`, for a turn the agent started). */
  released: readonly Turn[];
  /** With `cut`: the note about `released` was already handed to the reply. */
  takenNoted: boolean;
  /**
   * With `cut`: the owner's prompt this turn was opened for, when the result that ended it was a
   * report's and did not release it. A normal end sends it back to wait for a turn of its own.
   */
  unanswered: Turn | null;
  /** A scheduled run: its words go to the loop card and it touches neither status nor footer. */
  readonly run: boolean;
  /** When the turn began, epoch milliseconds: a run is dated and timed from it. */
  readonly startedAt: number;
}

/** The owner's question on one line, as a note about a message that was not sent quotes it. */
export function asked(prompt: PromptContent): string {
  const text =
    typeof prompt === "string"
      ? prompt
      : prompt
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(" ");
  return blank(text) ? texts.PROMPT_IMAGE : oneLine(text, ASKED_LIMIT);
}

/**
 * The note that names turns that will never be sent: how many, why, and the start of each, so
 * the owner knows which to send again.
 */
export function notSent(turns: readonly Turn[], because: string): string {
  const header = texts.fill(turns.length === 1 ? texts.NOT_SENT_ONE : texts.NOT_SENT_MANY, {
    count: turns.length,
    because,
  });
  const starts = turns.map((turn) => `- "${oneLine(asked(turn.prompt), NOT_SENT_START)}"`);
  return [header, ...starts].join("\n");
}

/** The note for the reply a turn that took `count` prompts into itself ends with. */
export function takenNote(count: number, names: texts.Names): string {
  const note = count === 1 ? texts.TAKEN_INTO_REPLY_ONE : texts.TAKEN_INTO_REPLY_MANY;
  return texts.fill(texts.named(note, names), { count });
}
