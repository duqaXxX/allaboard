/**
 * `!diff` through the message flow: the files a session's repository changed since HEAD, listed in
 * the thread with a control per file, and the file's diff shared when the control is used. The
 * repository is a real temporary one, reached through an agent that keeps a record of trust.
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ThreadRef } from "../../../src/chat/seam.ts";
import { Cancelled } from "../../../src/core/sessions/tasks.ts";
import * as texts from "../../../src/core/texts.ts";
import { shellQuote } from "../../../src/text.ts";
import { commitAll } from "../../support/files.ts";
import { committed } from "../../support/git-layouts.ts";
import { call, say } from "../../support/plain-agent.ts";
import { MessagesWorld, WithFolderTrust } from "./messages-world.ts";

/** A world whose channel is bound to a committed repository the agent trusts; the thread is open. */
async function repositoryWorld(
  t: Parameters<typeof MessagesWorld.make>[0],
  trust = true,
  options: { fits?: number; noUnshare?: boolean } = {},
) {
  const agent = new WithFolderTrust();
  const world = await MessagesWorld.make(t, { agent, diff: true, ...options });
  const repo = committed(join(world.folder, "repo"));
  writeFileSync(join(repo, "src.txt"), "one\ntwo\n");
  commitAll(repo);
  if (trust) agent.trusted.add(repo);
  world.state.bind(world.channel, repo);
  const ref = await world.opened("the first task");
  return { world, agent, repo, ref };
}

function listOf(world: MessagesWorld, ref: ThreadRef) {
  const [open] = world.chat.threadLists().filter((list) => list.ref.thread === ref.thread);
  assert.ok(open, "a list is open in the thread");
  const { list } = open;
  assert.equal(list.type, "diff");
  return { ...open, list: list as Extract<typeof list, { type: "diff" }> };
}

test("!diff lists the changed files of the repository with their counts", async (t) => {
  const { world, repo, ref } = await repositoryWorld(t);
  writeFileSync(join(repo, "src.txt"), "one\nthree\nfour\n");
  writeFileSync(join(repo, "fresh.txt"), "a\nb\n");
  await world.says("!diff", ref.thread);
  await world.settle();

  const open = listOf(world, ref);
  assert.equal(open.list.type, "diff");
  assert.equal(open.list.view, "current");
  assert.deepEqual(open.list.files, [
    { path: "fresh.txt", added: 2, removed: 0, binary: false },
    { path: "src.txt", added: 2, removed: 1, binary: false },
  ]);
  assert.equal(open.list.session, world.state.thread(ref.channel, ref.thread)?.sessionId);
  assert.equal(open.title, texts.DIFF_TITLE);
});

test("a file's control shares its unified diff as <name>.diff", async (t) => {
  const { world, repo, ref } = await repositoryWorld(t);
  mkdirSync(join(repo, "dir"));
  writeFileSync(join(repo, "dir", "new.txt"), "x\n");
  writeFileSync(join(repo, "src.txt"), "one\nthree\n");
  await world.says("!diff", ref.thread);
  await world.settle();
  const { message } = listOf(world, ref);

  assert.equal(await world.chat.as("alice").picksFile(message, "src.txt"), true);
  await world.settle();
  const [edit] = world.chat.shared();
  assert.equal(edit?.name, "src.txt.diff");
  assert.equal(edit?.title, "src.txt.diff");
  assert.match(edit?.content ?? "", /^diff --git a\/src.txt b\/src.txt\n/);
  assert.match(edit?.content ?? "", /\n-two\n\+three\n/);
  // The list shows one thing at a time: the next pick deletes this file.
  assert.equal(await world.chat.as("alice").picksFile(message, "dir/new.txt"), true);
  await world.settle();
  const [created, ...others] = world.chat.shared();
  assert.deepEqual(others, []);
  assert.equal(created?.name, "new.txt.diff");
  assert.equal(created?.title, "dir/new.txt.diff");
  assert.match(created?.content ?? "", /\nnew file mode 100644\n/);
  assert.match(created?.content ?? "", /\n\+x\n$/);
});

test("a folder that is not a repository is refused", async (t) => {
  const agent = new WithFolderTrust();
  const world = await MessagesWorld.make(t, { agent, diff: true });
  const plain = join(world.folder, "plain");
  mkdirSync(plain);
  world.state.bind(world.channel, plain);
  const ref = await world.opened("the first task");
  await world.says("!diff", ref.thread);
  await world.settle();
  assert.equal(world.shown(ref).at(-1), texts.DIFF_NOT_A_REPOSITORY);
  assert.deepEqual(world.chat.threadLists(), []);
});

