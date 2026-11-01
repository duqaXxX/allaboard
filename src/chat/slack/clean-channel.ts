import { fill } from "../../core/port.ts";
import type { ChannelSurvey } from "./delete.ts";
import * as slackTexts from "./texts.ts";
/** `!clean-channel`'s question as Slack blocks. */

export const CLEAN_CHANNEL_CONFIRM = "clean_channel_confirm";
export const CLEAN_CHANNEL_CANCEL = "clean_channel_cancel";

/**
 * The question in the channel: the Home tab's title and buttons, and what would go and stay.
 * The click is read by its container, so the
 * buttons hold no value.
 */
export function cleanChannelBlocks(survey: ChannelSurvey): Record<string, unknown>[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${slackTexts.HOME_CLEAN_TITLE}*\n${fill(slackTexts.CLEAN_WORD_TEXT, { ...survey })}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: CLEAN_CHANNEL_CONFIRM,
          style: "danger",
          text: { type: "plain_text", text: slackTexts.HOME_CLEAN_CONFIRM },
        },
        {
          type: "button",
          action_id: CLEAN_CHANNEL_CANCEL,
          text: { type: "plain_text", text: slackTexts.HOME_DELETE_DENY },
        },
      ],
    },
  ];
}
