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
  // The counts shown as written: no `<2>` read as markup.
  assert.deepEqual(blocks[0], {
    type: "section",
    text: {
      type: "mrkdwn",
      text:
        "⚠️ This session was continued in a terminal while work runs here: " +
        "1 shell · &lt;2&gt; agents. To send this here, that work stops first.",
    },
  });
  const [go, cancel] = (blocks.at(-1) as { elements: Button[] }).elements as [Button, Button];
  assert.deepEqual([go.action_id, go.value, go.style], [TERMINAL_GO, "terminal-1", "primary"]);
  assert.deepEqual([cancel.action_id, cancel.value], [TERMINAL_CANCEL, "terminal-1"]);
  assert.deepEqual([go.text.text, cancel.text.text], ["Stop them and send", "Cancel"]);
});