test("a repository the owner has not trusted is refused with the line that asks for the trust", async (t) => {
  const { world, repo, ref } = await repositoryWorld(t, false);
  writeFileSync(join(repo, "src.txt"), "changed\n");
  await world.says("!diff", ref.thread);
  await world.settle();
  const line = world.shown(ref).at(-1) ?? "";
  assert.ok(line.includes("has not trusted this repository"), line);
  assert.ok(line.includes(`cd ${shellQuote(repo)} && plain`), line);
  assert.deepEqual(world.chat.threadLists(), []);
});

test("a clean tree has nothing to list", async (t) => {
  const { world, ref } = await repositoryWorld(t);
  await world.says("!diff", ref.thread);
  await world.settle();
  assert.equal(world.shown(ref).at(-1), texts.DIFF_CLEAN);
  assert.deepEqual(world.chat.threadLists(), []);
});

test("typed in the channel the word is refused", async (t) => {
  const { world } = await repositoryWorld(t);
  await world.says("!diff");
  await world.settle();
  assert.ok(world.inChannel().includes(texts.DIFF_TOP_LEVEL));
});

test("a word with text after it shows the help", async (t) => {
  const { world, ref } = await repositoryWorld(t);
  await world.says("!diff src.txt", ref.thread);
  await world.settle();
  assert.ok(world.shown(ref).some((line) => line.includes("`!diff`")));
  assert.deepEqual(world.chat.threadLists(), []);
});

test("a chat without lists and files does not offer the word", async (t) => {
  const agent = new WithFolderTrust();
  const world = await MessagesWorld.make(t, { agent });
  const repo = committed(join(world.folder, "repo"));
  agent.trusted.add(repo);
  world.state.bind(world.channel, repo);
  const ref = await world.opened("the first task");
  writeFileSync(join(repo, "README"), "changed\n");
  await world.says("!diff", ref.thread);
  await world.settle();
  assert.ok(world.shown(ref).at(-1)?.includes("`!diff` is not offered here"));
  await world.says("!help", ref.thread);
  await world.settle();
  assert.doesNotMatch(world.shown(ref).join("\n"), /^`!diff` the files/m);
});

test("!help lists the word where it is offered", async (t) => {
  const { world, ref } = await repositoryWorld(t);
  await world.says("!help", ref.thread);
  await world.settle();
  assert.match(world.shown(ref).join("\n"), /^`!diff` the files/m);
});

test("an agent with no record of trust does not offer the word", async (t) => {
  const world = await MessagesWorld.make(t, { diff: true });
  const ref = await world.opened("the first task");
  await world.says("!diff", ref.thread);
  await world.settle();
  assert.ok(world.shown(ref).at(-1)?.includes("`!diff` is not offered here"));
});

test("a list made for another session is refused", async (t) => {
  const { world, repo, ref } = await repositoryWorld(t);
  writeFileSync(join(repo, "src.txt"), "changed\n");
  await world.says("!diff", ref.thread);
  await world.settle();
  const { message } = listOf(world, ref);
  world.state.setSession(ref.channel, ref.thread, "another-session");

  await world.chat.as("alice").picksFile(message, "src.txt");
  await world.settle();
  assert.equal(world.shown(ref).at(-1), texts.DIFF_STALE);
  assert.deepEqual(world.chat.shared(), []);
});

test("a file committed since the list was drawn is told as unchanged", async (t) => {
  const { world, repo, ref } = await repositoryWorld(t);
  writeFileSync(join(repo, "src.txt"), "changed\n");
  await world.says("!diff", ref.thread);
  await world.settle();
  const { message } = listOf(world, ref);
  commitAll(repo, "later");

  await world.chat.as("alice").picksFile(message, "src.txt");
  await world.settle();
  assert.equal(world.shown(ref).at(-1), "`src.txt` no longer differs from HEAD.");
  assert.deepEqual(world.chat.shared(), []);
});

test("a binary file is listed and its control tells there is no text diff", async (t) => {
  const { world, repo, ref } = await repositoryWorld(t);
  writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 0]));
  await world.says("!diff", ref.thread);
  await world.settle();
  const { message, list } = listOf(world, ref);
  assert.deepEqual(
    list.files.find((file) => file.path === "blob.bin"),
    { path: "blob.bin", added: 0, removed: 0, binary: true },
  );
  await world.chat.as("alice").picksFile(message, "blob.bin");
  await world.settle();
  assert.equal(world.shown(ref).at(-1), "`blob.bin` is binary: git shows no text diff for it.");
});

