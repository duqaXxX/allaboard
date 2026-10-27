/**
 * The question that holds the owner's message: the same-folder hold, the session's setup and
 * the confirmation of a shell command.
 * It is shown through the chat seam, waits on a `Holds` entry that only the owner's answer, a
 * `!stop` or a drain settles, and ends with the message sent or not.
 */
import type { ModelInfo } from "../../agent/seam.ts";
import type {
  HoldRequest,
  MessageId,
  SetupRequest,
  ShellRequest,
  TerminalRequest,
  ThreadRef,
} from "../../chat/seam.ts";
import { errorName } from "../../values.ts";
import type { HoldAnswer, HoldKind, Pending } from "../hold.ts";
import type { ThreadSession } from "../sessions/session.ts";
import type { RequestKind } from "../state.ts";
import * as texts from "../texts.ts";
import { named } from "../texts.ts";
import { type FlowDeps, isCancelled, logger, type Talk } from "./talk.ts";

/** What applies an answer while its hold is still open (`askOwner`). */
export type Settle = (answer: HoldAnswer, shownAt: MessageId, pending: Pending) => Promise<void>;

/** The question to put: what to show, and what to do with the answer. */
export interface Question {
  /** Which answer settles it; stored beside the message for the crash repair (`recorded`). */
  readonly kind: HoldKind;
  /** The request, given the id only its answer carries. */
  readonly request: (
    requestId: string,
  ) => HoldRequest | SetupRequest | ShellRequest | TerminalRequest;
  /**
   * The line the question becomes once answered, sent or not, in place of being removed: an
   * edit, which notifies nobody. The owner is then not told `Not sent.` apart. A question a
   * `!stop` or a drain removed is not rewritten.
   */
  readonly ends?: { readonly sent: string; readonly cancelled: string };
  /** The request in one line. */
  readonly title: string;
  readonly settle?: Settle;
  /** What comes back with an answer that carries only the id. */
  readonly context?: readonly ModelInfo[];
}

/**
 * Put a question that holds the owner's message and wait for the answer: whatever the owner
 * answered, or null when it was cancelled (`!stop`, a drain) or never shown (`Not sent.` or the
 * unposted notice, told already). `settle(answer, shownAt, pending)` applies an answer and
 * writes its summary while the thread still shows it waiting and the hold is still open, so a
 * `!stop` or drain meanwhile cancels (`Pending.cancelled`: nothing is sent, the message is
 * removed, `Not sent.`). When it throws, the message is removed, the hold ends as a cancel would
 * and the error goes on.
 */
export async function askOwner(
  deps: FlowDeps,
  talk: Talk,
  ref: ThreadRef,
  session: ThreadSession,
  question: Question,
): Promise<HoldAnswer | null> {
  const { sessions, holds, state } = deps;
  // (sync) The check and the hold it guards: a drain cancels every hold open when it starts
  // and never one opened after, so nothing is awaited between the two.
  if (talk.stopped) return null;
  if (sessions.draining) {
    // a restart could have started during an await before this
    await talk.refuseRestarting(ref);
    return null;
  }
  const [holdId, pending] = holds.open(
    ref.channel,
    ref.thread,
    question.context ?? null,
    question.kind,
  );
  let shownAt: MessageId;
  try {
    shownAt = await talk.thread(ref).ask(holdId, question.request(holdId), question.title);
  } catch (error) {
    if (isCancelled(error)) throw error;
    // Nobody can answer a question that was never shown: fail closed, as an unpostable
    // approval does, rather than send into a folder another session is using.
    logger.error(`could not post a hold in ${ref.channel}/${ref.thread}: ${errorName(error)}`);
    holds.discard(holdId);
    await talk.tell(ref, named(texts.HOLD_UNPOSTED, deps.names));
    return null;
  }
  // False when the answer came before `ask` returned (a fast answer, `!stop`, a drain): nobody
  // knew the message then, so it is still ours to settle or remove, and `holdStart`/`holdEnd`
  // (and the waiting status they hold) never run for it.
  const waiting = holds.posted(holdId, shownAt);
  if (waiting) {
    // Crash repair: a hold question is a request like an approval. Best-effort:
    // outside the try/finally below on purpose, so a failed write here can never skip
    // `holdStart`/`holdEnd` and leave the hold itself undiscarded; the message is already
    // live either way, so a failure is logged loudly.
    try {
      state.addRequest(ref.channel, ref.thread, shownAt, recorded(question));
    } catch (error) {
      logger.error(
        `posted a hold in ${ref.channel}/${ref.thread} that state.json could not record: ${errorName(error)}`,
      );
    }
  }
  let answer: HoldAnswer | null = null;
  let sent = false;
  try {
    if (waiting) session.holdStart();
    answer = await pending.answer;
    if (answer === null) {
      if (!waiting) await talk.removeRequest(ref, shownAt);
    } else if (question.settle !== undefined) {
      try {
        await question.settle(answer, shownAt, pending);
      } catch (error) {
        if (isCancelled(error)) throw error;
        if (!pending.cancelled) {
          await talk.removeRequest(ref, shownAt);
          throw error;
        }
        logger.warning(
          `a cancelled hold in ${ref.channel}/${ref.thread} failed while applied: ${errorName(error)}`,
        );
      }
    }
    if (pending.cancelled) {
      answer = null;
      if (!waiting) await talk.removeRequest(ref, shownAt);
    }
    sent = answer !== null;
  } finally {
    if (waiting) await session.holdEnd({ continued: sent });
    holds.discard(holdId); // catches a cancelled wait, and ends an answered hold
  }
  if (question.ends !== undefined && !pending.cancelled) {
    await endQuestion(
      deps,
      talk,
      ref,
      shownAt,
      sent ? question.ends.sent : question.ends.cancelled,
    );
    return answer;
  }
  if (answer === null) await talk.tell(ref, texts.NOT_SENT);
  return answer;
}

/** The kind `state.json` records for a question: a terminal's question is withdrawn like a hold. */
function recorded(question: Question): RequestKind {
  return question.kind === "terminal" ? "hold" : question.kind;
}

/** Rewrite an answered question into `line` and forget it for the crash repair; never throws. */
async function endQuestion(
  deps: FlowDeps,
  talk: Talk,
  ref: ThreadRef,
  shownAt: MessageId,
  line: string,
): Promise<void> {
  if (talk.stopped) return;
  try {
    await talk.thread(ref).rewrite(shownAt, line);
  } catch (error) {
    if (isCancelled(error)) throw error;
    logger.warning(`could not rewrite an answered question in ${ref.channel}: ${errorName(error)}`);
  }
  try {
    deps.state.removeRequest(ref.channel, ref.thread, shownAt);
  } catch (error) {
    logger.warning(
      `could not clear an answered question from state.json in ${ref.channel}: ${errorName(error)}`,
    );
  }
}
