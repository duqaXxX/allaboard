/**
 * The suggestion for a `!word` that is no command, as Slack blocks: a text field holding
 * what the owner typed, which sends it on Enter or with the Send button under it, and the commands
 * it could mean as buttons. The layout was tried on prototypes in a private channel on 2026-10-21
 * (desktop): no block puts a text field and a button on one row (an `input` block holds one
 * element, and a rich text input in an `actions` block was refused with `invalid_blocks`).
 */
import { type Names, named } from "../../core/port.ts";
import type { CommandCandidate, CommandSuggestion } from "../seam.ts";
import { mrkdwnEscape } from "./reply/escape.ts";
import { cut } from "./requests.ts";
import * as slackTexts from "./texts.ts";

export const SUGGEST_EDIT = "suggest_edit";
export const SUGGEST_SEND = "suggest_send";
export const SUGGEST_PICK = "suggest_pick";
export const SUGGEST_MENU = "suggest_menu";

// A message holds at most 50 blocks; a select 100 options, or 100 groups of 100 (250 options in
// three groups were accepted, 2026-10-21); a button and a group label 75 characters of text; a
// text input 3000 of initial value (Block Kit reference, read 2026-10-21).
const BUTTON_TEXT = 75;
const OPTION_TEXT = 75;
const OPTIONS = 100;
const ROW_TEXT = 300;
const FIELD_VALUE = 3000;

const FIELD_BLOCK = "suggest:";

/**
 * The block id of the field. The typed message rides in it, since the field's Enter carries
 * nothing else: it is the message the sent text is handed over as. `nonce` makes the id new each
 * time, so that Slack shows the new initial value and not what was typed before.
 */
export function fieldBlockId(message: string, nonce: number): string {
  return `${FIELD_BLOCK}${message}|${nonce}`;
}

/** The typed message a field's block id names; null for an id that is not a field's. */
export function typedMessage(blockId: string | null): string | null {
  if (blockId === null || !blockId.startsWith(FIELD_BLOCK)) return null;
  const message = blockId.slice(FIELD_BLOCK.length).split("|", 1)[0];
  return message === undefined || message === "" ? null : message;
}

/** A control's value: which suggestion, and which of its candidates. */
export function pickValue(id: string, index: number): string {
  return `${id}:${index}`;
}

/** The suggestion and candidate a control's value names; null for a value that is not one. */
export function parsePick(value: string | null): { id: string; index: number } | null {
  if (value === null) return null;
  const at = value.lastIndexOf(":");
  const index = Number(value.slice(at + 1));
  if (at < 1 || !Number.isInteger(index) || index < 0) return null;
  return { id: value.slice(0, at), index };
}

function row(candidate: CommandCandidate, index: number, id: string): Record<string, unknown> {
  // A code span cannot hold a backtick: such a usage is plain text.
  const usage = candidate.usage.includes("`")
    ? mrkdwnEscape(candidate.usage)
    : `\`${mrkdwnEscape(candidate.usage)}\``;
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: cut(`${usage} ${mrkdwnEscape(candidate.description)}`, ROW_TEXT),
    },
    accessory: {
      type: "button",
      action_id: SUGGEST_PICK,
      text: { type: "plain_text", text: cut(candidate.text, BUTTON_TEXT) },
      value: pickValue(id, index),
    },
  };
}

/**
 * The menu's choices: one list up to 100, past that groups of 100 in the same order, each named
 * by its first and last command, so that no command is left out.
 */
function menuOptions(
  listed: readonly { candidate: CommandCandidate; index: number }[],
  id: string,
): Record<string, unknown> {
  const options = listed.map(({ candidate, index }) => ({
    text: {
      type: "plain_text",
      text: cut(`${candidate.usage} · ${candidate.description}`, OPTION_TEXT),
    },
    value: pickValue(id, index),
  }));
  if (options.length <= OPTIONS) return { options };
  const groups: Record<string, unknown>[] = [];
  for (let at = 0; at < listed.length; at += OPTIONS) {
    const first = listed[at]?.candidate.text;
    const last = listed[Math.min(at + OPTIONS, listed.length) - 1]?.candidate.text;
    groups.push({
      label: { type: "plain_text", text: cut(`${first} … ${last}`, BUTTON_TEXT) },
      options: options.slice(at, at + OPTIONS),
    });
  }
  return { option_groups: groups };
}

/**
 * The message for `suggestion`, its field holding `prefill`. With `all`, the daemon's words are
 * rows with a button and the agent's commands one menu: a message holds too few blocks for a row
 * each.
 */
export function suggestionBlocks(
  suggestion: CommandSuggestion,
  id: string,
  nonce: number,
  prefill: string,
  names: Names,
): Record<string, unknown>[] {
  const field = fieldBlockId(suggestion.message, nonce);
  const blocks: Record<string, unknown>[] = [
    {
      type: "input",
      block_id: field,
      dispatch_action: true,
      label: { type: "plain_text", text: slackTexts.SUGGEST_LABEL },
      element: {
        type: "plain_text_input",
        action_id: SUGGEST_EDIT,
        // A text the field cannot hold whole is not put in it: sent from there, it would be cut.
        ...(Array.from(prefill).length <= FIELD_VALUE
          ? { initial_value: prefill }
          : { placeholder: { type: "plain_text", text: slackTexts.SUGGEST_TOO_LONG } }),
        dispatch_action_config: { trigger_actions_on: ["on_enter_pressed"] },
      },
    },
    {
      // The field's block id rides in the value: the click carries the field's text in `state`
      // under that id.
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: SUGGEST_SEND,
          style: "primary",
          text: { type: "plain_text", text: slackTexts.SUGGEST_SEND },
          value: field,
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: suggestion.all ? slackTexts.SUGGEST_ALL : slackTexts.SUGGEST_HINT,
        },
      ],
    },
  ];
  const listed = suggestion.candidates.map((candidate, index) => ({ candidate, index }));
  if (!suggestion.all) {
    for (const { candidate, index } of listed) blocks.push(row(candidate, index, id));
    return blocks;
  }
  const heading = (text: string): Record<string, unknown> => ({
    type: "context",
    elements: [{ type: "mrkdwn", text }],
  });
  const daemon = listed.filter(({ candidate }) => candidate.group === "daemon");
  const agent = listed.filter(({ candidate }) => candidate.group === "agent");
  if (daemon.length > 0) {
    blocks.push(heading(slackTexts.SUGGEST_DAEMON));
    for (const { candidate, index } of daemon) blocks.push(row(candidate, index, id));
  }
  if (agent.length > 0) {
    blocks.push(heading(named(slackTexts.SUGGEST_AGENT, names)));
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "static_select",
          action_id: SUGGEST_MENU,
          placeholder: { type: "plain_text", text: slackTexts.SUGGEST_MENU },
          ...menuOptions(agent, id),
        },
      ],
    });
  }
  return blocks;
}