test("a pick from someone else reaches nothing", async (t) => {
  const { world, repo, ref } = await repositoryWorld(t);
  writeFileSync(join(repo, "src.txt"), "changed\n");
  await world.says("!diff", ref.thread);
  await world.settle();
  const { message } = listOf(world, ref);
  assert.equal(await world.chat.as("bob").picksFile(message, "src.txt"), false);
  await world.settle();
  assert.deepEqual(world.chat.shared(), []);
});

test("a path outside the repository shares nothing", async (t) => {
  const { world, repo, ref } = await repositoryWorld(t);
  writeFileSync(join(repo, "src.txt"), "changed\n");
  writeFileSync(join(world.folder, "outside.txt"), "secret\n");
  await world.says("!diff", ref.thread);
  await world.settle();
  const { message, list } = listOf(world, ref);
  // The control's value is untrusted: the core reads what the repository says about the path.
  const forged = {
    ...list,
    files: [{ path: "../outside.txt", added: 1, removed: 0, binary: false }],
  };
  world.chat.addThreadList({ ...listOf(world, ref), list: forged });
  await world.chat.as("alice").picksFile(message, "../outside.txt");
  await world.settle();
  assert.deepEqual(world.chat.shared(), []);
});

// --- the views of a turn

function editing(path: string, lines: string[], oldStart = 1) {
  return call(
    "change",
    { path },
    {
      fileChange: {
        path,
        kind: "edited",
        hunks: [{ oldStart, newStart: oldStart, lines }],
        content: null,
      },
    },
  );
}

test("once turns edited files, a selector offers a view per turn with only that turn's hunks", async (t) => {
  const { world, agent, repo, ref } = await repositoryWorld(t);
  const a = join(repo, "src.txt");
  const b = join(repo, "other.txt");
  agent.next(editing(a, [" one", "-two", "+TWO"]), say("First done."));
  await world.says("edit once", ref.thread);
  await world.settle();
  agent.next(editing(a, [" one", "-TWO", "+2"]), editing(b, ["+fresh"]), say("Second done."));
  await world.says("edit twice", ref.thread);
  await world.settle();
  writeFileSync(a, "one\n2\n");

  await world.says("!diff", ref.thread);
  await world.settle();
  const open = listOf(world, ref);
  assert.deepEqual(
    open.list.views.map((view) => view.label),
    ["Current", "T2", "T3"],
    "the first prompt ran no edit, the setup's turn counts",
  );
  const [, first, second] = open.list.views;
  assert.ok(first && second);

  await world.chat.as("alice").picksView(open.message, first.id);
  await world.settle();
  const redrawn = listOf(world, ref);
  assert.equal(redrawn.message, open.message, "the same message, drawn again");
  assert.equal(redrawn.list.view, first.id);
  assert.deepEqual(redrawn.list.files, [{ path: "src.txt", added: 1, removed: 1, binary: false }]);

  await world.chat.as("alice").picksFile(redrawn.message, "src.txt");
  await world.settle();
  const [shared] = world.chat.shared();
  assert.match(shared?.content ?? "", /\n-two\n\+TWO\n/);
  assert.doesNotMatch(
    shared?.content ?? "",
    /\+2\n/,
    "the second turn's hunk is not in the first's",
  );

  await world.chat.as("alice").picksView(redrawn.message, second.id);
  await world.settle();
  assert.deepEqual(
    listOf(world, ref).list.files.map((file) => file.path),
    ["other.txt", "src.txt"],
  );
});

test("a turn's edit outside the repository is not listed", async (t) => {
  const { world, agent, repo, ref } = await repositoryWorld(t);
  agent.next(editing(join(world.folder, "outside.txt"), ["+x"]), say("Done."));
  await world.says("edit elsewhere", ref.thread);
  await world.settle();
  writeFileSync(join(repo, "src.txt"), "changed\n");
  await world.says("!diff", ref.thread);
  await world.settle();
  assert.deepEqual(
    listOf(world, ref).list.views.map((view) => view.label),
    ["Current"],
  );
});

