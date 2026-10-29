/**
 * A list posted in a session's thread (`ThreadChat.offer`), as Slack shows it: `!diff`'s changed
 * files, one section per file with a Diff button, and a selector of views when the list has more
 * than one. What is listed and what a control does are the core's (`src/core/flows/diff.ts`).
 */

import { fill } from "../../core/port.ts";
import type { DiffRow, ThreadList } from "../seam.ts";
import { type ContextBlock, contextBlock } from "./reply/blocks.ts";
import { take } from "./reply/chars.ts";
import { shownAsWritten } from "./reply/escape.ts";
import * as slackTexts from "./texts.ts";

export const DIFF_FILE_ACTION = "diff_file";
export const DIFF_VIEW_ACTION = "diff_view";

// A message holds 50 blocks (Block Kit reference, docs.slack.dev/reference/block-kit/blocks, read
// 2026-10-29): the title, the selector and the line that counts the rest take three.
export const DIFF_ROWS = 45;
// A button's `value` holds 2,000 characters (docs.slack.dev/reference/block-kit/block-elements/button-element,
// read 2026-10-29); a file with a longer path shows its row with no button.
export const BUTTON_VALUE_LIMIT = 2000;
// A section's text holds 3,000 characters (docs.slack.dev/reference/block-kit/blocks/section-block).
const PATH_SHOWN = 500;

// A static select option's `value` holds 150 characters (docs.slack.dev/reference/block-kit/composition-objects/option-object,
// read 2026-10-29).
export const OPTION_VALUE_LIMIT = 150;

/** What a Diff button carries: the session and view the list was made for, and the file. */
export function fileValue(session: string, view: string, path: string): string {
  return JSON.stringify([session, view, path]);
}

/** What a view option carries: the session the list was made for, and the view. */
export function viewValue(session: string, view: string): string {
  return JSON.stringify([session, view]);
}

/**
 * The strings a control's value holds, or null for any other shape: a value is untrusted like
 * every click's, and the core checks what they name.
 */
export function parseValue(value: string, count: 2 | 3): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== count) return null;
  return parsed.every((part) => typeof part === "string") ? (parsed as string[]) : null;
}

interface DiffSection {
  type: "section";
  block_id: string;
  text: { type: "mrkdwn"; text: string };
  accessory?: {
    type: "button";
    action_id: string;
    value: string;
    text: { type: "plain_text"; text: string };
  };
}

interface ViewSelect {
  type: "actions";
  block_id: string;
  elements: [
    {
      type: "static_select";
      action_id: string;
      placeholder: { type: "plain_text"; text: string };
      options: { text: { type: "plain_text"; text: string }; value: string }[];
      initial_option: { text: { type: "plain_text"; text: string }; value: string };
    },
  ];
}

export type DiffBlock = ContextBlock | DiffSection | ViewSelect;

function row(list: ThreadList, file: DiffRow, index: number): DiffSection {
  const counts = file.binary ? slackTexts.DIFF_BINARY : `+${file.added} −${file.removed}`;
  const block: DiffSection = {
    type: "section",
    // An index, not the path: a block_id is capped at 255 characters.
    block_id: `diff-${index}`,
    text: {
      type: "mrkdwn",
      text: `\`${shownAsWritten(take(file.path, PATH_SHOWN))}\` · ${counts}`,
    },
  };
  const value = fileValue(list.session, list.view, file.path);
  if (!file.binary && value.length <= BUTTON_VALUE_LIMIT) {
    block.accessory = {
      type: "button",
      action_id: DIFF_FILE_ACTION,
      value,
      text: { type: "plain_text", text: slackTexts.DIFF_BUTTON },
    };
  }
  return block;
}

/** The blocks of `list`, under the one line `title`. */
export function diffBlocks(list: ThreadList, title: string): DiffBlock[] {
  const blocks: DiffBlock[] = [contextBlock(shownAsWritten(title))];
  const current = list.views.find((view) => view.id === list.view);
  if (list.views.length > 1 && current !== undefined) {
    const option = (view: { id: string; label: string }) => ({
      text: { type: "plain_text" as const, text: take(view.label, 75) },
      value: viewValue(list.session, view.id),
    });
    const options = list.views.map(option);
    // A value over the limit would make Slack refuse the whole list: the selector is left out.
    if (options.every((offered) => offered.value.length <= OPTION_VALUE_LIMIT))
      blocks.push({
        type: "actions",
        block_id: "diff-views",
        elements: [
          {
            type: "static_select",
            action_id: DIFF_VIEW_ACTION,
            placeholder: { type: "plain_text", text: slackTexts.DIFF_VIEW_PLACEHOLDER },
            options,
            initial_option: option(current),
          },
        ],
      });
  }
  blocks.push(...list.files.slice(0, DIFF_ROWS).map((file, index) => row(list, file, index)));
  if (list.files.length > DIFF_ROWS) {
    blocks.push(
      contextBlock(fill(slackTexts.DIFF_MORE, { rows: DIFF_ROWS, count: list.files.length })),
    );
  }
  return blocks;
}
