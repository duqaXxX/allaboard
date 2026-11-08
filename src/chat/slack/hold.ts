import { texts } from "../../core/port.ts";
import { slackUnescape } from "./app/messages.ts";
import { richSentence } from "./requests.ts";
import * as slackTexts from "./texts.ts";
/** The same-folder hold's question as Slack blocks. */

export const HOLD_CONTINUE = "hold_continue";
export const HOLD_CANCEL = "hold_cancel";

/**
 * The question in the thread: a rich text heading, beside which the request's mention pushes
 * (#163), plus Continue and Cancel. `link` is a notice link as `SlackThread.link` writes it,
 * `<url|label>`, drawn as a link element; any other words (the fallback when Slack gave no
 * permalink) as text. Only Continue is `primary`: one button of a set, and never `danger` for an
 * answer that destroys nothing (button element reference, docs.slack.dev, read 2026-10-07).
 */
export function holdBlocks(holdId: string, link: string): Record<string, unknown>[] {
  return [
    richSentence(texts.HOLD_QUESTION, { link: linkElements(link) }),
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: HOLD_CONTINUE,
          value: holdId,
          style: "primary",
          text: { type: "plain_text", text: slackTexts.HOLD_CONTINUE_BUTTON },
        },
        {
          type: "button",
          action_id: HOLD_CANCEL,
          value: holdId,
          text: { type: "plain_text", text: slackTexts.HOLD_CANCEL_BUTTON },
        },
      ],
    },
  ];
}

/**
 * A notice link as `SlackThread.link` writes it (`<url|label>`, the label escaped for mrkdwn) as
 * a rich text element; the core's words for a thread with no link
 * (`STATUS_CHANNEL_LINK_FALLBACK`) as text, a code span in them as code.
 */
function linkElements(link: string): Record<string, unknown>[] {
  const parts = /^<([^|>]+)\|(.*)>$/s.exec(link);
  if (parts !== null) return [{ type: "link", url: parts[1], text: slackUnescape(parts[2] ?? "") }];
  return link
    .split(/(`[^`]+`)/)
    .filter((part) => part !== "")
    .map((part) =>
      part.length > 2 && part.startsWith("`") && part.endsWith("`")
        ? { type: "text", text: part.slice(1, -1), style: { code: true } }
        : { type: "text", text: part },
    );
}