test("after a restart the turns are gone and a pick of their view says so", async (t) => {
  const { world, agent, repo, ref } = await repositoryWorld(t);
  agent.next(editing(join(repo, "src.txt"), ["-two", "+TWO"]), say("Done."));
  await world.says("edit", ref.thread);
  await world.settle();
  writeFileSync(join(repo, "src.txt"), "one\nTWO\n");
  await world.says("!diff", ref.thread);
  await world.settle();
  const open = listOf(world, ref);
  const turn = open.list.views[1];
  assert.ok(turn);
  await world.sessions.closeAll();
  await world.chat.as("alice").picksView(open.message, turn.id);
  await world.settle();
  assert.equal(world.shown(ref).at(-1), texts.DIFF_VIEW_GONE);
});

test("a path the list never held, a directory or the whole tree, shares nothing", async (t) => {
  const { world, repo, ref } = await repositoryWorld(t);
  mkdirSync(join(repo, "dir"));
  writeFileSync(join(repo, "dir", "a.txt"), "x\n");
  writeFileSync(join(repo, "src.txt"), "changed\n");
  await world.says("!diff", ref.thread);
  await world.settle();
  const listed = listOf(world, ref);
  for (const path of [".", "dir", "dir/", "*.txt", ":/"]) {
    const forged = { ...listed.list, files: [{ path, added: 1, removed: 0, binary: false }] };
    world.chat.addThreadList({ ...listed, list: forged });
    await world.chat.as("alice").picksFile(listed.message, path);
    await world.settle();
    assert.deepEqual(world.chat.shared(), [], path);
    assert.equal(world.shown(ref).at(-1), `\`${path}\` no longer differs from HEAD.`, path);
  }
});

test("a diff over what the chat takes as one file is told and not shared", async (t) => {
  const agent = new WithFolderTrust();
  const world = await MessagesWorld.make(t, { agent, diff: true, fileLimit: 300 });
  const repo = committed(join(world.folder, "repo"));
  writeFileSync(join(repo, "src.txt"), "one\n");
  commitAll(repo);
  agent.trusted.add(repo);
  world.state.bind(world.channel, repo);
  const ref = await world.opened("the first task");
  writeFileSync(join(repo, "src.txt"), "a long line of text\n".repeat(100));
  await world.says("!diff", ref.thread);
  await world.settle();
  await world.chat.as("alice").picksFile(listOf(world, ref).message, "src.txt");
  await world.settle();
  assert.deepEqual(world.chat.shared(), []);
  assert.equal(
    world.shown(ref).at(-1),
    "The diff of `src.txt` is over 300 bytes, the most Memory chat takes as one file.",
  );
});

// --- a diff shown in the list's own message

/** A world whose chat draws a diff of up to 400 characters in the list, with a small and a large file changed. */
async function shownWorld(
  t: Parameters<typeof MessagesWorld.make>[0],
  options: { noUnshare?: boolean } = {},
) {
  const built = await repositoryWorld(t, true, { fits: 400, ...options });
  writeFileSync(join(built.repo, "src.txt"), "one\nthree\n");
  writeFileSync(join(built.repo, "small.txt"), "a\n");
  writeFileSync(join(built.repo, "big.txt"), "a long line of text\n".repeat(100));
  writeFileSync(join(built.repo, "huge.txt"), "another long line\n".repeat(100));
  await built.world.says("!diff", built.ref.thread);
  await built.world.settle();
  return { ...built, message: listOf(built.world, built.ref).message };
}

const alice = (world: MessagesWorld) => world.chat.as("alice");

/** Makes the nth read of the repository (0 for the first) wait for `gate` and, when asked, fail. */
function holdRepository(world: MessagesWorld, holds: Map<number, Promise<void>>, failing = -1) {
  const original = world.sessions.repository.bind(world.sessions);
  let calls = 0;
  world.sessions.repository = async (directory) => {
    const call = calls++;
    await holds.get(call);
    if (call === failing) throw new Cancelled();
    return original(directory);
  };
}

/** Long enough for an unqueued second pick's git reads to end while the first is held. */
function later(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 400));
}

test("a small diff is drawn in the list's own message and shares no file", async (t) => {
  const { world, ref, message } = await shownWorld(t);
  await alice(world).picksFile(message, "src.txt");
  await world.settle();
  const open = listOf(world, ref);
  assert.equal(open.message, message, "the same message");
  assert.equal(open.list.shown?.path, "src.txt");
  assert.match(open.list.shown?.text ?? "", /\n-two\n\+three\n/);
  assert.deepEqual(world.chat.shared(), []);
});

test("a second click replaces the diff the list shows", async (t) => {
  const { world, ref, message } = await shownWorld(t);
  await alice(world).picksFile(message, "src.txt");
  await world.settle();
  await alice(world).picksFile(message, "small.txt");
  await world.settle();
  assert.equal(listOf(world, ref).list.shown?.path, "small.txt");
  assert.deepEqual(world.chat.shared(), []);
});

