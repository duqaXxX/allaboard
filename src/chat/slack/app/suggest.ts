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
import type { CommandSuggestion, InboundMessage } from "../../seam.ts";
import { describe } from "../reply/errors.ts";
import { parsePick, SUGGEST_EDIT, suggestionBlocks, typedMessage } from "../suggest.ts";
import * as slackTexts from "../texts.ts";
import { type Answers, type AppParts, logger } from "./answers.ts";
import { interactionActor } from "./guards.ts";
import { type ThreadOrder, threadKey } from "./order.ts";
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
  private readonly order: ThreadOrder;
  // By id, oldest first (a Map keeps insertion order).
  private readonly kept = new Map<string, CommandSuggestion>();
  private nonce = 0;
  // The fields whose text was taken, so that a second Enter or Send on one hands over nothing.
  private readonly consumed = new Set<string>();

  constructor(parts: AppParts, answers: Answers, order: ThreadOrder) {
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
    await ack();
    const action = firstAction(body);
    await this.hand(body, respond, text(action.block_id), text(action.value) ?? "");
  };

  /**
   * Send: the button's value names the field, and the click carries the field's text in `state`,
   * as edited and never sent with Enter (measured 2026-10-21, desktop).
   */
  onSend = async (ack: Ack, body: Payload, respond?: Respond): Promise<void> => {
    await ack();
    const blockId = text(firstAction(body).value);
    const values = record(record(body.state).values);
    const field = blockId !== null && Object.hasOwn(values, blockId) ? values[blockId] : null;
    await this.hand(body, respond, blockId, text(record(record(field)[SUGGEST_EDIT]).value) ?? "");
  };

  /**
   * The text of the field `blockId` goes to the core as the message the owner typed, in the
   * thread, in the place its listener took among the thread's messages. The owner and the
   * workspace are checked here, before the place is taken.
   */
  private async hand(
    body: Payload,
    respond: Respond | undefined,
    blockId: string | null,
    sent: string,
  ): Promise<void> {
    const [user, team] = interactionActor(body);
    const channel = text(record(body.channel).id);
    const threadTs = clickThread(body);
    // The owner and the workspace first, with nothing awaited: anyone else takes no place.
    if (!this.answers.fromOwner(user, team, channel) || channel === null) return;
    const typed = typedMessage(blockId);
    if (sent.trim() === "" || typed === null || blockId === null) return;
    // (sync) The place among the thread's messages, as `app.event("message")` takes it.
    const place = this.order.enter(threadKey(channel, threadTs));
    let handed: Promise<void>;
    let withdrawn: Promise<void>;
    try {
      await place.turn;
      if (this.answers.stopped) return;
      if (!(await this.answers.channelAllowed(channel, threadTs))) return;
      // (sync) From the check to the call that hands the message over, nothing is awaited. The
      // field is marked used only now, so a refusal above leaves it working; a second Enter or
      // Send waits for its place behind this one and finds it used.
      if (this.consumed.has(blockId)) return;
      this.consumed.add(blockId);
      const oldest = this.consumed.values().next().value;
      if (this.consumed.size > KEPT * 10 && oldest !== undefined) this.consumed.delete(oldest);
      withdrawn = this.withdraw(respond);
      handed = this.parts.inbound.message(typedIn(channel, threadTs, typed, sent));
    } finally {
      place.leave();
    }
    await Promise.all([handed, withdrawn]);
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
    await this.withdraw(respond);
    const suggestion = pick === null ? undefined : this.kept.get(pick.id);
    const candidate = suggestion?.candidates[pick?.index ?? -1];
    if (pick === null || suggestion === undefined || candidate === undefined) {
      await this.answers.tellOwner(channel, threadTs, slackTexts.SUGGEST_EXPIRED);
      return;
    }
    await this.post(channel, threadTs, pick.id, suggestion, candidate.text);
  };

  /** Takes the message away. A failure leaves it showing until a reload, and is logged. */
  private async withdraw(respond: Respond | undefined): Promise<void> {
    if (respond === undefined) return; // a click with no `response_url`: nothing to answer
    try {
      await respond({ delete_original: true });
    } catch (error) {
      logger.warning(`could not take back a command suggestion: ${describe(error)}`);
    }
  }
}

/**
 * The text sent from the field, as the message that typed the word: the same id, so that what the
 * core marks or withdraws is the owner's own message. It is a message of the thread whatever the
 * typed one was, since the thread exists by now. `sent` is raw: a field's value is not
 * Slack-escaped, and it is read as a word, not as a literal.
 */
function typedIn(channel: string, threadTs: string, id: string, sent: string): InboundMessage {
  return {
    ref: { channel, thread: threadTs },
    id,
    topLevel: false,
    text: sent,
    plain: sent,
    literal: false,
    content: async () => sent,
  };
}
