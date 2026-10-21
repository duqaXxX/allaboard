/**
 * The tag of a thread's root: the blocks and the text it is rewritten to, what is read back from
 * a root, and the calls `RootEditor` makes with the bot (reads) and the owner (edit and pin).
 *
 * The root's blocks follow the `rich_text` block reference (docs.slack.dev/reference/block-kit/
 * blocks/rich-text-block, read 2026-10-19): a `rich_text` block of `rich_text_section`s whose
 * elements are `text` (with a `style` of `bold`, `italic`, `strike` or `code`), `user`, `link`...
 * `conversations.replies` returns a pinned root with `pinned_to`, a list of channel ids.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatError } from "../../../src/chat/seam.ts";
import {
  RootEditor,
  retaggedBlocks,
  retaggedText,
  retitledBlocks,
  retitledText,
  rootMarks,
} from "../../../src/chat/slack/tag.ts";
import { CHANNEL, FakeSlack, OWNER, rejected, THREAD } from "../../support/fake-slack.ts";
import type { JsonObject } from "../../support/fixtures.ts";

const TAG = { type: "text", text: "[devops]", style: { code: true } };
const SPACE = { type: "text", text: " " };

/** A `rich_text` block holding one section of `elements`. */
function rich(...elements: JsonObject[]): JsonObject {
  return {
    type: "rich_text",
    block_id: "b1",
    elements: [{ type: "rich_text_section", elements }],
  };
}

const HELLO = { type: "text", text: "fix the footer " };
const MENTION = { type: "user", user_id: "U000BOB" };

/** The owner's root as `conversations.replies` returns it, changed by `fields`. */
function root(blocks: JsonObject[] | null, text: string, fields: JsonObject = {}): JsonObject {
  return {
    type: "message",
    user: OWNER,
    ts: THREAD,
    thread_ts: THREAD,
    text,
    ...(blocks !== null && { blocks }),
    ...fields,
  };
}

test("a tag goes before the text of the first section, in code style, with a space after it", () => {
  const blocks = [rich(HELLO, MENTION)];
  assert.deepEqual(retaggedBlocks(blocks, "devops"), [rich(TAG, SPACE, HELLO, MENTION)]);
  assert.deepEqual(blocks, [rich(HELLO, MENTION)], "the root's own blocks are not changed");
});

test("a tag replaces the one the root starts with", () => {
  const tagged = [rich(TAG, SPACE, HELLO)];
  const other = { type: "text", text: "[ops-2]", style: { code: true } };
  assert.deepEqual(retaggedBlocks(tagged, "ops-2"), [rich(other, SPACE, HELLO)]);
});

test("no tag takes the prefix off, and leaves a root without one as it is", () => {
  assert.deepEqual(retaggedBlocks([rich(TAG, SPACE, HELLO)], null), [rich(HELLO)]);
  assert.deepEqual(retaggedBlocks([rich(HELLO)], null), [rich(HELLO)]);
  // Only the prefix `!tag` writes: a code span of the owner's own, or a different space, stays.
  const bold = { type: "text", text: "[devops]", style: { code: true, bold: true } };
  assert.deepEqual(retaggedBlocks([rich(bold, SPACE, HELLO)], null), [rich(bold, SPACE, HELLO)]);
  const odd = { type: "text", text: "[not a tag]", style: { code: true } };
  assert.deepEqual(retaggedBlocks([rich(odd, HELLO)], null), [rich(odd, HELLO)]);
  assert.deepEqual(retaggedBlocks([rich(TAG, HELLO)], null), [rich(HELLO)], "no space follows");
});

test("a root with no rich_text block gets one that holds the tag", () => {
  const section = { type: "section", text: { type: "mrkdwn", text: "hi" } };
  assert.deepEqual(retaggedBlocks([section], "devops"), [
    {
      type: "rich_text",
      elements: [{ type: "rich_text_section", elements: [TAG, SPACE] }],
    },
    section,
  ]);
  assert.deepEqual(retaggedBlocks([section], null), [section]);
});

test("a root that starts with a list or a code block gets the tag on a line of its own", () => {
  const preformatted = { type: "rich_text_preformatted", elements: [{ type: "text", text: "ls" }] };
  const block = { type: "rich_text", elements: [preformatted] };
  assert.deepEqual(retaggedBlocks([block], "devops"), [
    {
      type: "rich_text",
      elements: [{ type: "rich_text_section", elements: [TAG, SPACE] }, preformatted],
    },
  ]);
  assert.deepEqual(retaggedBlocks([block], null), [block]);
});