test("a large diff is shared as a file and the list is drawn with no diff", async (t) => {
  const { world, ref, message } = await shownWorld(t);
  await alice(world).picksFile(message, "src.txt");
  await world.settle();
  await alice(world).picksFile(message, "big.txt");
  await world.settle();
  assert.equal(listOf(world, ref).list.shown, undefined);
  assert.deepEqual(
    world.chat.shared().map((file) => file.name),
    ["big.txt.diff"],
  );
});

test("the next click, or a view change, deletes the file the list shared", async (t) => {
  const { world, ref, message } = await shownWorld(t);
  await alice(world).picksFile(message, "big.txt");
  await world.settle();
  assert.equal(world.chat.shared().length, 1);
  await alice(world).picksFile(message, "small.txt");
  await world.settle();
  assert.deepEqual(world.chat.shared(), []);
  assert.equal(listOf(world, ref).list.shown?.path, "small.txt");

  await alice(world).picksFile(message, "big.txt");
  await world.settle();
  assert.equal(world.chat.shared().length, 1);
  await alice(world).picksView(message, "current");
  await world.settle();
  assert.deepEqual(world.chat.shared(), []);
  assert.equal(listOf(world, ref).list.shown, undefined);
});

test("two clicks whose reads end in reverse order leave the last click's diff shown", async (t) => {
  const { world, ref, message } = await shownWorld(t);
  let release = () => {};
  holdRepository(world, new Map([[0, new Promise<void>((resolve) => (release = resolve))]]));
  const first = alice(world).picksFile(message, "src.txt");
  const second = alice(world).picksFile(message, "small.txt");
  await later();
  release();
  await Promise.all([first, second]);
  await world.settle();
  assert.equal(listOf(world, ref).list.shown?.path, "small.txt");
});

test("two large clicks whose reads end in reverse order leave one file, the last click's", async (t) => {
  const { world, message } = await shownWorld(t);
  let release = () => {};
  holdRepository(world, new Map([[0, new Promise<void>((resolve) => (release = resolve))]]));
  const first = alice(world).picksFile(message, "big.txt");
  const second = alice(world).picksFile(message, "huge.txt");
  await later();
  release();
  await Promise.all([first, second]);
  await world.settle();
  assert.deepEqual(
    world.chat.shared().map((file) => file.name),
    ["huge.txt.diff"],
  );
});

test("a pick that rejects does not stop the one queued behind it", async (t) => {
  const { world, ref, message } = await shownWorld(t);
  holdRepository(world, new Map(), 0);
  const first = alice(world).picksFile(message, "src.txt");
  const second = alice(world).picksFile(message, "small.txt");
  const [failed, done] = await Promise.allSettled([first, second]);
  assert.equal(failed.status, "rejected");
  assert.equal(done.status, "fulfilled");
  await world.settle();
  assert.equal(listOf(world, ref).list.shown?.path, "small.txt");
});

test("a pick arriving while the second runs, after the first settled, runs after the second", async (t) => {
  const { world, ref, message } = await shownWorld(t);
  let release = () => {};
  holdRepository(world, new Map([[1, new Promise<void>((resolve) => (release = resolve))]]));
  const first = alice(world).picksFile(message, "src.txt");
  const second = alice(world).picksFile(message, "small.txt");
  await first;
  // The first has settled and the second runs, held at its read: the chain's entry is the
  // second's own, and the third must queue behind it.
  const third = alice(world).picksView(message, "current");
  await later();
  release();
  await Promise.all([second, third]);
  await world.settle();
  assert.equal(listOf(world, ref).list.shown, undefined, "the view change, the last, ran last");
});

test("an idle close keeps the file the list shared, and the next pick deletes it", async (t) => {
  const { world, message } = await shownWorld(t);
  await alice(world).picksFile(message, "big.txt");
  await world.settle();
  await world.sessions.closeAll();
  await alice(world).picksFile(message, "small.txt");
  await world.settle();
  assert.deepEqual(world.chat.shared(), []);
});

