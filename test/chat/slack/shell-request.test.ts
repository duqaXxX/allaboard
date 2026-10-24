import assert from "node:assert/strict";
import { test } from "node:test";
import { SHELL_CANCEL, SHELL_RUN, shellBlocks } from "../../../src/chat/slack/requests.ts";

type Button = { action_id: string; value: string; style?: string; text: { text: string } };

test("a shell command's confirmation shows the folder and the whole command", () => {
  const blocks = shellBlocks("shell-1", {
    type: "shell",
    requestId: "shell-1",
    command: "grep -r '<b>' . && echo `date`",
    folder: "~/work",
  });
  assert.deepEqual(blocks[0], {
    type: "section",
    text: { type: "mrkdwn", text: "Run this command in `~/work`?" },
  });
  // Shown as written: no `<b>` read as markup, no backtick closing the block.
  const code = (blocks[1] as { text: { text: string } }).text.text;
  assert.ok(code.startsWith("```\n") && code.endsWith("\n```"));
  assert.ok(code.includes("&lt;b&gt;") && !code.includes("<b>"));
  const [run, cancel] = (blocks.at(-1) as { elements: Button[] }).elements as [Button, Button];
  assert.deepEqual([run.action_id, run.value, run.style], [SHELL_RUN, "shell-1", "primary"]);
  assert.deepEqual(
    [cancel.action_id, cancel.value, cancel.style],
    [SHELL_CANCEL, "shell-1", undefined],
  );
  assert.deepEqual([run.text.text, cancel.text.text], ["Run", "Cancel"]);
});

test("a command too long for one message keeps its start and its end", () => {
  const command = `echo start ${"x".repeat(200_000)} end`;
  const blocks = shellBlocks("shell-2", {
    type: "shell",
    requestId: "shell-2",
    command,
    folder: "/w",
  });
  assert.ok(blocks.length <= 50);
  const texts = JSON.stringify(blocks);
  assert.ok(texts.includes("echo start") && texts.includes(" end"));
  assert.match(texts, /not shown/);
});
