/**
 * Step 11 of the scenario the memory chat carries: `!diff` in a session's thread. The channel's
 * folder is a real git repository the plain agent trusts; the owner lists what changed, shares one
 * file's diff, and a repository the agent does not trust is refused.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as texts from "../../src/core/texts.ts";
import { commitAll } from "../support/files.ts";
import { committed } from "../support/git-layouts.ts";
import { say } from "../support/plain-agent.ts";
import { World } from "./world.ts";

/** A session's thread in a committed repository whose README the owner then edits. */
async function session(world: World): Promise<string> {
  committed(world.folder);
  writeFileSync(join(world.folder, "a.txt"), "one\n");
  commitAll(world.folder);
  world.script(say("Hello."));
  const thread = await world.open("hello");
  await world.ended(thread);
  writeFileSync(join(world.folder, "a.txt"), "one\ntwo\n");
  return thread;
}

test("!diff lists the changed files and a control shares one file's diff", async (t) => {
  const world = World.make(t, { diff: { trusted: true } });
  await world.start();
  const thread = await session(world);

  await world.owner.says(world.channel, "!diff", { thread });
  const [list] = world.chat.threadLists();
  assert.ok(list, "a list is open in the thread");
  assert.equal(list.list.type, "diff");
  assert.deepEqual(list.list.type === "diff" && list.list.files, [
    { path: "a.txt", added: 1, removed: 0, binary: false },
  ]);

  assert.equal(await world.owner.picksFile(list.message, "a.txt"), true);
  const [shared] = world.chat.shared();
  assert.equal(shared?.name, "a.txt.diff");
  assert.match(shared?.content ?? "", /\n\+two\n/);
  assert.deepEqual(world.prompts(), ["hello"], "nothing of this reached the agent");
  await world.finish();
});

test("!diff in a repository the agent has not trusted is refused with the trust line", async (t) => {
  const world = World.make(t, { diff: { trusted: false } });
  await world.start();
  const thread = await session(world);

  await world.owner.says(world.channel, "!diff", { thread });
  const told = world.shown(thread).at(-1) ?? "";
  assert.ok(told.includes("has not trusted this repository"), told);
  assert.ok(told.includes(`trust ${world.folder}`) || told.includes(world.folder), told);
  assert.deepEqual(world.chat.threadLists(), []);
  await world.finish();
});

test("!diff typed in the channel is refused there", async (t) => {
  const world = World.make(t, { diff: { trusted: true } });
  await world.start();
  await world.owner.says(world.channel, "!diff");
  assert.ok(world.chat.texts(world.channel).includes(texts.DIFF_TOP_LEVEL));
  await world.finish();
});
