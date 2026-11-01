/**
 * What Slack's Block Kit reference limits in a message's or a view's `blocks`, for the fake Slack to
 * refuse as the real one does. A stream's chunks are not checked. Read 2026-11-01 on docs.slack.dev:
 * `reference/block-kit/block-elements/button-element`, `.../blocks/actions-block` and
 * `.../composition-objects/option-object`; the rest as the source's own constants cite them.
 */

type Json = Record<string, unknown>;

const MESSAGE_BLOCKS = 50;
const VIEW_BLOCKS = 100;
const BLOCK_ID = 255;
const ACTIONS_ELEMENTS = 25;
const ACTION_ID = 255;
const BUTTON_TEXT = 75;
const BUTTON_VALUE = 2000;
const SELECT_OPTIONS = 100;
const OPTION_TEXT = 75;
const OPTION_VALUE = 150;
const SECTION_TEXT = 3000;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string {
  return isObject(value) && typeof value.text === "string" ? value.text : "";
}

function objects(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function elementFaults(element: Json, where: string): string[] {
  const faults: string[] = [];
  const over = (what: string, length: number, limit: number): void => {
    if (length > limit) faults.push(`${where}: ${what} holds ${length}, the limit is ${limit}`);
  };
  over("action_id", String(element.action_id ?? "").length, ACTION_ID);
  if (element.type === "button") {
    over("the button's text", textOf(element.text).length, BUTTON_TEXT);
    over("the button's value", String(element.value ?? "").length, BUTTON_VALUE);
  }
  const options = objects(element.options);
  over("the options", options.length, SELECT_OPTIONS);
  for (const option of options) {
    over("an option's text", textOf(option.text).length, OPTION_TEXT);
    over("an option's value", String(option.value ?? "").length, OPTION_VALUE);
  }
  return faults;
}

/** Every limit `blocks` passes, one line each; empty when Slack's reference allows them. */
export function blockFaults(blocks: unknown, limit = MESSAGE_BLOCKS): string[] {
  const all = objects(blocks);
  const faults: string[] = [];
  if (all.length > limit) faults.push(`${all.length} blocks, the limit is ${limit}`);
  const blockIds = new Set<string>();
  all.forEach((block, index) => {
    const where = `block ${index} (${String(block.type)})`;
    if (typeof block.block_id === "string") {
      if (block.block_id.length > BLOCK_ID) faults.push(`${where}: block_id too long`);
      if (blockIds.has(block.block_id)) faults.push(`${where}: block_id ${block.block_id} twice`);
      blockIds.add(block.block_id);
    }
    if (block.type === "section" && textOf(block.text).length > SECTION_TEXT) {
      faults.push(`${where}: the text passes ${SECTION_TEXT}`);
    }
    const elements = block.type === "actions" ? objects(block.elements) : [];
    if (elements.length > ACTIONS_ELEMENTS) faults.push(`${where}: too many elements`);
    const actionIds = new Set<string>();
    for (const element of elements) {
      const id = element.action_id;
      if (typeof id !== "string") continue;
      if (actionIds.has(id)) faults.push(`${where}: action_id ${id} twice`);
      actionIds.add(id);
    }
    const single = [block.accessory, block.element].filter(isObject);
    for (const element of [...elements, ...single]) faults.push(...elementFaults(element, where));
  });
  return faults;
}

/** The limits a Web API call's arguments pass: its message's blocks or its view's. */
export function callFaults(args: Json): string[] {
  const view = isObject(args.view) ? blockFaults(args.view.blocks, VIEW_BLOCKS) : [];
  return [...blockFaults(args.blocks), ...view];
}
