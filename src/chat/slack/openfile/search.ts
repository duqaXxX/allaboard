/**
 * The message `!open` shows the owner alone: a search field, up to FILE_BUTTONS files as buttons
 * and a line that says what they are. Which files, and how a click on one is handled, is
 * `app/open.ts`.
 */

import type { KnownBlock } from "@slack/web-api";
import { fill } from "../../../core/port.ts";
import { contextBlock, plainTextObject } from "../reply/blocks.ts";
import { len, take } from "../reply/chars.ts";
import { shownAsWritten } from "../reply/escape.ts";
import * as slackTexts from "../texts.ts";

// The search field (a `dispatch_action` input, as the command suggestion's, which sends on
// Enter) and the buttons that share a file.
export const OPEN_FIELD = "open_search";
export const OPEN_FIELD_BLOCK = "open_search_block";
export const OPEN_FILE = "open_file";
export const OPEN_FILE_ACTIONS = /^open_file:\d+$/;
// Block Kit's limits, read 2026-10-31: a button's text 75 characters and its `value` 2000 (button
// element); the project keeps a path to 150, which the old picker's option value allowed, so that
// a file stays reachable by the same paths. An `actions` block holds 25 elements.
export const FILE_BUTTONS = 5;
export const TEXT_LIMIT = 75;
export const VALUE_LIMIT = 150;
// The words a search carries, typed in the field.
export const QUERY_LIMIT = 200;

/** `text` cut in its middle with `…` to `room` characters, its end kept longer than its start so an extension stays. */
function middle(text: string, room: number): string {
  const characters = Array.from(text);
  if (characters.length <= room) return text;
  const end = Math.floor((room - 1) / 2) + ((room - 1) % 2);
  return `${characters.slice(0, room - 1 - end).join("")}…${characters.slice(characters.length - end).join("")}`;
}

/** Whether a path can be a button's value; the file stays reachable by `!open <path>`. */
export function fits(path: string): boolean {
  return len(path) <= VALUE_LIMIT;
}

/** A path's last two segments: `openfile/search.ts` for `src/chat/slack/openfile/search.ts`. */
function tail(path: string): string {
  return path.split("/").slice(-2).join("/");
}

/**
 * The labels of the buttons for `paths`: each path's last two segments; when two collide, the
 * paths themselves, shortened in their middle past TEXT_LIMIT.
 */
export function labels(paths: readonly string[]): string[] {
  const short = paths.map(tail);
  return paths.map((path, at) => {
    const same = short.filter((label) => label === short[at]).length > 1;
    return middle(same ? path : (short[at] ?? path), TEXT_LIMIT);
  });
}

/** The first FILE_BUTTONS paths that can be a button's value. */
export function offered(paths: readonly string[]): string[] {
  return paths.filter(fits).slice(0, FILE_BUTTONS);
}

export interface SearchShown {
  /** The files to choose from: the session's changed files, newest first, or the matches. */
  readonly paths: readonly string[];
  /** How many files there are when `paths` holds only some of them. */
  readonly count: number;
  /** False adds the line that says the folder could not be listed in full. */
  readonly complete: boolean;
}

/**
 * The message for `words`: the search field holding them, a button for each of the first
 * FILE_BUTTONS of `shown.paths`, and the lines that say what they are. With no `words` the files
 * are the session's changed ones.
 */
export function searchBlocks(typed: string, shown: SearchShown): KnownBlock[] {
  const { paths, count, complete } = shown;
  // `!open <words>` is searched whole; what is shown of it fits the field.
  const words = take(typed, QUERY_LIMIT);
  const files = offered(paths);
  const blocks: KnownBlock[] = [
    {
      type: "input",
      block_id: OPEN_FIELD_BLOCK,
      dispatch_action: true,
      label: plainTextObject(slackTexts.OPEN_QUERY_LABEL),
      element: {
        type: "plain_text_input",
        action_id: OPEN_FIELD,
        max_length: QUERY_LIMIT,
        placeholder: plainTextObject(slackTexts.OPEN_QUERY_HINT),
        dispatch_action_config: { trigger_actions_on: ["on_enter_pressed"] },
        ...(words && { initial_value: words }),
      },
    },
  ];
  const shownLabels = labels(files);
  if (files.length > 0) {
    blocks.push({
      type: "actions",
      elements: files.map((path, at) => ({
        type: "button" as const,
        // Slack's button reference: unique among the `action_id`s of the block.
        action_id: `${OPEN_FILE}:${at}`,
        text: plainTextObject(shownLabels[at] ?? path, false),
        value: path,
      })),
    });
  }
  blocks.push(contextBlock(heading(words, count, complete)));
  // The changed files' heading already says to type for the others.
  if (count > files.length && (words || files.length === 0)) {
    blocks.push(
      contextBlock(
        files.length > 0
          ? fill(slackTexts.OPEN_MATCHES_CAPPED, { shown: files.length, count })
          : slackTexts.OPEN_MATCHES_TOO_LONG,
      ),
    );
  }
  if (!complete && count > 0) blocks.push(contextBlock(slackTexts.OPEN_PARTIAL));
  return blocks;
}

function heading(words: string, count: number, complete: boolean): string {
  if (!words) {
    if (count === 0) return slackTexts.OPEN_TYPE_A_NAME;
    return fill(count === 1 ? slackTexts.OPEN_CHANGED_ONE : slackTexts.OPEN_CHANGED, { count });
  }
  if (count === 0) {
    const noMatch = complete ? slackTexts.OPEN_NO_MATCH : slackTexts.OPEN_NO_MATCH_PARTIAL;
    return fill(noMatch, { words: shownAsWritten(words) });
  }
  return fill(count === 1 ? slackTexts.OPEN_ROWS_MATCH_ONE : slackTexts.OPEN_ROWS_MATCH, { count });
}
