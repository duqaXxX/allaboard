/**
 * The controls of a list posted in a session's thread (`!diff`'s Diff button and view selector),
 * as the Slack provider hears them. What a control does is the core's (`src/core/flows/diff.ts`);
 * here a click is acknowledged, checked for the owner and the thread, and read into the pick the
 * core is told of. The list itself is drawn by `SlackThread.offer`.
 */

import type { RewindAction } from "../../seam.ts";
import { parseValue, REWIND_ACTIONS } from "../lists.ts";
import type { Answers, AppParts } from "./answers.ts";
import { interactionActor } from "./guards.ts";
import type { ChannelOrder } from "./order.ts";
import {
  type Ack,
  clickThread,
  firstAction,
  messageTs,
  type Payload,
  record,
  text,
} from "./wire.ts";

export class ThreadLists {
  private readonly parts: AppParts;
  private readonly answers: Answers;
  private readonly order: ChannelOrder;

  constructor(parts: AppParts, answers: Answers, order: ChannelOrder) {
    this.parts = parts;
    this.answers = answers;
    this.order = order;
  }

  /** A Diff button of a file's row. */
  onDiffFile = async (ack: Ack, body: Payload): Promise<void> => {
    await ack();
    const [user, team] = interactionActor(body);
    const channel = text(record(body.channel).id);
    const thread = clickThread(body);
    if (!(await this.answers.admitted(user, team, channel, thread)) || channel === null) return;
    // The value is untrusted like every click's: only its form is checked here.
    const value = parseValue(String(firstAction(body).value), 3);
    if (value === null) return;
    const [session, view, path] = value as [string, string, string];
    await this.parts.inbound.picked({
      type: "diff-file",
      ref: { channel, thread },
      session,
      view,
      path,
      list: messageTs(body),
    });
  };

  /** The view selector of a list. */
  onDiffView = async (ack: Ack, body: Payload): Promise<void> => {
    await ack();
    const [user, team] = interactionActor(body);
    const channel = text(record(body.channel).id);
    const thread = clickThread(body);
    if (!(await this.answers.admitted(user, team, channel, thread)) || channel === null) return;
    const value = parseValue(String(record(firstAction(body).selected_option).value), 2);
    if (value === null) return;
    const [session, view] = value as [string, string];
    await this.parts.inbound.picked({
      type: "diff-view",
      ref: { channel, thread },
      session,
      view,
      list: messageTs(body),
    });
  };

  /** The selector of a rewind list: the prompt picked. */
  onRewindPoint = async (ack: Ack, body: Payload): Promise<void> => {
    await ack();
    const [user, team] = interactionActor(body);
    const channel = text(record(body.channel).id);
    const thread = clickThread(body);
    if (!(await this.answers.admitted(user, team, channel, thread)) || channel === null) return;
    const value = parseValue(String(record(firstAction(body).selected_option).value), 2);
    if (value === null) return;
    const [session, promptId] = value as [string, string];
    await this.parts.inbound.picked({
      type: "rewind-point",
      ref: { channel, thread },
      session,
      promptId,
      list: messageTs(body),
    });
  };

  /**
   * Send or Cancel of a `!next` offer (the value is `[session, id]`, never the text). It takes its
   * place among the channel's messages before the acknowledgement, as a typed message does.
   */
  onSuggestion =
    (send: boolean) =>
    async (ack: Ack, body: Payload): Promise<void> => {
      const [user, team] = interactionActor(body);
      const channel = text(record(body.channel).id);
      const thread = clickThread(body);
      const value = parseValue(String(firstAction(body).value), 2);
      // The owner and the workspace first, nothing awaited: anyone else takes no place.
      if (!this.answers.fromOwner(user, team, channel) || channel === null || value === null) {
        await ack();
        return;
      }
      const [session, id] = value as [string, string];
      // (sync) The place among the channel's messages.
      const place = this.order.enter(channel);
      let handed: Promise<void> | null = null;
      let refused: Promise<void> | null = null;
      try {
        await ack();
        await place.turn;
        if (this.answers.stopped) return;
        const check = await this.answers.checkChannel(channel, thread);
        if (!check.allowed) {
          refused = check.tell();
          return;
        }
        handed = this.parts.inbound.picked({
          type: "suggestion",
          ref: { channel, thread },
          session,
          id,
          send,
          list: messageTs(body),
        });
      } finally {
        await place.turn;
        place.leave();
        if (refused !== null) await refused;
      }
      await handed;
    };

  /** A button of the actions at a prompt. */
  onRewindAction = async (ack: Ack, body: Payload): Promise<void> => {
    await ack();
    const [user, team] = interactionActor(body);
    const channel = text(record(body.channel).id);
    const thread = clickThread(body);
    if (!(await this.answers.admitted(user, team, channel, thread)) || channel === null) return;
    const value = parseValue(String(firstAction(body).value), 3);
    if (value === null) return;
    const [session, promptId, action] = value as [string, string, string];
    // The action is untrusted like the rest: a word that is none of the four is no pick.
    if (!REWIND_ACTIONS.includes(action as RewindAction)) return;
    await this.parts.inbound.picked({
      type: "rewind-action",
      ref: { channel, thread },
      session,
      promptId,
      action: action as RewindAction,
      list: messageTs(body),
    });
  };
}
