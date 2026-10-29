/**
 * The session's title on its thread's root, over the memory chat: asked of the agent at the end of
 * each turn and handed to the chat when it is new, after the root's own words were kept in the
 * state. And `!status` in a thread, which shows the title and those words.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { forgetGoneThreads } from "../../../src/core/cleanup.ts";
import { logger as flowsLogger } from "../../../src/core/flows/talk.ts";
import { SessionClosed } from "../../../src/core/sessions/errors.ts";
import { logger } from "../../../src/core/sessions/title.ts";
import { hold, type PlainAgent } from "../../support/plain-agent.ts";
import { MessagesWorld, WithSessionTitle } from "./messages-world.ts";

const stored = (world: MessagesWorld, ref: { channel: string; thread: string }) =>
  world.state.thread(ref.channel, ref.thread)?.rootPrompt;

test("a turn that ends with a title hands it to the chat, after keeping the root's words", async (t) => {
  const agent = new WithSessionTitle();
  agent.title = "Fix the footer";
  const world = await MessagesWorld.make(t, { agent, titles: true, rootText: "fix the *footer*" });
  const ref = await world.opened();
  assert.deepEqual(world.titleCalls, [[ref, "Fix the footer"]]);
  assert.deepEqual(world.root.log, ["read", "kept", "edit"], "one read, kept, then replaced");
  assert.equal(stored(world, ref), "fix the *footer*");
});

test("the root's words are kept before the edit, so a refused edit has not lost them", async (t) => {
  t.mock.method(logger, "warning", () => {});
  const agent = new WithSessionTitle();
  agent.title = "Fix the footer";
  const world = await MessagesWorld.make(t, { agent, titles: true, titleFails: true });
  const ref = await world.opened();
  assert.deepEqual(world.titleCalls, []);
  assert.equal(stored(world, ref), "the owner's words");
});

test("a stored prompt is never overwritten, and the root is not read again", async (t) => {
  const agent = new WithSessionTitle();
  agent.title = "Fix the footer";
  const world = await MessagesWorld.make(t, { agent, titles: true, rootText: "first words" });
  const ref = await world.opened();
  agent.title = "Fix the header";
  world.root.text = "something else"; // the owner wrote again, or the root changed
  await world.says("again", ref.thread);
  await world.settle();
  assert.equal(world.root.log.filter((step) => step === "kept").length, 1, "kept once");
  assert.equal(stored(world, ref), "first words");
  assert.deepEqual(world.titleCalls.at(-1), [ref, "Fix the header"]);
});

test("an empty root is kept as the empty text, and a later title is not kept as the prompt", async (t) => {
  const agent = new WithSessionTitle();
  agent.title = "Fix the footer";
  const world = await MessagesWorld.make(t, { agent, titles: true, rootText: "" });
  const ref = await world.opened();
  assert.equal(stored(world, ref), "", "stored, though empty");
  agent.title = "Fix the header";
  world.root.text = "Fix the footer"; // what a read would give now: the title
  await world.says("again", ref.thread);
  await world.settle();
  assert.equal(world.root.log.filter((step) => step === "kept").length, 1, "no second keep");
  assert.equal(stored(world, ref), "");
  assert.deepEqual(world.titleCalls.at(-1), [ref, "Fix the header"]);
});

test("a thread whose prompt is stored is titled with no keep", async (t) => {
  const agent = new WithSessionTitle();
  const world = await MessagesWorld.make(t, { agent, titles: true });
  const ref = await world.opened();
  world.state.setRootPrompt(ref.channel, ref.thread, "kept words");
  agent.title = "Fix the footer";
  await world.says("again", ref.thread);
  await world.settle();
  assert.deepEqual(world.root.log, ["read", "edit"]);
  assert.equal(stored(world, ref), "kept words");
});

test("a root that cannot be read is not replaced, and is tried again at the next turn", async (t) => {
  const lines: string[] = [];
  t.mock.method(logger, "warning", (line: string) => {
    lines.push(line);
  });
  const agent = new WithSessionTitle();
  agent.title = "Fix the footer";
  const world = await MessagesWorld.make(t, { agent, titles: true });
  world.root.readFails = true;
  const ref = await world.opened();
  assert.deepEqual(world.titleCalls, []);
  assert.equal(stored(world, ref), null);
  assert.match(lines.join("\n"), /could not show the session's title of \S+: ratelimited/);
  world.root.readFails = false;
  await world.says("again", ref.thread);
  await world.settle();
  assert.deepEqual(world.titleCalls, [[ref, "Fix the footer"]]);
  assert.equal(stored(world, ref), "the owner's words");
});

test("a turn that ends with no title leaves the root alone", async (t) => {
  const agent = new WithSessionTitle();
  const world = await MessagesWorld.make(t, { agent, titles: true });
  const ref = await world.opened();
  assert.ok(agent.reads > 0, "the agent was asked");
  assert.deepEqual(world.titleCalls, []);
  assert.equal(world.root.reads, 0);
  assert.equal(stored(world, ref), null);
});

test("an unchanged title is not handed to the chat again, a new one is", async (t) => {
  const agent = new WithSessionTitle();
  agent.title = "Fix the footer";
  const world = await MessagesWorld.make(t, { agent, titles: true });
  const ref = await world.opened();
  await world.says("again", ref.thread);
  await world.settle();
  assert.equal(world.titleCalls.length, 1, "the same title is not shown twice");
  agent.title = "Fix the header";
  await world.says("once more", ref.thread);
  await world.settle();
  assert.deepEqual(world.titleCalls.at(-1), [ref, "Fix the header"]);
});

test("a title that comes on a later turn is shown then", async (t) => {
  const agent = new WithSessionTitle();
  const world = await MessagesWorld.make(t, { agent, titles: true });
  const ref = await world.opened();
  assert.deepEqual(world.titleCalls, []);
  agent.title = "Late title";
  await world.says("again", ref.thread);
  await world.settle();
  assert.deepEqual(world.titleCalls, [[ref, "Late title"]]);
});

test("a chat that cannot title a thread, or an agent with no titles, is never asked", async (t) => {
  const agent = new WithSessionTitle();
  agent.title = "Fix the footer";
  const noChat = await MessagesWorld.make(t, { agent });
  const ref = await noChat.opened();
  assert.equal(agent.reads, 0, "the agent is not read when the chat could not show it");
  assert.deepEqual(noChat.titleCalls, []);
  assert.equal(stored(noChat, ref), null);

  const plain = await MessagesWorld.make(t, { titles: true });
  await plain.opened();
  assert.deepEqual(plain.titleCalls, []);
  assert.equal(plain.root.reads, 0);
});

test("a title the chat refuses, or the agent cannot read, is logged by name and the turn goes on", async (t) => {
  const lines: string[] = [];
  t.mock.method(logger, "warning", (line: string) => {
    lines.push(line);
  });
  const agent = new WithSessionTitle();
  agent.title = "Private words";
  const refused = await MessagesWorld.make(t, { agent, titles: true, titleFails: true });
  await refused.opened();
  assert.deepEqual(refused.titleCalls, []);
  assert.match(lines.join("\n"), /could not show the session's title of \S+: ratelimited/);

  agent.fails = true;
  const unread = await MessagesWorld.make(t, { agent, titles: true });
  await unread.opened();
  assert.equal(lines.length, 2);
  // Names only: neither the title nor the error's own words.
  assert.ok(!lines.join("\n").includes("Private words"));
  assert.ok(!lines.join("\n").includes("transcript"));
  assert.ok((await unread.prompts()).length > 0, "the turn ran");
});

test("a refusal that cannot change is not retried at every turn, a transient one is", async (t) => {
  t.mock.method(logger, "warning", () => {});
  const agent = new WithSessionTitle();
  agent.title = "Fix the footer";
  const permanent = await MessagesWorld.make(t, { agent, titles: true, titleFails: "permanent" });
  const ref = await permanent.opened();
  assert.equal(permanent.titleRefusals, 1);
  await permanent.says("again", ref.thread);
  await permanent.settle();
  assert.equal(permanent.titleRefusals, 1, "the same title is not offered again");
  agent.title = "Another title";
  await permanent.says("once more", ref.thread);
  await permanent.settle();
  assert.equal(permanent.titleRefusals, 2, "a new title is tried");

  agent.title = "Fix the footer";
  const transient = await MessagesWorld.make(t, { agent, titles: true, titleFails: true });
  const again = await transient.opened();
  await transient.says("again", again.thread);
  await transient.settle();
  assert.equal(transient.titleRefusals, 2, "a transient refusal is retried at the next turn");
});

// --- !status in a thread

test("!status shows the title and the stored root as written, quoted line by line, last", async (t) => {
  const agent = new WithSessionTitle();
  agent.title = "Fix *the* footer";
  const world = await MessagesWorld.make(t, {
    agent,
    titles: true,
    rootText: "# fix the *footer*\n\n- one",
  });
  const ref = await world.opened();
  await world.says("!status", ref.thread);
  const status = world.shown(ref).at(-1) ?? "";
  assert.match(status, /^Title: Fix \*the\* footer$/m);
  // The chat's own markup, not escaped: its formatting shows.
  assert.ok(status.endsWith("Prompt:\n> # fix the *footer*\n>\n> - one"), status);
  assert.ok(status.indexOf("Title:") < status.indexOf("Mode:"));
  assert.ok(status.indexOf("Mode:") < status.indexOf("Prompt:"), "the quote is last");
});

test("!status leaves out the line it has no value for", async (t) => {
  const agent = new WithSessionTitle();
  // A root with only a file had no words: a title and an empty prompt, which is left out.
  agent.title = "Only a title";
  const world = await MessagesWorld.make(t, { agent, titles: true, rootText: "" });
  const ref = await world.opened();
  await world.says("!status", ref.thread);
  const status = world.shown(ref).at(-1) ?? "";
  assert.ok(status.includes("Title: Only a title") && !status.includes("Prompt:"), status);

  // No title yet: nothing was replaced, so there is no prompt either.
  const untitled = await MessagesWorld.make(t, { agent: new WithSessionTitle(), titles: true });
  const open = await untitled.opened();
  await untitled.says("!status", open.thread);
  const answer = untitled.shown(open).at(-1) ?? "";
  assert.ok(!answer.includes("Title:") && !answer.includes("Prompt:"), answer);

  // A stored prompt shows even when the title cannot be read now.
  t.mock.method(logger, "warning", () => {});
  const failing = new WithSessionTitle();
  const broken = await MessagesWorld.make(t, { agent: failing, titles: true });
  const thread = await broken.opened();
  broken.state.setRootPrompt(thread.channel, thread.thread, "kept words");
  failing.fails = true;
  await broken.says("!status", thread.thread);
  const last = broken.shown(thread).at(-1) ?? "";
  assert.ok(!last.includes("Title:") && last.endsWith("Prompt:\n> kept words"), last);
});

test("!status of an agent with no titles shows no title line", async (t) => {
  const plain = await MessagesWorld.make(t);
  const ref = await plain.opened();
  await plain.says("!status", ref.thread);
  const status = plain.shown(ref).at(-1) ?? "";
  assert.ok(
    status.includes("Directory:") && !status.includes("Title:") && !status.includes("Prompt:"),
  );
});

test("a stored prompt of one very long line is wrapped, every piece quoted whole", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new WithSessionTitle() });
  const ref = await world.opened();
  const long = `${"word ".repeat(6000)}end`;
  world.state.setRootPrompt(ref.channel, ref.thread, long);
  await world.says("!status", ref.thread);
  const status = world.shown(ref).at(-1) ?? "";
  const quote = status.slice(status.indexOf("Prompt:\n") + "Prompt:\n".length).split("\n");
  assert.ok(quote.length >= 30, `${quote.length} pieces`);
  assert.ok(quote.every((line) => line.startsWith("> ") && line.length <= 1002));
  assert.equal(quote.map((line) => line.slice(2)).join(" "), long);
});

test("!status of a session closed while its title is read is not given", async (t) => {
  const agent = new WithSessionTitle();
  const world = await MessagesWorld.make(t, { agent });
  const ref = await world.opened();
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session !== null);
  let release = () => {};
  agent.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reads = agent.reads;
  const asked = session.status().then(
    () => null,
    (error: unknown) => error,
  );
  while (agent.reads === reads) await world.settle(1);
  const closing = session.close();
  release();
  await closing;
  assert.ok((await asked) instanceof SessionClosed);
});

// --- the first message deleted by hand

test("rootGone forgets the thread and what is kept of it, and frees the hold", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new WithSessionTitle() });
  const ref = await world.opened();
  world.state.setRootPrompt(ref.channel, ref.thread, "kept words");
  await world.inbound.rootGone(ref);
  assert.equal(world.state.thread(ref.channel, ref.thread), null);
  assert.equal(world.sessions.held(ref.channel, ref.thread), false);
  // The daemon's own words are the chat's: nothing of them is deleted.
  assert.ok(world.shown(ref).length > 0);
  // The provider calls only for a thread the core keeps; a call for another one is harmless.
  await world.inbound.rootGone(ref);
  await world.inbound.rootGone({ channel: ref.channel, thread: "thread-gone" });
});

test("a first message deleted during a turn is left to the cleanup, and the turn end edits and stores nothing", async (t) => {
  t.mock.method(logger, "warning", () => {});
  const agent = new WithSessionTitle();
  const world = await MessagesWorld.make(t, { agent, titles: true });
  const ref = await world.opened();
  agent.title = "Fix the footer"; // the title that would be shown at this turn's end
  (world.agent as PlainAgent).next(hold());
  await world.says("a long job", ref.thread);
  await world.settle();
  world.root.gone = true; // the chat now returns the root as a tombstone
  await world.inbound.rootGone(ref);
  assert.notEqual(world.state.thread(ref.channel, ref.thread), null, "not forgotten live");
  assert.equal(world.sessions.held(ref.channel, ref.thread), false, "no hold left behind");
  world.agentSession().release();
  await world.settle();
  assert.deepEqual(world.titleCalls, [], "no edit of a root that is gone");
  assert.equal(world.state.thread(ref.channel, ref.thread)?.rootPrompt, null, "nothing stored");
  // The next cleanup pass finds the root gone and forgets the thread.
  world.chat.removeThread(ref);
  const forgotten = await forgetGoneThreads(
    (thread) => world.provider.threadState(thread),
    world.state,
    [ref.channel],
    () => [],
    "memory",
  );
  assert.deepEqual(forgotten, [ref]);
  assert.equal(world.state.thread(ref.channel, ref.thread), null);
});

test("a failing close frees the hold rootGone took", async (t) => {
  const lines: string[] = [];
  t.mock.method(flowsLogger, "warning", (line: string) => {
    lines.push(line);
  });
  const world = await MessagesWorld.make(t, { agent: new WithSessionTitle() });
  const ref = await world.opened();
  const session = world.sessions.get(ref.channel, ref.thread);
  assert.ok(session !== null);
  // `release` holds the thread first, then closes the idle session: a close that throws.
  const failing = t.mock.method(session, "close", async () => {
    throw new Error("the close failed");
  });
  await world.inbound.rootGone(ref);
  assert.equal(world.sessions.held(ref.channel, ref.thread), false);
  assert.notEqual(world.state.thread(ref.channel, ref.thread), null);
  assert.ok(lines.some((line) => line.includes("could not forget")));
  failing.mock.restore(); // the world closes its sessions when the test ends
});

test("a thread held by a delete under way is left to that delete, hold included", async (t) => {
  const lines: string[] = [];
  t.mock.method(flowsLogger, "info", (line: string) => {
    lines.push(line);
  });
  const world = await MessagesWorld.make(t, { agent: new WithSessionTitle() });
  const ref = await world.opened();
  assert.equal(await world.sessions.release(ref.channel, ref.thread), true); // the delete's hold
  await world.inbound.rootGone(ref); // its own deletion coming back as an event
  assert.equal(world.sessions.held(ref.channel, ref.thread), true, "the hold is the delete's");
  assert.notEqual(world.state.thread(ref.channel, ref.thread), null, "the delete removes it");
  assert.deepEqual(
    lines.filter((line) => /deleted|forgot/.test(line)),
    [],
    "not said to be a deletion by hand",
  );
  world.sessions.free(ref.channel, ref.thread);
});

test("after a stop a deletion is not said to wait for a turn", async (t) => {
  const lines: string[] = [];
  t.mock.method(flowsLogger, "info", (line: string) => {
    lines.push(line);
  });
  const world = await MessagesWorld.make(t, { agent: new WithSessionTitle() });
  const ref = await world.opened();
  world.stopping.abort();
  await world.sessions.closeAll();
  await world.inbound.rootGone(ref);
  assert.ok(!lines.some((line) => line.includes("while it works")), lines.join("\n"));
  assert.notEqual(
    world.state.thread(ref.channel, ref.thread),
    null,
    "the cleanup's, at next start",
  );
});

test("!status draws the stored words with the chat's control characters escaped and their marks live", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new WithSessionTitle() });
  const ref = await world.opened();
  world.state.setRootPrompt(
    ref.channel,
    ref.thread,
    "<b>bold</b> and <i>x</i>\nVec<String> & a>b with *bold* and `code`",
  );
  await world.says("!status", ref.thread);
  const status = world.shown(ref).at(-1) ?? "";
  assert.ok(
    status.endsWith(
      "Prompt:\n> &lt;b&gt;bold&lt;/b&gt; and &lt;i&gt;x&lt;/i&gt;\n" +
        "> Vec&lt;String&gt; &amp; a&gt;b with *bold* and `code`",
    ),
    status,
  );
  assert.ok(!status.includes("<b>"), "no control character is left raw");
});

test("a concurrent delete's hold survives a rootGone that took none", async (t) => {
  const world = await MessagesWorld.make(t, { agent: new WithSessionTitle() });
  const ref = await world.opened();
  assert.equal(world.sessions.hold(ref.channel, ref.thread), true); // the delete's hold
  // The check before it saw nothing held (the race): the hold it asks for is refused.
  t.mock.method(world.sessions, "held", () => false);
  await world.inbound.rootGone(ref);
  t.mock.restoreAll();
  assert.equal(world.sessions.held(ref.channel, ref.thread), true, "the delete's hold stays");
  assert.notEqual(world.state.thread(ref.channel, ref.thread), null);
  world.sessions.free(ref.channel, ref.thread);
});

test("a title written after the turn's end reaches the root at the next !status", async (t) => {
  const agent = new WithSessionTitle();
  const world = await MessagesWorld.make(t, { agent, titles: true });
  const ref = await world.opened();
  assert.deepEqual(world.titleCalls, []);
  // The agent writes its title a moment after the turn ended: no turn reads it again.
  agent.title = "Late title";
  await world.says("!status", ref.thread);
  await world.settle();
  assert.deepEqual(world.titleCalls, [[ref, "Late title"]]);
});

test("!status shows a title on one line, as the root does", async (t) => {
  const agent = new WithSessionTitle();
  agent.title = "Fix the\nfooter";
  const world = await MessagesWorld.make(t, { agent, titles: true });
  const ref = await world.opened();
  await world.says("!status", ref.thread);
  const status = world.shown(ref).at(-1) ?? "";
  assert.match(status, /^Title: Fix the footer$/m);
});
