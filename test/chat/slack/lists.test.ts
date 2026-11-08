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
  NEXT_CANCEL_ACTION,
  NEXT_SEND_ACTION,
  parseValue,
  REWIND_ACTIONS,
  REWIND_POINT_ACTION,
  REWIND_POINTS,
  rewindActionId,
  viewValue,
} from "../../../src/chat/slack/lists.ts";
import { MESSAGE_LIMIT } from "../../../src/chat/slack/reply/blocks.ts";
import { len } from "../../../src/chat/slack/reply/chars.ts";
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

test("share answers with the id nested in the upload's result, or null when there is none", async () => {
  const { slack, thread } = madeChat();
  const file = { name: "a.diff", title: "a.diff", content: Buffer.from("x") };
  assert.equal(await thread.share(file), "F000FILE");
  slack.responses["files.completeUploadExternal"] = { ok: true };
  assert.equal(await thread.share(file), null);
});

test("unshare deletes the file with files.delete, and rejects with Slack's code", async () => {
  const { slack, thread } = madeChat();
  await thread.unshare("F000FILE");
  assert.deepEqual(slack.callsTo("files.delete"), [{ file: "F000FILE" }]);
  slack.responses["files.delete"] = rejected("file_not_found");
  await assert.rejects(
    thread.unshare("F000FILE"),
    (error: unknown) => error instanceof ChatError && error.name === "file_not_found",
  );
});

// A diff shown under the rows: one markdown block, the path first, inside the fence.

const ZWSP = String.fromCodePoint(0x200b);

test("a shown diff is one markdown block after the rows, its path the first line inside the fence", () => {
  const blocks = diffBlocks(
    { ...LIST, shown: { path: "src/a`b.ts", text: "@@\n+x\n" } },
    "t",
  ) as Json[];
  const last = blocks.at(-1);
  assert.equal(last?.type, "markdown");
  assert.equal(last?.text, "```\nsrc/a`b.ts\n@@\n+x\n\n```");
  assert.equal(blocks.filter((block) => block.type === "markdown").length, 1);
});

test("a shown diff holding markup, a mention, a fence and backticks reads back as typed but for zero-width spaces", () => {
  const text = "+a < b && c\n+<!here> <!channel>\n+```\n+````x`\n+`one` ``two``\n";
  const [block] = (diffBlocks({ ...LIST, shown: { path: "p<!here>", text } }, "t") as Json[]).slice(
    -1,
  );
  const body = String(block?.text).slice("```\n".length, -"\n```".length);
  assert.equal(body.replaceAll(ZWSP, ""), `p<!here>\n${text}`);
  assert.doesNotMatch(body, /<!here/, "no raw broadcast reaches the block");
  assert.doesNotMatch(body, /`{3}/, "no run of three backticks closes the fence");
  assert.ok(body.includes("&"), "entities stay literal in code");
});

const textLength = (blocks: Json[]): number =>
  blocks.reduce(
    (sum, block) =>
      sum +
      (block.type === "markdown" ? len(block.text) : 0) +
      (block.type === "section" ? len(block.text.text) : 0) +
      (block.type === "context" ? len(block.elements[0].text) : 0),
    0,
  );

test("fitsList follows the text of the blocks it would send, to the character", () => {
  const { thread } = madeChat();
  const files = Array.from({ length: DIFF_ROWS + 5 }, (_, i) => ({
    path: `src/dir/file-${i}.ts`,
    added: 1,
    removed: 0,
    binary: false,
  }));
  for (const path of ["src/a.ts", "d/".repeat(1500)]) {
    // Backtick runs grow by the spaces that break them: the count is of what is sent.
    const listed = (k: number): Extract<ThreadList, { type: "diff" }> => ({
      ...LIST,
      files,
      shown: { path, text: "```\n".repeat(k) },
    });
    let k = 0;
    while (textLength(diffBlocks(listed(k + 1), "Changed files") as Json[]) <= MESSAGE_LIMIT)
      k += 1;
    assert.ok(k > 100, "the search found the edge");
    assert.equal(thread.fitsList(listed(k), "Changed files"), true, `${k} fences fit`);
    assert.equal(thread.fitsList(listed(k + 1), "Changed files"), false, `${k + 1} fences do not`);
    assert.ok((diffBlocks(listed(k), "Changed files") as Json[]).length <= 50);
  }
});

test("fitsList counts code points, not UTF-16 units, and has no say about a list with no diff", () => {
  const { thread } = madeChat();
  const emoji = "\u{1F7E5}";
  const shown = (n: number) => ({ ...LIST, shown: { path: "a.ts", text: emoji.repeat(n) } });
  const room = MESSAGE_LIMIT - textLength(diffBlocks(shown(0), "Changed files") as Json[]);
  assert.equal(thread.fitsList(shown(room - 1 - 10), "Changed files"), true);
  assert.equal(thread.fitsList(shown(room + 5), "Changed files"), false);
  assert.equal(thread.fitsList(LIST, "Changed files"), true);
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
  assert.deepEqual(
    all.map((button) => button.action_id),
    REWIND_ACTIONS.map(rewindActionId),
  );
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

// The agent's suggested next prompt (`!next`): a rich text heading, the words quoted in a markdown
// block, and Send and Cancel carrying the session and the suggestion's id, never its text.

const SUGGESTION: ThreadList = {
  type: "suggestion",
  session: "session-1",
  id: "id-1",
  text: "run the *tests*\nthen <!here> look at <@U000ALICE>",
};

test("a suggestion is a heading, its words as a quote, and two buttons", () => {
  const [heading, words, actions] = listBlocks(SUGGESTION, "Suggested next prompt:") as Json[];
  assert.equal(heading?.type, "rich_text");
  assert.equal(heading?.elements[0].elements[0].text, "Suggested next prompt:");
  // Markdown in a markdown block, so the owner's formatting lives; every line quoted.
  assert.equal(words?.type, "markdown");
  assert.ok(words?.text.startsWith("> run the *tests*\n> then "));
  assert.deepEqual(
    actions?.elements.map((button: Json) => [button.action_id, button.text.text, button.style]),
    [
      [NEXT_SEND_ACTION, slackTexts.NEXT_SEND, "primary"],
      [NEXT_CANCEL_ACTION, slackTexts.NEXT_CANCEL, undefined],
    ],
  );
});

test("a mention in a suggestion notifies nobody", () => {
  const words = (listBlocks(SUGGESTION, "Suggested next prompt:") as Json[])[1]?.text as string;
  const zero = String.fromCodePoint(0x200b);
  assert.ok(words.includes(`<${zero}!here>`));
  assert.ok(words.includes(`<${zero}@U000ALICE>`));
  assert.ok(!words.includes("<!here>") && !words.includes("<@U000ALICE>"));
});

test("the buttons of a suggestion carry the session and the id, never the text", () => {
  const actions = (listBlocks(SUGGESTION, "Suggested next prompt:") as Json[])[2];
  for (const button of actions?.elements ?? []) {
    assert.deepEqual(parseValue(button.value, 2), ["session-1", "id-1"]);
    assert.ok(!button.value.includes("tests"));
  }
});