test("taking the tag off a section it leaves empty removes the section, and then the block", () => {
  // A root that starts with a list: the tag had a section of its own, and untag is an exact undo.
  const list = {
    type: "rich_text_list",
    style: "bullet",
    elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "one" }] }],
  };
  const original = [{ type: "rich_text", block_id: "b1", elements: [list] }];
  const tagged = retaggedBlocks(original, "devops");
  assert.notDeepEqual(tagged, original);
  assert.deepEqual(retaggedBlocks(tagged, null), original);
  // A root with no rich_text block: the block the tag made is removed with its last element.
  const section = { type: "section", text: { type: "mrkdwn", text: "hi" } };
  assert.deepEqual(retaggedBlocks(retaggedBlocks([section], "devops"), null), [section]);
  // A section that still has text keeps its block and its place.
  assert.deepEqual(retaggedBlocks(retaggedBlocks([rich(HELLO)], "devops"), null), [rich(HELLO)]);
});

test("the text gets and loses the same prefix, in backticks", () => {
  assert.equal(retaggedText("fix the footer", "devops"), "`[devops]` fix the footer");
  assert.equal(retaggedText("`[devops]` fix the footer", "ops"), "`[ops]` fix the footer");
  assert.equal(retaggedText("`[devops]` fix the footer", null), "fix the footer");
  assert.equal(retaggedText("fix the footer", null), "fix the footer");
  // Not a name `!tag` accepts: left alone.
  assert.equal(retaggedText("`[two words]` fix", null), "`[two words]` fix");
});

test("a root's tag and pin are read from its blocks and its pinned_to", () => {
  assert.deepEqual(rootMarks(root([rich(TAG, SPACE, HELLO)], "x", { pinned_to: [CHANNEL] })), {
    tag: "devops",
    pinned: true,
  });
  assert.deepEqual(rootMarks(root([rich(HELLO)], "x")), { tag: null, pinned: false });
  assert.deepEqual(rootMarks(root([rich(HELLO)], "x", { pinned_to: [] })), {
    tag: null,
    pinned: false,
  });
  // A root with no blocks at all is read from its text.
  assert.deepEqual(rootMarks(root(null, "`[ops_2]` fix")), { tag: "ops_2", pinned: false });
  assert.deepEqual(rootMarks(root(null, "fix")), { tag: null, pinned: false });
  // The rule for a name is the one `!tag` applies.
  const long = { type: "text", text: `[${"a".repeat(41)}]`, style: { code: true } };
  assert.equal(rootMarks(root([rich(long, SPACE, HELLO)], "x")).tag, null);
});

interface Made {
  readonly bot: FakeSlack;
  readonly owner: FakeSlack;
  readonly tagger: RootEditor;
}

/** A tagger whose bot sees `message` as the root of `THREAD`. */
function made(message: JsonObject | Error): Made {
  const bot = new FakeSlack();
  const owner = new FakeSlack();
  bot.responses["conversations.replies"] =
    message instanceof Error ? message : { ok: true, messages: [message], has_more: false };
  return { bot, owner, tagger: new RootEditor(bot, owner) };
}

const PLAIN = root([rich(HELLO)], "fix the footer ");

test("a tag edits the root with the owner's client, then pins it", async () => {
  const { bot, owner, tagger } = made(PLAIN);
  await tagger.tag(CHANNEL, THREAD, "devops");
  assert.deepEqual(bot.apiCalls, [
    { method: "conversations.replies", args: { channel: CHANNEL, ts: THREAD, limit: 1 } },
  ]);
  assert.deepEqual(owner.apiCalls, [
    {
      method: "chat.update",
      args: {
        channel: CHANNEL,
        ts: THREAD,
        text: "`[devops]` fix the footer ",
        blocks: [rich(TAG, SPACE, HELLO)],
      },
    },
    { method: "pins.add", args: { channel: CHANNEL, timestamp: THREAD } },
  ]);
});

test("a root already tagged and pinned is neither edited nor pinned again", async () => {
  const { owner, tagger } = made(
    root([rich(TAG, SPACE, HELLO)], "`[devops]` fix the footer ", { pinned_to: [CHANNEL] }),
  );
  await tagger.tag(CHANNEL, THREAD, "devops");
  assert.deepEqual(owner.apiCalls, []);
});

