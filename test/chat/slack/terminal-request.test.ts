import assert from "node:assert/strict";
import { test } from "node:test";
import { TERMINAL_CANCEL, TERMINAL_GO, terminalBlocks } from "../../../src/chat/slack/requests.ts";

type Button = { action_id: string; value: string; style?: string; text: { text: string } };

test("background work beside a terminal's writing is named, with Stop them and send", () => {
  const blocks = terminalBlocks("terminal-1", {
    type: "terminal",
    requestId: "terminal-1",
    state: "background",
    running: "1 shell · <2> agents",
    command: null,
  });
  // Rich text, beside which the request's mention pushes (#163); the counts shown as written.
  assert.deepEqual(blocks[0], {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_section",
        elements: [
          {
            type: "text",
            text: "⚠️ This session was continued in a terminal while work runs here: ",
          },
          { type: "text", text: "1 shell · <2> agents" },
          { type: "text", text: ". To send this here, that work stops first." },
        ],
      },
    ],
  });
  const [go, cancel] = (blocks.at(-1) as { elements: Button[] }).elements as [Button, Button];
  assert.deepEqual([go.action_id, go.value, go.style], [TERMINAL_GO, "terminal-1", "primary"]);
  assert.deepEqual([cancel.action_id, cancel.value], [TERMINAL_CANCEL, "terminal-1"]);
  assert.deepEqual([go.text.text, cancel.text.text], ["Stop them and send", "Cancel"]);
});

test("a terminal's command is code, a backtick in it kept as written", () => {
  const blocks = terminalBlocks("terminal-1", {
    type: "terminal",
    requestId: "terminal-1",
    state: "open",
    running: null,
    command: "claude --resume `id`",
  });
  const section = (blocks[0] as { elements: { elements: unknown[] }[] }).elements[0];
  assert.deepEqual(section?.elements[1], {
    type: "text",
    text: "claude --resume `id`",
    style: { code: true },
  });
  assert.equal((blocks.at(-1) as { elements: unknown[] }).elements.length, 2);
});

test("a turn run in the terminal is waited out, with Cancel alone", () => {
  const blocks = terminalBlocks("terminal-1", {
    type: "terminal",
    requestId: "terminal-1",
    state: "busy",
    running: null,
    command: null,
  });
  assert.equal((blocks[0] as { type: string }).type, "rich_text");
  assert.equal((blocks.at(-1) as { elements: unknown[] }).elements.length, 1);
});

test("work with no words to name leaves no empty text in the heading", () => {
  const blocks = terminalBlocks("terminal-1", {
    type: "terminal",
    requestId: "terminal-1",
    state: "move",
    running: null,
    command: null,
  });
  const section = (blocks[0] as { elements: { elements: { text?: string }[] }[] }).elements[0];
  assert.ok(section?.elements.every((element) => element.text !== ""));
});