test("a list made for another session is told stale and its file is deleted", async (t) => {
  const { world, ref, message } = await shownWorld(t);
  await alice(world).picksFile(message, "big.txt");
  await world.settle();
  const session = world.state.thread(ref.channel, ref.thread)?.sessionId ?? "";
  world.state.setSession(ref.channel, ref.thread, "another-session");
  await alice(world).picksFile(message, "small.txt");
  await world.settle();
  assert.equal(world.shown(ref).at(-1), texts.DIFF_STALE);
  assert.deepEqual(world.chat.shared(), [], "the file does not stay in the thread");
  world.state.setSession(ref.channel, ref.thread, session);
  await alice(world).picksFile(message, "big.txt");
  await world.settle();
  assert.equal(world.chat.shared().length, 1, "and the list forgot it, so one file is there");
});

test("a chat that cannot delete a file is not asked to, and one that fails to is ignored", async (t) => {
  const { world, ref, message } = await shownWorld(t);
  world.chat.unshareRefused = true;
  await alice(world).picksFile(message, "big.txt");
  await world.settle();
  await alice(world).picksFile(message, "small.txt");
  await world.settle();
  assert.equal(listOf(world, ref).list.shown?.path, "small.txt");
  assert.equal(world.chat.shared().length, 1, "the refused delete left the file");
  assert.doesNotMatch(world.shown(ref).join("\n"), /refused|could not/i);
});

test("a chat that refuses the diff in the list gets it as a file, and the list shows none", async (t) => {
  const { world, ref, message } = await shownWorld(t);
  world.chat.shownRefused = true;
  await alice(world).picksFile(message, "small.txt");
  await world.settle();
  assert.deepEqual(
    world.chat.shared().map((file) => file.name),
    ["small.txt.diff"],
  );
  assert.equal(listOf(world, ref).list.shown, undefined);
});

test("a refusal takes the diff of another file off the list, and only then redraws it", async (t) => {
  const { world, repo, ref, message } = await shownWorld(t);
  await alice(world).picksFile(message, "small.txt");
  await world.settle();
  assert.equal(listOf(world, ref).list.shown?.path, "small.txt");
  rmSync(join(repo, "big.txt"));
  await alice(world).picksFile(message, "big.txt");
  await world.settle();
  assert.equal(world.shown(ref).at(-1), "`big.txt` no longer differs from HEAD.");
  assert.equal(listOf(world, ref).list.shown, undefined, "no stale diff under the rows");
});

test("a chat with no way to delete a file shares and shows on, and is not asked", async (t) => {
  const { world, ref, message } = await shownWorld(t, { noUnshare: true });
  await alice(world).picksFile(message, "big.txt");
  await world.settle();
  await alice(world).picksFile(message, "small.txt");
  await world.settle();
  assert.equal(listOf(world, ref).list.shown?.path, "small.txt");
  assert.equal(world.chat.shared().length, 1, "the file stays: nothing can delete it");
  assert.doesNotMatch(world.shown(ref).join("\n"), /refused|could not/i);
});

test("a list this process has not seen is redrawn on its first pick, whatever it showed before", async (t) => {
  const first = await shownWorld(t);
  await alice(first.world).picksFile(first.message, "small.txt");
  await first.world.settle();
  assert.equal(listOf(first.world, first.ref).list.shown?.path, "small.txt");

  // A restart: the chat and the folder stay, the flow's memory of the list does not.
  const again = await MessagesWorld.make(t, {
    agent: first.agent,
    diff: true,
    fits: 400,
    restartOf: first.world,
  });
  await alice(again).picksFile(first.message, "big.txt");
  await again.settle();
  assert.equal(listOf(again, first.ref).list.shown, undefined, "the old diff is off the rows");
  assert.deepEqual(
    again.chat.shared().map((file) => file.name),
    ["big.txt.diff"],
  );
});

test("a pick in a view that no longer exists tells so once", async (t) => {
  const { world, agent, repo, ref } = await repositoryWorld(t, true, { fits: 400 });
  agent.next(editing(join(repo, "src.txt"), ["-two", "+TWO"]), say("Done."));
  await world.says("edit", ref.thread);
  await world.settle();
  writeFileSync(join(repo, "src.txt"), "one\nTWO\n");
  await world.says("!diff", ref.thread);
  await world.settle();
  const open = listOf(world, ref);
  const turn = open.list.views[1];
  assert.ok(turn);
  await world.chat.as("alice").picksView(open.message, turn.id);
  await world.settle();
  await alice(world).picksFile(open.message, "src.txt");
  await world.settle();
  assert.equal(listOf(world, ref).list.shown?.path, "src.txt", "the list shows a diff");
  await world.sessions.closeAll();
  await alice(world).picksFile(open.message, "src.txt");
  await world.settle();
  assert.equal(world.shown(ref).filter((line) => line === texts.DIFF_VIEW_GONE).length, 1);
});
