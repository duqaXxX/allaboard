/**
 * A `!word` that is no command as the Slack app draws it: a message only the owner sees,
 * under their word in the thread, with a field holding exactly what they typed and the commands
 * it could mean. A button, or a choice from the menu, puts its command in the field; Enter in
 * the field, or the Send button under it, hands the text to the core as a message the owner typed,
 * so it is read and routed as one (a known command runs, an unknown word is suggested for again).
 *
 * The message is ephemeral: nothing of it is left to delete or to store beyond the candidates of
 * the last few, kept in memory to redraw the field after a pick (a restart forgets them, and the
 * pick then says so). A click carries `response_url` and `container.is_ephemeral` and no
 * `message` (measured 2026-10-19, bolt 5.1.0), so the thread is read from the container
 * (`clickThread`). A pick takes the old message away and posts a new one: rewriting it through
 * `response_url` showed the new one in the channel too (seen 2026-10-21, desktop).
 */
import { randomUUID } from "node:crypto";
import { fill } from "../../../core/port.ts";
import type { CommandSuggestion, InboundMessage } from "../../seam.ts";
import { readMessage } from "../fold.ts";
import { describe } from "../reply/errors.ts";
import { parsePick, SUGGEST_EDIT, suggestionBlocks, typedMessage } from "../suggest.ts";
import * as slackTexts from "../texts.ts";
import { type Answers, type AppParts, logger } from "./answers.ts";
import { interactionActor } from "./guards.ts";
import type { ChannelOrder } from "./order.ts";
import { withPasted } from "./pasted.ts";
import {
  type Ack,
  clickThread,
  firstAction,
  type Payload,
  type Respond,
  record,
  text,
} from "./wire.ts";

// How many suggestions are kept to redraw after a pick: the owner picks from the last few.
const KEPT = 20;

export class Suggestions {
  private readonly parts: AppParts;
  private readonly answers: Answers;
  private readonly order: ChannelOrder;
  // By id, oldest first (a Map keeps insertion order).
  private readonly kept = new Map<string, CommandSuggestion>();
  private nonce = 0;
  // The fields whose text was taken, so that a second Enter or Send on one hands over nothing.
  private readonly consumed = new Set<string>();

  constructor(parts: AppParts, answers: Answers, order: ChannelOrder) {
    this.parts = parts;
    this.answers = answers;
    this.order = order;
  }

  /** Shows the owner alone the suggestion, in the thread; resolves once it is posted. */
  async show(channel: string, threadTs: string, suggestion: CommandSuggestion): Promise<void> {
    const id = randomUUID();
    this.kept.set(id, suggestion);
    const oldest = this.kept.keys().next().value;
    if (this.kept.size > KEPT && oldest !== undefined) this.kept.delete(oldest);
    await this.post(channel, threadTs, id, suggestion, suggestion.typed);
  }

  private async post(
    channel: string,
    threadTs: string,
    id: string,
    suggestion: CommandSuggestion,
    prefill: string,
  ): Promise<void> {
    this.nonce += 1;
    await this.answers.deliver(
      channel,
      threadTs,
      slackTexts.SUGGEST_FALLBACK,
      suggestionBlocks(suggestion, id, this.nonce, prefill, this.parts.names),
      { ephemeral: true },
    );
  }

  /** Enter in the field: the text is the action's own value. */
  onEdit = async (ack: Ack, body: Payload, respond?: Respond): Promise<void> => {
    const action = firstAction(body);
    await this.hand(ack, body, respond, text(action.block_id), text(action.value) ?? "");
  };

  /**
   * Send: the button's value names the field, and the click carries the field's text in `state`,
   * as edited and never sent with Enter (measured 2026-10-21, desktop).
   */
  onSend = async (ack: Ack, body: Payload, respond?: Respond): Promise<void> => {
    const blockId = text(firstAction(body).value);
    const values = record(record(body.state).values);
    const field = blockId !== null && Object.hasOwn(values, blockId) ? values[blockId] : null;
    await this.hand(
      ack,
      body,
      respond,
      blockId,
      text(record(record(field)[SUGGEST_EDIT]).value) ?? "",
    );
  };

