/**
 * `!bind` as a flow of the core, over the memory chat: a typed path, the list of folders and a
 * pick from it. What the owner reads is the texts of the core with the memory chat's names.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SessionClosed } from "../../../src/core/sessions/errors.ts";
import * as texts from "../../../src/core/texts.ts";
import { shellQuote } from "../../../src/text.ts";
import { OWNER } from "../../support/memory-chat.ts";
import { ListsWorld } from "./lists-world.ts";
import { WithFolderTrust } from "./messages-world.ts";

const { fill } = texts;

test("a path inside the root binds the channel and says so", async (t) => {
  const world = await ListsWorld.build(t);
  await world.flows.bind.to(world.channel, world.app);
  assert.equal(world.state.channel(world.channel)?.directory, world.app);
  assert.deepEqual(world.said(), [fill(texts.BIND_OK, { directory: world.app })]);
});

test("a bind names the repositories below the folder that still need the agent's trust", async (t) => {
  // with each, the shell line that opens the agent there to trust it.
  const agent = new WithFolderTrust();
  const world = await ListsWorld.build(t, agent);
  for (const name of ["lib", "tools", "my repo"])
    mkdirSync(join(world.app, name, ".git"), { recursive: true });
  agent.trusted.add(join(world.app, "tools"));
  await world.flows.bind.to(world.channel, world.app);
  assert.deepEqual(world.said(), [
    [
      fill(texts.BIND_OK, { directory: world.app }),
      texts.named(texts.UNTRUSTED_REPOSITORIES, world.names),
      `\`cd ${shellQuote(join(world.app, "lib"))} && plain\``,
      `\`cd ${shellQuote(join(world.app, "my repo"))} && plain\``,
    ].join("\n"),
  ]);
});

test("a bind where every repository below is trusted says the bind alone", async (t) => {
  const agent = new WithFolderTrust();
  const world = await ListsWorld.build(t, agent);
  mkdirSync(join(world.app, "lib", ".git"), { recursive: true });
  agent.trusted.add(join(world.app, "lib"));
  await world.flows.bind.to(world.channel, world.app);
  assert.deepEqual(world.said(), [fill(texts.BIND_OK, { directory: world.app })]);
});

test("a typed path binds a folder deeper than the list shows", async (t) => {
  // the list stops two levels below the root; a path typed by hand does not.
  const world = await ListsWorld.build(t);
  const deep = join(world.root, "app", "packages", "web", "src");
  mkdirSync(deep, { recursive: true });
  await world.flows.bind.to(world.channel, "app/packages/web/src");
  assert.equal(world.state.channel(world.channel)?.directory, deep);
  assert.ok(world.said()[0]?.startsWith(`Bound this channel to \`${deep}\``));
});

test("a path is read under the root when it is relative", async (t) => {
  const world = await ListsWorld.build(t);
  await world.flows.bind.to(world.channel, "docs");
  assert.equal(world.state.channel(world.channel)?.directory, world.docs);
});

test("a path outside the root binds nothing and says where the root is", async (t) => {
  const world = await ListsWorld.build(t);
  await world.flows.bind.to(world.channel, "/");
  await world.flows.bind.to(world.channel, "../..");
  assert.equal(world.state.channel(world.channel), null);
  assert.deepEqual(world.said(), [
    fill(texts.BIND_OUTSIDE, { path: "/", root: world.root }),
    fill(texts.BIND_OUTSIDE, { path: "../..", root: world.root }),
  ]);
});

test("a path that names no folder binds nothing and says why", async (t) => {
  // a folder that does not exist and a file each get their own reason.
  const world = await ListsWorld.build(t);
  writeFileSync(join(world.root, "notes.txt"), "x");
  await world.flows.bind.to(world.channel, "missing");
  await world.flows.bind.to(world.channel, "notes.txt");
  assert.equal(world.state.channel(world.channel), null);
  assert.deepEqual(world.said(), [
    fill(texts.BIND_MISSING, { path: "missing", root: world.root }),
    fill(texts.BIND_FILE, { path: "notes.txt" }),
  ]);
});

test("a typed bind to the folder already bound says it bound it again", async (t) => {
  const world = await ListsWorld.build(t);
  await world.bound(world.app);
  await world.flows.bind.to(world.channel, world.app);
  assert.deepEqual(world.said(), [fill(texts.BIND_OK, { directory: world.app })]);
});

test("a typed bind while a session works changes nothing and says why", async (t) => {
  const world = await ListsWorld.build(t);
  await world.bound(world.app);
  await world.work(await world.word("start"));
  await world.flows.bind.to(world.channel, world.docs);
  assert.equal(world.state.channel(world.channel)?.directory, world.app);
  assert.deepEqual(
    world.said().filter((line) => line === texts.BIND_BUSY),
    [texts.BIND_BUSY],
  );
});

test("a bind names the folders the channel's old threads keep working in", async (t) => {
  const world = await ListsWorld.build(t);
  await world.bound(world.app);
  const thread = await world.word("start");
  world.sessions.open(thread.channel, thread.thread);
  await world.flows.bind.to(world.channel, world.docs);
  assert.deepEqual(world.said().slice(-1), [
    fill(texts.BIND_OK_ELSEWHERE, { directory: world.docs, old: `\`${world.app}\`` }),
  ]);
});

test("the list holds the folders a session can start in and the channel's own", async (t) => {
  const world = await ListsWorld.build(t);
  await world.flows.bind.list(world.channel);
  await world.bound(world.docs);
  await world.flows.bind.list(world.channel);
  const [first, second] = world.chat.lists();
  const folders = await world.sessions.foldersIn(world.root);
  // The plain agent keeps no record of trust: the title names no trust.
  const title = `Folders under \`${world.root}\`:`;
  assert.deepEqual(first?.list, { type: "folders", root: world.root, folders, bound: null });
  assert.deepEqual(second?.list, { type: "folders", root: world.root, folders, bound: world.docs });
  assert.deepEqual([first?.title, second?.title], [title, title]);
  assert.ok(folders.includes(world.app) && folders.includes(world.docs));
});

test("a pick binds the channel, says so and takes the list away", async (t) => {
  const world = await ListsWorld.build(t);
  await world.flows.bind.list(world.channel);
  const [list] = world.chat.lists();
  assert.equal(await world.chat.as(OWNER).picks(list?.message ?? "", world.app), true);
  assert.equal(world.state.channel(world.channel)?.directory, world.app);
  assert.deepEqual(world.picked, [
    { type: "folder", channel: world.channel, path: world.app, list: list?.message },
  ]);
  assert.deepEqual(world.chat.lists(), []);
  assert.deepEqual(world.said(), [fill(texts.BIND_OK, { directory: world.app })]);
});

test("a pick of the folder already bound says so and leaves the list", async (t) => {
  const world = await ListsWorld.build(t);
  await world.bound(world.app);
  await world.flows.bind.list(world.channel);
  const [list] = world.chat.lists();
  await world.chat.as(OWNER).picks(list?.message ?? "", world.app);
  assert.equal(world.chat.lists().length, 1);
  assert.deepEqual(world.said().slice(-1), [fill(texts.BIND_ALREADY, { directory: world.app })]);
});

test("a pick while a session works changes nothing and leaves the list", async (t) => {
  const world = await ListsWorld.build(t);
  await world.bound(world.app);
  await world.flows.bind.list(world.channel);
  await world.work(await world.word("start"));
  const [list] = world.chat.lists();
  await world.chat.as(OWNER).picks(list?.message ?? "", world.docs);
  assert.equal(world.state.channel(world.channel)?.directory, world.app);
  assert.equal(world.chat.lists().length, 1);
  assert.deepEqual(world.said().slice(-1), [texts.BIND_BUSY]);
});

test("a pick from an old list binds where it says, and the one bound meanwhile is already", async (t) => {
  const world = await ListsWorld.build(t);
  await world.flows.bind.list(world.channel);
  const [list] = world.chat.lists();
  await world.flows.bind.to(world.channel, world.docs); // after the list was posted
  await world.chat.as(OWNER).picks(list?.message ?? "", world.docs);
  assert.deepEqual(world.said().slice(-1), [fill(texts.BIND_ALREADY, { directory: world.docs })]);
  await world.chat.as(OWNER).picks(list?.message ?? "", world.app);
  assert.equal(world.state.channel(world.channel)?.directory, world.app);
  assert.deepEqual(world.chat.lists(), []);
});

test("a pick is not trusted: a folder outside the root binds nothing", async (t) => {
  const world = await ListsWorld.build(t);
  await world.flows.bind.list(world.channel);
  const [list] = world.chat.lists();
  const paths = ["../..", "/", join(world.root, "..")];
  for (const path of paths) {
    await world.flows.picks.picked({
      type: "folder",
      channel: world.channel,
      path,
      list: list?.message ?? "",
    });
  }
  assert.equal(world.state.channel(world.channel), null);
  assert.equal(world.chat.lists().length, 1);
  assert.deepEqual(
    world.said().slice(1), // after the list's own line
    paths.map((path) => fill(texts.BIND_OUTSIDE, { path, root: world.root })),
  );
});

test("a pick that fails is told in the channel, with the list left", async (t) => {
  const world = await ListsWorld.build(t);
  await world.flows.bind.list(world.channel);
  const [list] = world.chat.lists();
  await world.sessions.closeAll(); // the daemon is stopping: a bind is refused
  await world.chat.as(OWNER).picks(list?.message ?? "", world.app);
  assert.deepEqual(world.said().slice(-1), [new SessionClosed().message]);
  assert.equal(world.state.channel(world.channel), null);
  assert.equal(world.chat.lists().length, 1);
});