test("a tagged root that is not pinned is pinned without an edit", async () => {
  const { owner, tagger } = made(root([rich(TAG, SPACE, HELLO)], "`[devops]` fix the footer "));
  await tagger.tag(CHANNEL, THREAD, "devops");
  assert.deepEqual(
    owner.apiCalls.map((call) => call.method),
    ["pins.add"],
  );
});

test("another tag replaces the first and keeps the pin", async () => {
  const { owner, tagger } = made(
    root([rich(TAG, SPACE, HELLO)], "`[devops]` fix the footer ", { pinned_to: [CHANNEL] }),
  );
  await tagger.tag(CHANNEL, THREAD, "ops");
  assert.deepEqual(
    owner.apiCalls.map((call) => call.method),
    ["chat.update"],
  );
  assert.equal(owner.apiCalls[0]?.args.text, "`[ops]` fix the footer ");
});

test("no tag takes the prefix off and unpins the root", async () => {
  const { owner, tagger } = made(
    root([rich(TAG, SPACE, HELLO)], "`[devops]` fix the footer ", { pinned_to: [CHANNEL] }),
  );
  await tagger.tag(CHANNEL, THREAD, null);
  assert.deepEqual(owner.apiCalls, [
    {
      method: "chat.update",
      args: { channel: CHANNEL, ts: THREAD, text: "fix the footer ", blocks: [rich(HELLO)] },
    },
    { method: "pins.remove", args: { channel: CHANNEL, timestamp: THREAD } },
  ]);
});

test("no tag on a root with none changes nothing", async () => {
  const { owner, tagger } = made(PLAIN);
  await tagger.tag(CHANNEL, THREAD, null);
  assert.deepEqual(owner.apiCalls, []);
});

test("no tag leaves alone a pin the owner made on a root that carries no tag", async () => {
  const { owner, tagger } = made(root([rich(HELLO)], "fix the footer ", { pinned_to: [CHANNEL] }));
  await tagger.tag(CHANNEL, THREAD, null);
  assert.deepEqual(owner.apiCalls, []);
});

test("a root with no blocks is edited through its text alone", async () => {
  const { owner, tagger } = made(root(null, "fix the footer"));
  await tagger.tag(CHANNEL, THREAD, "devops");
  assert.deepEqual(owner.apiCalls[0], {
    method: "chat.update",
    args: { channel: CHANNEL, ts: THREAD, text: "`[devops]` fix the footer" },
  });
});

test("a pin that is already there, and one that is already gone, are not failures", async () => {
  const pinning = made(PLAIN);
  pinning.owner.responses["pins.add"] = rejected("already_pinned");
  await pinning.tagger.tag(CHANNEL, THREAD, "devops");
  assert.ok(pinning.owner.apiCalls.some((call) => call.method === "pins.add"));

  for (const code of ["not_pinned", "no_pin"]) {
    const unpinning = made(
      root([rich(TAG, SPACE, HELLO)], "`[devops]` x", { pinned_to: [CHANNEL] }),
    );
    unpinning.owner.responses["pins.remove"] = rejected(code);
    await unpinning.tagger.tag(CHANNEL, THREAD, null);
    assert.ok(
      unpinning.owner.apiCalls.some((call) => call.method === "pins.remove"),
      code,
    );
  }
});

async function failure(promise: Promise<void>): Promise<ChatError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ChatError, String(error));
    return error;
  }
  throw new Error("it did not fail");
}

test("any other refusal is a ChatError named by Slack's code, and later steps do not run", async () => {
  const reading = made(rejected("channel_not_found"));
  assert.equal(
    (await failure(reading.tagger.tag(CHANNEL, THREAD, "devops"))).name,
    "channel_not_found",
  );
  assert.deepEqual(reading.owner.apiCalls, []);

  const editing = made(PLAIN);
  editing.owner.responses["chat.update"] = rejected("cant_update_message");
  assert.equal(
    (await failure(editing.tagger.tag(CHANNEL, THREAD, "devops"))).name,
    "cant_update_message",
  );
  assert.deepEqual(
    editing.owner.apiCalls.map((call) => call.method),
    ["chat.update"],
    "a root that could not be edited is not pinned",
  );

  const pinning = made(PLAIN);
  pinning.owner.responses["pins.add"] = rejected("too_many_pins");
  assert.equal(
    (await failure(pinning.tagger.tag(CHANNEL, THREAD, "devops"))).name,
    "too_many_pins",
  );

  const unpinning = made(root([rich(TAG, SPACE, HELLO)], "`[devops]` x", { pinned_to: [CHANNEL] }));
  unpinning.owner.responses["pins.remove"] = rejected("restricted_action");
  assert.equal(
    (await failure(unpinning.tagger.tag(CHANNEL, THREAD, null))).name,
    "restricted_action",
  );
});

