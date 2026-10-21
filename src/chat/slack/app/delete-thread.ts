/**
 * `!delete-thread` as the Slack provider hears it: a question only the owner sees, under their
 * word in the thread, with Delete thread and Cancel. The thread is deleted by the Home tab's own
 * deleter (`ThreadDeleter.delete`), so both ways share one path and one rule.
 *
 * The question is ephemeral: nothing of it is left to delete or to store. A click on it carries
 * `response_url` and `container.is_ephemeral`, and no `message` (measured 2026-10-19 on bolt
 * 5.1.0), so the thread is read from the container (`clickThread`). Either button takes the
 * question away with `respond({ delete_original: true })`: `chat.update` cannot edit an
 * ephemeral message (chat.update reference, read 2026-10-19), and a question rewritten instead
 * stays in the channel's view once its thread is gone, until a reload (measured 2026-10-19).
 */
import { fill, type Names, named, texts } from "../../../core/port.ts";
import { type DeleteRefusal, type PinnedRefusal, pinnedLine } from "../delete.ts";
import { deleteThreadBlocks } from "../delete-thread.ts";
import { describe } from "../reply/errors.ts";
import * as slackTexts from "../texts.ts";
import { type Answers, type AppParts, logger } from "./answers.ts";
import { interactionActor } from "./guards.ts";
import { type Ack, clickThread, type Payload, type Respond, record, text } from "./wire.ts";

/** The line, under the owner's word, for a delete that left the thread. */
function deleteLine(refusal: DeleteRefusal, names: Names): string {
  switch (refusal.reason) {
    case "busy":
      return texts.DELETE_THREAD_BUSY;
    case "pinned":
      return pinnedLine(refusal, names);
    case "refused":
      return fill(named(slackTexts.THREAD_DELETE_REFUSED, names), { count: refusal.count });
    case "failed":
      return fill(slackTexts.THREAD_DELETE_FAILED, { error: refusal.error });
  }
}

export class DeleteThread {
  private readonly parts: AppParts;
  private readonly answers: Answers;

  constructor(parts: AppParts, answers: Answers) {
    this.parts = parts;
    this.answers = answers;
  }

  /**
   * Shows the owner alone the question, in the thread; resolves once it is posted. A pinned
   * thread gets the refusal's line instead: the question is not asked of what is not deleted.
   */
  async ask(channel: string, threadTs: string): Promise<void> {
    const pinned = await this.pinned(channel, threadTs);
    if (pinned !== null) {
      await this.answers.tellOwner(channel, threadTs, pinnedLine(pinned, this.parts.names));
      return;
    }
    await this.answers.deliver(
      channel,
      threadTs,
      slackTexts.HOME_DELETE_TITLE,
      deleteThreadBlocks(this.parts.names),
      { ephemeral: true },
    );
  }

  /**
   * The refusal for a thread with a pinned message, else null. A thread that cannot be read is no
   * refusal: the question is shown, and `ThreadDeleter.delete` reads it again on the owner's yes.
   */
  private async pinned(channel: string, threadTs: string): Promise<PinnedRefusal | null> {
    try {
      return (await this.parts.deletion?.pinned(channel, threadTs)) ?? null;
    } catch (error) {
      logger.warning(`could not read whether ${channel}/${threadTs} is pinned: ${describe(error)}`);
      return null;
    }
  }

  /** Delete thread: the question goes, then the thread; a delete that stopped says why. */
  onConfirm = async (ack: Ack, body: Payload, respond?: Respond): Promise<void> => {
    const where = await this.admitted(ack, body);
    if (where === null) return;
    const [channel, threadTs] = where;
    const { deletion, chat, names } = this.parts;
    if (deletion === undefined) {
      // A question left from a run that had the owner's token: it stays, and says why.
      await this.answers.tellOwner(
        channel,
        threadTs,
        named(texts.DELETE_THREAD_UNAVAILABLE, names),
      );
      return;
    }
    await this.withdraw(respond);
    const refusal = await deletion.delete(channel, threadTs);
    // A thread that is gone needs no line, and its removal from `state.json` refreshes the Home.
    // One still there says why, and its root is read again: the delete may have stopped half way.
    if (refusal === null) return;
    chat.index?.refresh([{ channel, thread: threadTs }]);
    await this.answers.tellOwner(channel, threadTs, deleteLine(refusal, names));
  };

  /** Cancel: the question goes, and nothing else changes. */
  onCancel = async (ack: Ack, body: Payload, respond?: Respond): Promise<void> => {
    if ((await this.admitted(ack, body)) !== null) await this.withdraw(respond);
  };

  /** Acknowledges, then the channel and the thread of the owner's click; null for anyone else's. */
  private async admitted(ack: Ack, body: Payload): Promise<[string, string] | null> {
    await ack();
    const [user, team] = interactionActor(body);
    const channel = text(record(body.channel).id);
    const threadTs = clickThread(body);
    if (!(await this.answers.admitted(user, team, channel, threadTs)) || channel === null) {
      return null;
    }
    return [channel, threadTs];
  }

  /** Takes the question away. A failure leaves it showing until a reload, and is logged. */
  private async withdraw(respond: Respond | undefined): Promise<void> {
    if (respond === undefined) return; // a click with no `response_url`: nothing to answer
    try {
      await respond({ delete_original: true });
    } catch (error) {
      logger.warning(`could not take back the delete question: ${describe(error)}`);
    }
  }
}
