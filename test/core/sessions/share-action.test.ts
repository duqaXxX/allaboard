/**
 * What a session's model may ask the daemon to do (`DaemonActions`): share a file of the session's
 * folder into its thread, through the plain agent and the memory chat.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChatError } from "../../../src/chat/seam.ts";
import { sizeText } from "../../../src/core/guide.ts";
import * as texts from "../../../src/core/texts.ts";
import { fill } from "../../../src/core/texts.ts";
import { PlainAgent, share } from "../../support/plain-agent.ts";
import { MessagesWorld } from "../flows/messages-world.ts";

const LIMIT = 100;

/** A world whose chat shares files up to `LIMIT` bytes, and whose agent offers the actions. */
async function sharing(t: Parameters<typeof MessagesWorld.make>[0]) {
  const agent = new PlainAgent({ daemonActions: true });
  const world = await MessagesWorld.make(t, { agent, diff: true, fileLimit: LIMIT });
  const ref = await world.opened();
  return { world, agent, ref };
}

/** The action the core passed the agent for the thread's session. */
function actionsOf(agent: PlainAgent) {
  const actions = agent.startedWith.at(-1);
  assert.ok(actions?.share, "the session was given a share action");
  return actions.share.bind(actions);
}

test("a file of the folder is shared into the thread under its name and its path", async (t) => {
  const { world, agent } = await sharing(t);
  mkdirSync(join(world.folder, "docs"));
  writeFileSync(join(world.folder, "docs", "notes.md"), "# notes\n");
  const line = await actionsOf(agent)("./docs/notes.md", new AbortController().signal);
  assert.equal(line, fill(texts.SHARE_DONE, { path: "docs/notes.md" }));
  const [file] = world.chat.shared();
  assert.equal(file?.name, "notes.md");
  assert.equal(file?.title, "docs/notes.md");
  assert.equal(file?.content, "# notes\n");
});

test("a share step of the agent's script reaches the action and keeps its line", async (t) => {
  const { world, agent, ref } = await sharing(t);
  writeFileSync(join(world.folder, "a.txt"), "a");
  agent.next(share("a.txt"));
  await world.says("show it", ref.thread);
  await world.settle();
  assert.deepEqual(agent.sessions[0]?.shared, [fill(texts.SHARE_DONE, { path: "a.txt" })]);
  assert.equal(world.chat.shared().length, 1);
});

for (const [name, path] of [
  ["a path outside the folder", "../outside.txt"],
  ["an absolute path", "/etc/hosts"],
  ["a missing file", "missing.txt"],
  ["a directory", "."],
] as const) {
  test(`${name} is refused with the line for the model and shares nothing`, async (t) => {
    const { world, agent } = await sharing(t);
    const line = await actionsOf(agent)(path, new AbortController().signal);
    assert.equal(line, fill(texts.SHARE_NOT_A_FILE, { path }));
    assert.deepEqual(world.chat.shared(), []);
  });
}

test("a link out of the folder is refused", async (t) => {
  const { world, agent } = await sharing(t);
  symlinkSync("/etc/hosts", join(world.folder, "link.txt"));
  const line = await actionsOf(agent)("link.txt", new AbortController().signal);
  assert.equal(line, fill(texts.SHARE_NOT_A_FILE, { path: "link.txt" }));
  assert.deepEqual(world.chat.shared(), []);
});

test("a file over the chat's limit is refused, one of exactly the limit is shared", async (t) => {
  const { world, agent } = await sharing(t);
  writeFileSync(join(world.folder, "big.txt"), "x".repeat(LIMIT + 1));
  writeFileSync(join(world.folder, "fits.txt"), "x".repeat(LIMIT));
  const action = actionsOf(agent);
  const { signal } = new AbortController();
  assert.equal(
    await action("big.txt", signal),
    fill(texts.SHARE_TOO_LARGE, { path: "big.txt", size: sizeText(LIMIT) }),
  );
  assert.equal(await action("fits.txt", signal), fill(texts.SHARE_DONE, { path: "fits.txt" }));
  assert.deepEqual(
    world.chat.shared().map((file) => file.name),
    ["fits.txt"],
  );
});

test("an empty file is refused", async (t) => {
  const { world, agent } = await sharing(t);
  writeFileSync(join(world.folder, "empty.txt"), "");
  const line = await actionsOf(agent)("empty.txt", new AbortController().signal);
  assert.equal(line, fill(texts.SHARE_EMPTY, { path: "empty.txt" }));
  assert.deepEqual(world.chat.shared(), []);
});

