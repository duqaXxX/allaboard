import { type Names, named } from "../../core/port.ts";
import * as slackTexts from "./texts.ts";
/** `!delete-thread`'s question as Slack blocks. */

export const DELETE_THREAD_CONFIRM = "delete_thread_confirm";
export const DELETE_THREAD_CANCEL = "delete_thread_cancel";

/**
 * The question under the owner's word: the Home tab's own title and warning in a `mrkdwn`
 * section, then its two buttons. The click carries no `message` and is read by its container
 * (`clickThread`), so the buttons hold no value. Delete is `danger`, as on the Home tab.
 */
export function deleteThreadBlocks(names: Names): Record<string, unknown>[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${slackTexts.HOME_DELETE_TITLE}*\n${named(slackTexts.HOME_DELETE_TEXT, names)}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: DELETE_THREAD_CONFIRM,
          style: "danger",
          text: { type: "plain_text", text: slackTexts.HOME_DELETE_CONFIRM },
        },
        {
          type: "button",
          action_id: DELETE_THREAD_CANCEL,
          text: { type: "plain_text", text: slackTexts.HOME_DELETE_DENY },
        },
      ],
    },
  ];
}
