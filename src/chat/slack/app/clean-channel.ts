/**
 * `!clean-channel` as the Slack provider hears it: a question only the owner sees, in the channel,
 * with Clean up and Cancel, naming how many threads go and stay (`ThreadDeleter.survey`). Clean up
 * runs `ThreadDeleter.purge`: the channel's threads, each as the Home tab's Delete does, then its
 * Clean up. As with `!delete-thread`, the
 * question is ephemeral: Cancel takes it away with `respond({ delete_original: true })`, and Clean up
 * rewrites it into the outcome.
 */

import { fill, named, texts } from "../../../core/port.ts";
import { cleanChannelBlocks } from "../clean-channel.ts";
import type { ChannelSurvey } from "../delete.ts";
import { describe } from "../reply/errors.ts";
import * as slackTexts from "../texts.ts";
import { type Answers, type AppParts, logger } from "./answers.ts";
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
    const { deletion } = this.parts;
    if (deletion === undefined) return;
    let survey: ChannelSurvey;
    try {
      survey = await deletion.survey(channel);
    } catch (error) {
      const line = fill(slackTexts.CLEAN_WORD_STOPPED, { error: describe(error) });
      await this.answers.tellOwnerAbout(channel, "", "", line);
      return;
    }
    await this.answers.deliver(
      channel,
      null,
      slackTexts.HOME_CLEAN_TITLE,
      cleanChannelBlocks(survey),
      { ephemeral: true },
    );
  }

  /** Clean up: the question goes, then the threads and the messages; a line says how it went. */
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
    // One message from question to outcome, as Slack lets nothing delete an ephemeral one later.
    if (!(await this.rewrite(respond, slackTexts.CLEAN_WORD_STARTED))) {
      await this.answers.takeBack(respond, "the clean up question");
      await this.answers.tellOwnerAbout(channel, question, question, slackTexts.CLEAN_WORD_STARTED);
    }
    const line = (await deletion.purge(channel)) ?? texts.CLEAN_UNBOUND;
    if (!(await this.rewrite(respond, line))) {
      await this.answers.tellOwnerAbout(channel, question, question, line);
    }
  };

  /**
   * Rewrites the question in place, and says whether it could: `response_url` takes 5 answers
   * within 30 minutes (Slack's interactivity reference, read 2026-11-01), which a long purge passes.
   */
  private async rewrite(respond: Respond | undefined, text: string): Promise<boolean> {
    if (respond === undefined) return false;
    try {
      await respond({ replace_original: true, text });
      return true;
    } catch (error) {
      logger.info(`could not rewrite the clean up question: ${describe(error)}`);
      return false;
    }
  }

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
