/**
 * `!clean-channel` as the Slack provider hears it: a question only the owner sees, in the channel, with
 * Clean up and Cancel. The channel is cleaned by the Home tab's own deleter
 * (`ThreadDeleter.clean`), so both ways share one path and one rule. As with `!delete-thread`, the
 * question is ephemeral and either button takes it away with `respond({ delete_original: true })`.
 */

import { named, texts } from "../../../core/port.ts";
import { cleanChannelBlocks } from "../clean-channel.ts";
import * as slackTexts from "../texts.ts";
import type { Answers, AppParts } from "./answers.ts";
import { interactionActor } from "./guards.ts";
import { type Ack, type Payload, type Respond, record, text } from "./wire.ts";

/** The question's own id: it has no thread, so what is said about it goes to the channel. */
function questionOf(body: Payload): string {
  return text(record(body.container).message_ts) ?? "";
}

export class CleanChannel {
  private readonly parts: AppParts;
  private readonly answers: Answers;

  constructor(parts: AppParts, answers: Answers) {
    this.parts = parts;
    this.answers = answers;
  }

  /** Shows the owner alone the question, in the channel; resolves once it is posted. */
  async ask(channel: string): Promise<void> {
    await this.answers.deliver(channel, null, slackTexts.HOME_CLEAN_TITLE, cleanChannelBlocks(), {
      ephemeral: true,
    });
  }

  /** Clean up: the question goes, then the messages; a clean up that stopped says why. */
  onConfirm = async (ack: Ack, body: Payload, respond?: Respond): Promise<void> => {
    const channel = await this.admitted(ack, body);
    if (channel === null) return;
    const question = questionOf(body);
    const { deletion, names } = this.parts;
    if (deletion === undefined) {
      // A question left from a run that had the owner's token: it stays, and says why.
      const line = named(texts.CLEAN_UNAVAILABLE, names);
      await this.answers.tellOwnerAbout(channel, question, question, line);
      return;
    }
    await this.answers.takeBack(respond, "the clean up question");
    const line = await deletion.clean(channel);
    await this.answers.tellOwnerAbout(channel, question, question, line ?? texts.CLEAN_UNBOUND);
  };

  /** Cancel: the question goes, and nothing else changes. */
  onCancel = async (ack: Ack, body: Payload, respond?: Respond): Promise<void> => {
    if ((await this.admitted(ack, body)) !== null) {
      await this.answers.takeBack(respond, "the clean up question");
    }
  };

  /** Acknowledges, then the channel of the owner's click; null for anyone else's. */
  private async admitted(ack: Ack, body: Payload): Promise<string | null> {
    await ack();
    const [user, team] = interactionActor(body);
    const channel = text(record(body.channel).id);
    const question = questionOf(body);
    return (await this.answers.admitted(user, team, channel, question, question)) ? channel : null;
  }
}