test("a signal already aborted shares nothing", async (t) => {
  const { world, agent } = await sharing(t);
  writeFileSync(join(world.folder, "a.txt"), "a");
  const line = await actionsOf(agent)("a.txt", AbortSignal.abort());
  assert.equal(line, fill(texts.SHARE_STOPPED, { path: "a.txt" }));
  assert.deepEqual(world.chat.shared(), []);
});

test("a signal aborted while the file is read shares nothing", async (t) => {
  const { world, agent } = await sharing(t);
  writeFileSync(join(world.folder, "a.txt"), "a");
  const stop = new AbortController();
  const pending = actionsOf(agent)("a.txt", stop.signal);
  stop.abort();
  assert.equal(await pending, fill(texts.SHARE_STOPPED, { path: "a.txt" }));
  assert.deepEqual(world.chat.shared(), []);
});

test("a chat that refuses the file gives the model its code, never the content", async (t) => {
  const { world, agent } = await sharing(t);
  writeFileSync(join(world.folder, "a.txt"), "secret words");
  const room = world.chat;
  const original = room.addShared.bind(room);
  room.addShared = () => {
    throw new ChatError("file_rejected");
  };
  const line = await actionsOf(agent)("a.txt", new AbortController().signal);
  room.addShared = original;
  assert.equal(line, fill(texts.SHARE_REFUSED, { path: "a.txt", error: "file_rejected" }));
  assert.ok(!line.includes("secret words"));
});

test("a chat that cannot upload gives the agent no actions", async (t) => {
  const agent = new PlainAgent({ daemonActions: true });
  const world = await MessagesWorld.make(t, { agent });
  await world.opened();
  assert.equal(agent.startedWith.length, 1);
  assert.equal(agent.startedWith[0], undefined);
});

test("an agent without the capability is given no actions, whatever the chat", async (t) => {
  const agent = new PlainAgent();
  const world = await MessagesWorld.make(t, { agent, diff: true });
  await world.opened();
  assert.equal(agent.startedWith[0], undefined);
});

test("a relative path is read from the working folder, an absolute one as it is", async (t) => {
  const { world, agent, ref } = await sharing(t);
  const sub = join(world.folder, "tree");
  mkdirSync(sub);
  writeFileSync(join(sub, "inner.txt"), "inner");
  writeFileSync(join(world.folder, "root.txt"), "root");
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session);
  session.workingDirectory = sub;
  const action = actionsOf(agent);
  const { signal } = new AbortController();
  assert.equal(
    await action("inner.txt", signal),
    fill(texts.SHARE_DONE, { path: "tree/inner.txt" }),
  );
  // A relative path no longer finds what only the bound folder holds.
  assert.equal(
    await action("root.txt", signal),
    fill(texts.SHARE_NOT_A_FILE, { path: "root.txt" }),
  );
  assert.equal(
    await action(join(world.folder, "root.txt"), signal),
    fill(texts.SHARE_DONE, { path: "root.txt" }),
  );
  assert.deepEqual(
    world.chat.shared().map((file) => [file.name, file.title]),
    [
      ["inner.txt", "tree/inner.txt"],
      ["root.txt", "root.txt"],
    ],
  );
});

test("an absolute path is titled from the folder, never as an absolute path", async (t) => {
  const { world, agent } = await sharing(t);
  writeFileSync(join(world.folder, "abs.txt"), "x");
  await actionsOf(agent)(join(world.folder, "abs.txt"), new AbortController().signal);
  assert.equal(world.chat.shared()[0]?.title, "abs.txt");
});

test("a working folder outside the bound folder shares nothing", async (t) => {
  const { world, agent, ref } = await sharing(t);
  const outside = mkdtempSync(join(tmpdir(), "allaboard-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "o.txt"), "o");
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session);
  session.workingDirectory = outside;
  const action = actionsOf(agent);
  const { signal } = new AbortController();
  assert.equal(await action("o.txt", signal), fill(texts.SHARE_NOT_A_FILE, { path: "o.txt" }));
  assert.equal(
    await action(join(outside, "o.txt"), signal),
    fill(texts.SHARE_NOT_A_FILE, { path: join(outside, "o.txt") }),
  );
  assert.deepEqual(world.chat.shared(), []);
});

test("a thread chat with no share gives the agent no actions", async (t) => {
  const agent = new PlainAgent({ daemonActions: true });
  const world = await MessagesWorld.make(t, { agent, diff: true, noShare: true });
  await world.opened();
  assert.equal(agent.startedWith[0], undefined);
});
