/**
 * The controls of a list posted in a session's thread (`!diff`'s Diff button and view selector),
 * as the Slack provider hears them. What a control does is the core's (`src/core/flows/diff.ts`);
 * here a click is acknowledged, checked for the owner and the thread, and read into the pick the
 * core is told of. The list itself is drawn by `SlackThread.offer`.
 */

import { parseValue } from "../lists.ts";
import type { Answers, AppParts } from "./answers.ts";
import { interactionActor } from "./guards.ts";
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

  constructor(parts: AppParts, answers: Answers) {
    this.parts = parts;
    this.answers = answers;
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
}