test("a root that Slack does not return among the messages is a ChatError", async () => {
  const { tagger } = made(root([rich(HELLO)], "x", { ts: "1780000000.999999" }));
  assert.equal((await failure(tagger.tag(CHANNEL, THREAD, "devops"))).name, "root_not_returned");
});

// --- The title

const TITLE = { type: "text", text: "Fix the footer", style: { bold: true } };

test("a titled root is one section: the tag when there is one, then the title in bold", () => {
  assert.deepEqual(retitledBlocks([rich(HELLO, MENTION)], "Fix the footer", null), [rich(TITLE)]);
  assert.deepEqual(retitledBlocks([rich(TAG, SPACE, HELLO)], "Fix the footer", "devops"), [
    rich(TAG, SPACE, TITLE),
  ]);
  // Whatever the root held, blocks of other kinds and later sections included, is gone.
  const section = { type: "section", text: { type: "mrkdwn", text: "hi" } };
  const two = {
    type: "rich_text",
    block_id: "b1",
    elements: [
      { type: "rich_text_section", elements: [HELLO] },
      { type: "rich_text_preformatted", elements: [HELLO] },
    ],
  };
  assert.deepEqual(retitledBlocks([two, section], "Fix the footer", null), [rich(TITLE)]);
  assert.deepEqual(retitledBlocks([section], "Fix the footer", null), [
    { type: "rich_text", elements: [{ type: "rich_text_section", elements: [TITLE] }] },
  ]);
});

test("the text of a titled root is the tag in backticks and the title in bold, escaped", () => {
  assert.equal(retitledText("Fix the footer", null), "*Fix the footer*");
  assert.equal(retitledText("Fix the footer", "devops"), "`[devops]` *Fix the footer*");
  assert.equal(retitledText("a < b & c > d", null), "*a &lt; b &amp; c &gt; d*");
});

test("a title rewrites the root, the owner's words included, and keeps its tag", async () => {
  const { bot, owner, tagger } = made(PLAIN);
  await tagger.title(CHANNEL, THREAD, "Fix the footer");
  assert.deepEqual(bot.apiCalls, [
    { method: "conversations.replies", args: { channel: CHANNEL, ts: THREAD, limit: 1 } },
  ]);
  assert.deepEqual(owner.apiCalls, [
    {
      method: "chat.update",
      args: { channel: CHANNEL, ts: THREAD, text: "*Fix the footer*", blocks: [rich(TITLE)] },
    },
  ]);
  const tagged = made(root([rich(TAG, SPACE, HELLO)], "`[devops]` fix the footer "));
  await tagged.tagger.title(CHANNEL, THREAD, "Fix the footer");
  assert.deepEqual(tagged.owner.apiCalls[0]?.args, {
    channel: CHANNEL,
    ts: THREAD,
    text: "`[devops]` *Fix the footer*",
    blocks: [rich(TAG, SPACE, TITLE)],
  });
});

test("a title already on the root, or a new one, sends an edit only when it changes", async () => {
  const same = made(root([rich(TAG, SPACE, TITLE)], "`[devops]` *Fix the footer*"));
  await same.tagger.title(CHANNEL, THREAD, "Fix the footer");
  assert.deepEqual(same.owner.apiCalls, []);
  const other = made(root([rich(TAG, SPACE, TITLE)], "`[devops]` *Fix the footer*"));
  await other.tagger.title(CHANNEL, THREAD, "Fix the header");
  assert.equal(other.owner.apiCalls[0]?.args.text, "`[devops]` *Fix the header*");
});

test("a title with line breaks is one line", async () => {
  const { owner, tagger } = made(PLAIN);
  await tagger.title(CHANNEL, THREAD, "  Fix\nthe   footer \n");
  assert.equal(owner.apiCalls[0]?.args.text, "*Fix the footer*");
});