  /**
   * The text of the field `blockId` goes to the core as the message the owner typed, in the
   * thread, in the place its listener took among the channel's messages. The owner and the
   * workspace are checked, and the place taken, before the click is acknowledged: the
   * acknowledgement is an await, and a message typed meanwhile would otherwise be ordered first.
   */
  private async hand(
    ack: Ack,
    body: Payload,
    respond: Respond | undefined,
    blockId: string | null,
    sent: string,
  ): Promise<void> {
    const [user, team] = interactionActor(body);
    const channel = text(record(body.channel).id);
    const threadTs = clickThread(body);
    // The owner and the workspace first, with nothing awaited: anyone else takes no place.
    if (!this.answers.fromOwner(user, team, channel) || channel === null) {
      await ack();
      return;
    }
    const typed = typedMessage(blockId);
    if (sent.trim() === "" || typed === null || blockId === null) {
      await ack();
      return;
    }
    // (sync) The place among the channel's messages, as `app.event("message")` takes it.
    const place = this.order.enter(channel);
    let handed: Promise<void>;
    let withdrawn: Promise<void>;
    let refused: Promise<void> | null = null;
    try {
      await ack();
      await place.turn;
      if (this.answers.stopped) return;
      const check = await this.answers.checkChannel(channel, threadTs);
      if (!check.allowed) {
        refused = check.tell();
        return;
      }
      // (sync) From the check to the call that hands the message over, nothing is awaited. The
      // field is marked used only now, so a refusal above leaves it working; a second Enter or
      // Send waits for its place behind this one and finds it used.
      if (this.consumed.has(blockId)) return;
      this.consumed.add(blockId);
      const oldest = this.consumed.values().next().value;
      if (this.consumed.size > KEPT * 10 && oldest !== undefined) this.consumed.delete(oldest);
      withdrawn = this.answers.takeBack(respond, "a command suggestion");
      handed = this.parts.inbound.message(
        typedIn(channel, threadTs, typed, sent, () => this.typedNow(channel, threadTs, typed)),
      );
    } finally {
      // The place is left only after its turn: a rejected `ack()` above would otherwise release
      // the next place while an earlier one is still held.
      await place.turn;
      place.leave();
      if (refused !== null) await refused;
    }
    await Promise.all([handed, withdrawn]);
  }

  /**
   * The typed message `id` as Slack holds it now, null when it is gone; undefined, after telling
   * the owner why, when it cannot be read: the text is then not sent without what it held.
   */
  private async typedNow(
    channel: string,
    threadTs: string,
    id: string,
  ): Promise<Readonly<Record<string, unknown>> | null | undefined> {
    try {
      return await readMessage(this.parts.slack, channel, threadTs, id);
    } catch (error) {
      logger.warning(`could not read back message ${id} in ${channel}: ${describe(error)}`);
      await this.answers.tellOwner(
        channel,
        threadTs,
        fill(slackTexts.SUGGEST_UNREAD, { error: describe(error) }),
      );
      return undefined;
    }
  }

  /** A button or the menu: the command goes in the field, which the owner edits and sends. */
  onPick = async (ack: Ack, body: Payload, respond?: Respond): Promise<void> => {
    await ack();
    const [user, team] = interactionActor(body);
    const channel = text(record(body.channel).id);
    const threadTs = clickThread(body);
    if (!(await this.answers.admitted(user, team, channel, threadTs)) || channel === null) return;
    const action = firstAction(body);
    const pick = parsePick(text(action.value) ?? text(record(action.selected_option).value));
    await this.answers.takeBack(respond, "a command suggestion");
    const suggestion = pick === null ? undefined : this.kept.get(pick.id);
    const candidate = suggestion?.candidates[pick?.index ?? -1];
    if (pick === null || suggestion === undefined || candidate === undefined) {
      await this.answers.tellOwner(channel, threadTs, slackTexts.SUGGEST_EXPIRED);
      return;
    }
    await this.post(channel, threadTs, pick.id, suggestion, candidate.text);
  };
}

/**
 * The text sent from the field, as the message that typed the word: the same id, so that what the
 * core marks or withdraws is the owner's own message. It is a message of the thread whatever the
 * typed one was, since the thread exists by now. `sent` is raw: a field's value is not
 * Slack-escaped, and it is read as a word, not as a literal. What the typed message holds beyond
 * its text (a table or a card pasted under the word: the field holds the text alone) follows the
 * field's text in the prompt, as it followed the typed text (#120, #275). It is read back from
 * Slack when the message's turn comes, so a restart loses nothing; a message deleted since adds
 * nothing, and a failed read sends nothing and tells the owner why.
 */
function typedIn(
  channel: string,
  threadTs: string,
  id: string,
  sent: string,
  typedNow: () => Promise<Readonly<Record<string, unknown>> | null | undefined>,
): InboundMessage {
  return {
    ref: { channel, thread: threadTs },
    id,
    topLevel: false,
    text: sent,
    plain: sent,
    bare: sent,
    literal: false,
    content: async () => {
      const now = await typedNow();
      return now === undefined ? null : withPasted(sent, now?.blocks);
    },
  };
}
