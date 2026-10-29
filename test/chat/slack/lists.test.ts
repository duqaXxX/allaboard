/**
 * A list posted in a thread (`!diff`): its blocks, and the provider's `offer` and `share`. The
 * limits are Block Kit's (docs.slack.dev/reference/block-kit/blocks, read 2026-10-29: 50 blocks to
 * a message; the button element: 2,000 characters in a value; the option object: 150).
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { ChatError, type ThreadList } from "../../../src/chat/seam.ts";
import {
  BUTTON_VALUE_LIMIT,
  DIFF_FILE_ACTION,
  DIFF_ROWS,
  DIFF_VIEW_ACTION,
  diffBlocks,
  fileValue,
  listBlocks,
  parseValue,
  REWIND_ACTION_ACTION,
  REWIND_ACTIONS,
  REWIND_POINT_ACTION,
  REWIND_POINTS,
  viewValue,
} from "../../../src/chat/slack/lists.ts";
import { resetStatusFlags } from "../../../src/chat/slack/reply/status.ts";
import * as slackTexts from "../../../src/chat/slack/texts.ts";
import { fill } from "../../../src/core/texts.ts";
import { CHANNEL, rejected, THREAD } from "../../support/fake-slack.ts";
import { madeChat } from "../../support/slack-chat.ts";

beforeEach(() => resetStatusFlags());

// biome-ignore lint/suspicious/noExplicitAny: Block Kit read in a test
type Json = Record<string, any>;

const LIST: Extract<ThreadList, { type: "diff" }> = {
  type: "diff",
  view: "current",
  views: [{ id: "current", label: "Current" }],
  files: [
    { path: "src/a&b.ts", added: 3, removed: 1, binary: false },
    { path: "logo.png", added: 0, removed: 0, binary: true },
  ],
  session: "session-1",
};

test("a row shows the path and its counts, with a button that carries the session, view and path", () => {
  const blocks = diffBlocks(LIST, "Changed files") as Json[];
  assert.equal(blocks[0]?.type, "context");
  const [first, second] = blocks.slice(1);
  assert.equal(first?.text.text, "`src/a&amp;b.ts` · +3 −1");
  assert.equal(first?.accessory.action_id, DIFF_FILE_ACTION);
  assert.deepEqual(parseValue(first?.accessory.value, 3), ["session-1", "current", "src/a&b.ts"]);
  assert.equal(second?.text.text, "`logo.png` · binary");
  assert.equal(second?.accessory, undefined, "a binary file has no text diff to share");
});

test("one view draws no selector, several draw one with the current view selected", () => {
  assert.equal(
    (diffBlocks(LIST, "t") as Json[]).some((block) => block.type === "actions"),
    false,
  );
  const several: Extract<ThreadList, { type: "diff" }> = {
    ...LIST,
    view: "turn-1",
    views: [
      { id: "current", label: "Current" },
      { id: "turn-1", label: "T1" },
    ],
  };
  const select = (diffBlocks(several, "t") as Json[]).find((block) => block.type === "actions");
  const [menu] = select?.elements ?? [];
  assert.equal(menu.type, "static_select");
  assert.equal(menu.action_id, DIFF_VIEW_ACTION);
  assert.equal(menu.initial_option.value, viewValue("session-1", "turn-1"));
  assert.deepEqual(
    menu.options.map((option: Json) => option.text.text),
    ["Current", "T1"],
  );
});

test("past the rows a message holds, a line counts the rest, and the blocks stay within 50", () => {
  const files = Array.from({ length: DIFF_ROWS + 5 }, (_, i) => ({
    path: `f${i}.ts`,
    added: 1,
    removed: 0,
    binary: false,
  }));
  const blocks = diffBlocks({ ...LIST, files, views: [{ id: "current", label: "Current" }] }, "t");
  assert.ok(blocks.length <= 50);
  const last = blocks.at(-1) as Json;
  assert.equal(
    last.elements[0].text,
    fill(slackTexts.DIFF_MORE, { rows: DIFF_ROWS, count: DIFF_ROWS + 5 }),
  );
});

test("a path too long for a button's value is shown with no button, and a view option past its limit leaves the selector out", () => {
  const long = `${"d/".repeat(BUTTON_VALUE_LIMIT)}x.ts`;
  const [, row] = diffBlocks(
    { ...LIST, files: [{ path: long, added: 1, removed: 0, binary: false }] },
    "t",
  ) as Json[];
  assert.equal(row?.accessory, undefined);
  const wide = diffBlocks(
    {
      ...LIST,
      session: "s".repeat(200),
      views: [
        { id: "current", label: "Current" },
        { id: "turn-1", label: "T1" },
      ],
    },
    "t",
  ) as Json[];
  assert.equal(
    wide.some((block) => block.type === "actions"),
    false,
  );
});

test("a value of another shape is read as none", () => {
  assert.equal(parseValue("not json", 3), null);
  assert.equal(parseValue(JSON.stringify(["a", "b"]), 3), null);
  assert.equal(parseValue(JSON.stringify(["a", 2, "c"]), 3), null);
  assert.equal(parseValue(fileValue("s", "v", "p"), 2), null);
});

test("offer posts the list in the thread and answers with its ts", async () => {
  const { slack, thread } = madeChat();
  const ts = await thread.offer(LIST, "Changed files");
  const [post, ...more] = slack.callsTo("chat.postMessage");
  assert.equal(more.length, 0);
  assert.deepEqual(post, {
    channel: CHANNEL,
    thread_ts: THREAD,
    text: "Changed files",
    blocks: diffBlocks(LIST, "Changed files"),
    unfurl_links: false,
    unfurl_media: false,
  });
  assert.equal(ts, slack.postedTs.at(-1));
});

test("offer with a message to replace edits that message", async () => {
  const { slack, thread } = madeChat();
  const ts = await thread.offer(LIST, "Changed files", "1780000000.000300");
  assert.equal(ts, "1780000000.000300");
  assert.deepEqual(slack.callsTo("chat.postMessage"), []);
  assert.deepEqual(slack.callsTo("chat.update"), [
    {
      channel: CHANNEL,
      ts: "1780000000.000300",
      text: "Changed files",
      blocks: diffBlocks(LIST, "Changed files"),
    },
  ]);
});

test("offer rejects with the chat's code when Slack refuses", async () => {
  const { slack, thread } = madeChat();
  slack.responses["chat.postMessage"] = rejected("invalid_blocks");
  await assert.rejects(thread.offer(LIST, "t"), (error: unknown) => {
    assert.ok(error instanceof ChatError);
    assert.equal(error.name, "invalid_blocks");
    return true;
  });
});

test("share uploads the bytes as the named file into the thread", async () => {
  const { slack, thread } = madeChat();
  await thread.share({ name: "a.ts.diff", title: "src/a.ts.diff", content: Buffer.from("diff\n") });
  const [url, done] = slack.apiCalls;
  assert.equal(url?.method, "files.getUploadURLExternal");
  assert.equal(url?.args.filename, "a.ts.diff");
  assert.equal(done?.args.channel_id, CHANNEL);
  assert.equal(done?.args.thread_ts, THREAD);
  assert.deepEqual(done?.args.files, [{ id: "F000FILE", title: "src/a.ts.diff" }]);
  assert.deepEqual(
    slack.uploaded.map((posted) => posted.data),
    [Buffer.from("diff\n")],
  );
});

test("share rejects with Slack's code, and no path in it", async () => {
  const { slack, thread } = madeChat();
  slack.responses["files.getUploadURLExternal"] = rejected("snippet_too_large");
  await assert.rejects(
    thread.share({ name: "a.diff", title: "a.diff", content: Buffer.from("x") }),
    (error: unknown) => error instanceof ChatError && error.name === "snippet_too_large",
  );
});

// The rewind lists: a selector of prompts, then a button for each action at one prompt.

const POINTS: ThreadList = {
  type: "rewind-points",
  session: "session-1",
  points: [
    { id: "p-2", text: "fix the\nsecond & last bug" },
    { id: "p-1", text: "add the first feature" },
  ],
};

test("the prompts are the options of one selector, newest first, each by its first words", () => {
  const blocks = listBlocks(POINTS, "Go back to a prompt") as Json[];
  assert.equal(blocks[0]?.type, "context");
  const select = blocks[1]?.elements[0];
  assert.equal(select.type, "static_select");
  assert.equal(select.action_id, REWIND_POINT_ACTION);
  assert.deepEqual(
    select.options.map((option: Json) => option.text.text),
    ["fix the second & last bug", "add the first feature"],
  );
  assert.deepEqual(parseValue(select.options[0].value, 2), ["session-1", "p-2"]);
});

test("a selector holds 100 prompts and the list says how many more there are", () => {
  const many: ThreadList = {
    type: "rewind-points",
    session: "session-1",
    points: Array.from({ length: REWIND_POINTS + 5 }, (_, n) => ({ id: `p-${n}`, text: `t${n}` })),
  };
  const blocks = listBlocks(many, "t") as Json[];
  assert.equal(blocks[1]?.elements[0].options.length, REWIND_POINTS);
  assert.equal(
    blocks[2]?.elements[0].text,
    fill(slackTexts.REWIND_MORE, { rows: REWIND_POINTS, count: REWIND_POINTS + 5 }),
  );
});

test("a prompt whose id would overflow an option's value is left out, not the list", () => {
  const long: ThreadList = {
    type: "rewind-points",
    session: "session-1",
    points: [
      { id: "x".repeat(200), text: "too long an id" },
      { id: "p-1", text: "fine" },
    ],
  };
  const select = (listBlocks(long, "t") as Json[])[1]?.elements[0];
  assert.deepEqual(
    select.options.map((option: Json) => option.text.text),
    ["fine"],
  );
});

const ACTIONS: ThreadList = {
  type: "rewind-actions",
  session: "session-1",
  point: { id: "p-2", text: "fix the second bug" },
  files: { count: 2, insertions: 3, deletions: 1 },
  conversation: true,
};

function buttons(list: ThreadList): Json[] {
  return (listBlocks(list, "Rewind") as Json[])[1]?.elements;
}

test("every action is a button carrying the session, the prompt and the action", () => {
  const all = buttons(ACTIONS);
  assert.deepEqual(
    all.map((button) => button.text.text),
    [
      slackTexts.REWIND_BOTH,
      slackTexts.REWIND_CONVERSATION,
      `${slackTexts.REWIND_CODE} (2 files, +3 −1)`,
      slackTexts.REWIND_CANCEL,
    ],
  );
  assert.ok(all.every((button) => button.action_id === REWIND_ACTION_ACTION));
  assert.deepEqual(
    all.map((button) => parseValue(button.value, 3)),
    REWIND_ACTIONS.map((action) => ["session-1", "p-2", action]),
  );
});

test("an action the agent cannot do is not a button", () => {
  const noFiles = buttons({ ...ACTIONS, files: null } as ThreadList);
  assert.deepEqual(
    noFiles.map((button) => parseValue(button.value, 3)?.[2]),
    ["conversation", "cancel"],
  );
  const noConversation = buttons({ ...ACTIONS, conversation: false } as ThreadList);
  assert.deepEqual(
    noConversation.map((button) => parseValue(button.value, 3)?.[2]),
    ["code", "cancel"],
  );
});

test("a single file reads as a file", () => {
  const one = buttons({
    ...ACTIONS,
    files: { count: 1, insertions: 0, deletions: 4 },
  } as ThreadList);
  assert.equal(one[2]?.text.text, `${slackTexts.REWIND_CODE} (1 file, +0 −4)`);
});