test("a root with no blocks is titled through its text alone", async () => {
  const { owner, tagger } = made(root(null, "`[ops]` fix the footer"));
  await tagger.title(CHANNEL, THREAD, "Fix the footer");
  assert.deepEqual(owner.apiCalls[0], {
    method: "chat.update",
    args: { channel: CHANNEL, ts: THREAD, text: "`[ops]` *Fix the footer*" },
  });
});

test("!tag and !untag work on a titled root, and the title stays", async () => {
  const titled = root([rich(TITLE)], "*Fix the footer*");
  const tagging = made(titled);
  await tagging.tagger.tag(CHANNEL, THREAD, "devops");
  assert.deepEqual(tagging.owner.apiCalls[0]?.args, {
    channel: CHANNEL,
    ts: THREAD,
    text: "`[devops]` *Fix the footer*",
    blocks: [rich(TAG, SPACE, TITLE)],
  });
  const untagging = made(
    root([rich(TAG, SPACE, TITLE)], "`[devops]` *Fix the footer*", { pinned_to: [CHANNEL] }),
  );
  await untagging.tagger.tag(CHANNEL, THREAD, null);
  assert.deepEqual(untagging.owner.apiCalls[0]?.args, {
    channel: CHANNEL,
    ts: THREAD,
    text: "*Fix the footer*",
    blocks: [rich(TITLE)],
  });
  assert.deepEqual(rootMarks(root([rich(TAG, SPACE, TITLE)], "x")).tag, "devops");
  assert.equal(rootMarks(root([rich(TITLE)], "x")).tag, null);
});

test("a refused title is a ChatError named by Slack's code", async () => {
  const editing = made(PLAIN);
  editing.owner.responses["chat.update"] = rejected("rate_limited_here");
  assert.equal(
    (await failure(editing.tagger.title(CHANNEL, THREAD, "Fix"))).name,
    "rate_limited_here",
  );
});

test("a tag and a title asked together edit the root one after the other, each on the last", async () => {
  // A root as the chat holds it, changed by each edit: a read that ran before the earlier edit
  // landed would write the earlier edit away.
  const bot = new FakeSlack();
  const owner = new FakeSlack();
  let current = PLAIN;
  const order: string[] = [];
  bot.responses["conversations.replies"] = () => {
    order.push("read");
    return { ok: true, messages: [structuredClone(current)], has_more: false };
  };
  owner.responses["chat.update"] = (args: JsonObject) => {
    order.push("write");
    current = { ...current, text: args.text, blocks: args.blocks } as JsonObject;
    return { ok: true };
  };
  const editor = new RootEditor(bot, owner);
  await Promise.all([
    editor.title(CHANNEL, THREAD, "Fix the footer"),
    editor.tag(CHANNEL, THREAD, "devops"),
  ]);
  assert.deepEqual(order, ["read", "write", "read", "write"]);
  assert.deepEqual(current.blocks, [rich(TAG, SPACE, TITLE)]);
  assert.equal(current.text, "`[devops]` *Fix the footer*");
});

test("a failed edit does not hold back the next one of the same root", async () => {
  const { owner, tagger } = made(PLAIN);
  owner.responses["chat.update"] = rejected("cant_update_message_x");
  const first = failure(tagger.title(CHANNEL, THREAD, "Fix"));
  const second = failure(tagger.title(CHANNEL, THREAD, "Fix again"));
  assert.equal((await first).name, "cant_update_message_x");
  assert.equal((await second).name, "cant_update_message_x");
  assert.equal(owner.apiCalls.length, 2);
});

test("a title refused for good is a permanent ChatError, any other refusal is not", async () => {
  for (const code of [
    "edit_window_closed",
    "cant_update_message",
    "message_not_found",
    "thread_not_found",
  ]) {
    const { owner, tagger } = made(PLAIN);
    owner.responses["chat.update"] = rejected(code);
    const error = await failure(tagger.title(CHANNEL, THREAD, "Fix"));
    assert.equal(error.name, code);
    assert.equal(error.permanent, true, code);
  }
  const { owner, tagger } = made(PLAIN);
  owner.responses["chat.update"] = rejected("ratelimited");
  assert.equal((await failure(tagger.title(CHANNEL, THREAD, "Fix"))).permanent, false);
  // A tag edit refused the same way is not marked: only the title is retried by the core.
  const tagging = made(PLAIN);
  tagging.owner.responses["chat.update"] = rejected("cant_update_message");
  assert.equal((await failure(tagging.tagger.tag(CHANNEL, THREAD, "devops"))).permanent, false);
});

