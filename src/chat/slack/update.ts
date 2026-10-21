/**
 * The update of allaboard as Slack draws it: the offer `!allaboard update` posts in a
 * channel, and the button and dialog of the update line on the Home tab. The words are the
 * core's; the click of either becomes a pick of the core (`app/update.ts`).
 *
 * The confirmation dialog object (docs.slack.dev/reference/block-kit/composition-objects/
 * confirmation-dialog-object, read 2026-10-17): `title` holds 100 characters, `text` 300,
 * `confirm` and `deny` 30 each, all `plain_text`; `style` is optional. A button's `value` holds
 * 2,000 characters (button element reference): a version is far under it.
 */

import { fill, sharedCopyLine, texts } from "../../core/port.ts";
import type { OwnerList } from "../seam.ts";
import { type ContextBlock, contextBlock, plainTextObject } from "./reply/blocks.ts";
import { take } from "./reply/chars.ts";
import { mrkdwnEscape } from "./reply/escape.ts";
import * as slackTexts from "./texts.ts";

// Block Kit's limits on a confirmation dialog: its title, its text, and each of its two buttons.
export const CONFIRM_TITLE_LIMIT = 100;
export const CONFIRM_TEXT_LIMIT = 300;
export const CONFIRM_BUTTON_LIMIT = 30;

/** The Update button of the offer a channel shows: its value is the version it installs. */
export const UPDATE_ACTION = "update_install";
/** The `block_id` of the offer's line, so a test and a rewrite can tell it from its notes. */
export const UPDATE_BLOCK = "update";

type UpdateList = Extract<OwnerList, { type: "update" }>;

/** `line` followed by the link to the changelog at `url`, in mrkdwn. */
export function withChangelog(line: string, url: string): string {
  return fill(slackTexts.UPDATE_LINKED, {
    line,
    url: mrkdwnEscape(url),
    label: texts.UPDATE_WHAT_CHANGED,
  });
}

/**
 * The button that installs `latest`, with Slack's own confirmation dialog when `confirm` gives
 * the version that runs: the Home tab shows no message that says what changes first, the offer
 * in a channel does.
 */
export function updateButton(
  actionId: string,
  latest: string,
  confirm: { readonly installed: string } | null,
): { type: "button"; [key: string]: unknown } {
  const button: { type: "button"; [key: string]: unknown } = {
    type: "button",
    action_id: actionId,
    text: plainTextObject(fill(texts.UPDATE_BUTTON, { latest })),
    value: latest,
  };
  if (confirm !== null) {
    button.confirm = {
      title: plainTextObject(take(texts.UPDATE_CONFIRM_TITLE, CONFIRM_TITLE_LIMIT)),
      text: plainTextObject(
        take(
          fill(texts.UPDATE_CONFIRM_TEXT, { installed: confirm.installed, latest }),
          CONFIRM_TEXT_LIMIT,
        ),
      ),
      confirm: plainTextObject(take(texts.UPDATE_CONFIRM_YES, CONFIRM_BUTTON_LIMIT)),
      deny: plainTextObject(take(texts.UPDATE_CONFIRM_NO, CONFIRM_BUTTON_LIMIT)),
    };
  }
  return button;
}

export type UpdateBlock =
  | ContextBlock
  | { type: "section"; block_id: string; [key: string]: unknown };

/**
 * The offer: the line `title` with the link to what changed and the Update button, then what a
 * click waits for, and the other instances that restart with this one when there are any. The
 * message shows the change, so its button asks nothing more.
 */
export function updateBlocks(list: UpdateList, title: string): UpdateBlock[] {
  const shared = sharedCopyLine(list.sharing);
  return [
    {
      type: "section",
      block_id: UPDATE_BLOCK,
      text: { type: "mrkdwn", text: withChangelog(title, list.changelog) },
      accessory: updateButton(UPDATE_ACTION, list.to, null),
    },
    contextBlock(texts.UPDATE_DRAIN),
    ...(shared === null ? [] : [contextBlock(shared)]),
  ];
}