test("title hands keep the root's words as the agent receives a message, then edits, from one read", async () => {
  const words = "fix the *footer* &amp; &lt;b&gt; <https://example.com|the site> <@U000BOB>";
  const { bot, owner, tagger } = made(root([rich(TAG, SPACE, HELLO)], `\`[devops]\` ${words}`));
  const kept: string[] = [];
  await tagger.title(CHANNEL, THREAD, "Fix the footer", (text) => {
    // Nothing is edited before the callback has finished.
    assert.deepEqual(owner.apiCalls, []);
    kept.push(text);
  });
  // The conversion of an inbound message (`slackUnescape`), the tag left out.
  assert.deepEqual(kept, ["fix the *footer* & <b> the site (https://example.com) <@U000BOB>"]);
  assert.equal(bot.apiCalls.length, 1, "one conversations.replies");
  assert.equal(owner.apiCalls.length, 1);
  assert.equal(owner.apiCalls[0]?.method, "chat.update");
});

test("title waits for an asynchronous keep, and edits nothing when keep throws", async () => {
  const order: string[] = [];
  const slow = made(PLAIN);
  await slow.tagger.title(CHANNEL, THREAD, "Fix", async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(`kept after ${slow.owner.apiCalls.length} edits`);
  });
  assert.deepEqual(order, ["kept after 0 edits"]);
  assert.equal(slow.owner.apiCalls.length, 1);

  const failing = made(PLAIN);
  await assert.rejects(
    failing.tagger.title(CHANNEL, THREAD, "Fix", () => {
      throw new Error("state.json cannot be written");
    }),
    (error: unknown) => error instanceof ChatError && error.name === "Error" && !error.permanent,
  );
  assert.deepEqual(failing.owner.apiCalls, [], "no edit after a failed keep");
});

test("an empty root is kept as the empty text, a bold-only root as the owner wrote it", async () => {
  const empty = made(root([rich(HELLO)], ""));
  const emptyKept: string[] = [];
  await empty.tagger.title(CHANNEL, THREAD, "Fix", (text) => void emptyKept.push(text));
  assert.deepEqual(emptyKept, [""]);
  const bold = made(root([rich(TITLE)], "*Fix the footer*"));
  const boldKept: string[] = [];
  await bold.tagger.title(CHANNEL, THREAD, "Other", (text) => void boldKept.push(text));
  assert.deepEqual(boldKept, ["*Fix the footer*"], "taken for the owner's words, not for a title");
});

test("title with no keep reads and edits as before", async () => {
  const { bot, owner, tagger } = made(PLAIN);
  await tagger.title(CHANNEL, THREAD, "Fix");
  assert.equal(bot.apiCalls.length, 1);
  assert.equal(owner.apiCalls.length, 1);
});

test("a root that cannot be read for good is a permanent ChatError, and nothing is kept or edited", async () => {
  for (const code of [
    "message_not_found",
    "thread_not_found",
    "channel_not_found",
    "not_in_channel",
    "missing_scope",
  ]) {
    const { owner, tagger } = made(rejected(code));
    let kept = 0;
    const error = await failure(
      tagger.title(CHANNEL, THREAD, "Fix", () => {
        kept += 1;
      }),
    );
    assert.equal(error.name, code);
    assert.equal(error.permanent, true, code);
    assert.equal(kept, 0);
    assert.deepEqual(owner.apiCalls, []);
  }
  const transient = made(rejected("ratelimited"));
  assert.equal((await failure(transient.tagger.title(CHANNEL, THREAD, "Fix"))).permanent, false);
});

test("a root returned as a tombstone is gone: nothing is kept, titled or tagged", async () => {
  const tombstone = root(null, "This message was deleted.", {
    subtype: "tombstone",
    reply_count: 2,
  });
  const titling = made(tombstone);
  let kept = 0;
  const error = await failure(
    titling.tagger.title(CHANNEL, THREAD, "Fix", () => {
      kept += 1;
    }),
  );
  assert.equal(error.name, "thread_not_found");
  assert.equal(error.permanent, true);
  assert.equal(kept, 0, "the tombstone's text is not kept as the prompt");
  assert.deepEqual(titling.owner.apiCalls, []);
  const tagging = made(tombstone);
  assert.equal(
    (await failure(tagging.tagger.tag(CHANNEL, THREAD, "devops"))).name,
    "thread_not_found",
  );
  assert.deepEqual(tagging.owner.apiCalls, [], "neither edited nor pinned");
});
