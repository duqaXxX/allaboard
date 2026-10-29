/**
 * `!allaboard` and the update from the chat as a flow of the core: the word and its
 * answers, the offer and the click that installs, the line told once per version, and the block on
 * new agent processes while an install runs. The core runs over the memory chat, the plain agent
 * and a host whose answers a test sets (`FakeUpdatesHost`): no npm and no service is touched.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ListPick } from "../../../src/chat/seam.ts";
import { StateStore } from "../../../src/core/state.ts";
import * as texts from "../../../src/core/texts.ts";
import { OWNER, SOMEONE } from "../../support/memory-chat.ts";
import type { PlainAgent } from "../../support/plain-agent.ts";
import { COPY, FakeUpdatesHost } from "../../support/updates.ts";
import { MessagesWorld, PLAIN_NAMES } from "./messages-world.ts";

const { fill, named } = texts;

const VERSION = "0.3.1";

/** `HH:MM` of `seconds` on this machine's clock, derived here and not by the code under test. */
function clock(seconds: number): string {
  return new Date(seconds * 1000).toTimeString().slice(0, 5);
}

/** A world whose daemon can update itself through a host that finds `VERSION` newer. */
async function updating(t: Parameters<typeof MessagesWorld.make>[0], host = new FakeUpdatesHost()) {
  const world = await MessagesWorld.make(t, { host });
  return { world, host, updates: world.updates as NonNullable<typeof world.updates> };
}

/** The agent processes started so far. */
function started(world: MessagesWorld): number {
  return (world.agent as PlainAgent).starts.length;
}

/** The one list the channel holds, and the owner's word that came before it. */
function theOffer(world: MessagesWorld) {
  const [list] = world.chat.lists();
  assert.ok(list !== undefined, "an offer was posted");
  return list;
}

/** The owner types `!allaboard update` and presses the offer's control. */
async function offered(world: MessagesWorld) {
  await world.says("!allaboard update");
  const list = theOffer(world);
  return list;
}

function pickOf(
  world: MessagesWorld,
  list = theOffer(world),
): Extract<ListPick, { type: "update" }> {
  return { type: "update", channel: world.channel, version: VERSION, list: list.message };
}

// ---- the word

test("without a way to update, `!allaboard` is a mistyped word", async (t) => {
  const world = await MessagesWorld.make(t);
  await world.says("!allaboard");
  const answer = world.inChannel().at(-1) ?? "";
  assert.ok(answer.includes("`!guide`"), "the full list of the words");
  assert.ok(!answer.includes("!allaboard"), "which does not offer it");
});

test("`!allaboard` says the version that runs, the latest and when it was checked", async (t) => {
  const { world } = await updating(t);
  await world.says("!allaboard");
  assert.equal(
    world.inChannel().at(-1),
    `allaboard 0.3.0 · latest 0.3.1, checked ${clock(world.now)} · \`!allaboard update\` installs it`,
  );
});

test("`!allaboard` on the latest version says so", async (t) => {
  const host = new FakeUpdatesHost();
  host.newest = { version: "0.3.0" };
  const { world } = await updating(t, host);
  await world.says("!allaboard");
  assert.equal(
    world.inChannel().at(-1),
    `allaboard 0.3.0 · the latest version, checked ${clock(world.now)}`,
  );
});

test("`!allaboard` says when npm could not be asked", async (t) => {
  const host = new FakeUpdatesHost();
  host.newest = { failure: { kind: "network" } };
  const { world } = await updating(t, host);
  await world.says("!allaboard");
  assert.equal(
    world.inChannel().at(-1),
    `allaboard 0.3.0 · latest version unknown: npm could not reach the registry at ${clock(world.now)}`,
  );
});

test("`!allaboard` words another failure of npm as the terminal does", async (t) => {
  const host = new FakeUpdatesHost();
  host.newest = { failure: { kind: "other", status: 3 } };
  const { world } = await updating(t, host);
  await world.says("!allaboard");
  assert.match(
    world.inChannel().at(-1) ?? "",
    /latest version unknown: npm ended with status 3 at /,
  );
  host.newest = { failure: { kind: "permission", path: null } };
  await world.updates?.check();
  await world.says("!allaboard");
  assert.match(world.inChannel().at(-1) ?? "", /unknown: npm may not read what it needs at /);
});

test("`!allaboard` checks once if no check ran, and not again", async (t) => {
  const { world, host } = await updating(t);
  await world.says("!allaboard");
  await world.says("!allaboard");
  assert.equal(host.calls.filter((call) => call === "latest").length, 1);
});

for (const [name, refusal, reason] of [
  [
    "not the global copy",
    { kind: "not-global", folder: "/work/checkout" },
    "it is not the copy `npm install -g` replaces (/work/checkout)",
  ],
  ["a link", { kind: "link" }, "it is a link, not an install"],
  [
    "an unpublished version",
    { kind: "unpublished", version: "0.3.0" },
    "its version 0.3.0 is not published on npm",
  ],
] as const) {
  test(`${name}: \`!allaboard\` says the copy updates outside the chat`, async (t) => {
    const host = new FakeUpdatesHost();
    host.copy = { refusal };
    const { world } = await updating(t, host);
    await world.says("!allaboard");
    const answer = world.inChannel().at(-1) ?? "";
    assert.ok(answer.includes(`This copy updates outside Memory chat: ${reason}.`), answer);
    // and the offer is not made, nor the click taken
    await world.says("!allaboard update");
    assert.equal(world.chat.lists().length, 0);
    assert.equal(world.inChannel().at(-1), `This copy updates outside Memory chat: ${reason}.`);
  });
}

test("a daemon that no service runs says so beside the versions", async (t) => {
  const host = new FakeUpdatesHost();
  host.service = false;
  const { world } = await updating(t, host);
  await world.says("!allaboard");
  assert.ok(
    (world.inChannel().at(-1) ?? "").endsWith(
      "\nallaboard is not running as a service. `allaboard service install` in a terminal makes it " +
        "one; then it can update and restart from Memory chat.",
    ),
  );
  await world.says("!allaboard update");
  assert.equal(world.chat.lists().length, 0, "no offer a click could not honour");
  assert.equal(world.inChannel().at(-1), named(texts.UPDATE_NOT_A_SERVICE, PLAIN_NAMES));
});

test("`!allaboard` inside a session's thread answers there, for the owner alone", async (t) => {
  const { world } = await updating(t);
  const ref = await world.opened();
  const before = world.inChannel().length;
  await world.says("!allaboard", ref.thread);
  assert.ok((world.shown(ref).at(-1) ?? "").startsWith("allaboard 0.3.0 · latest 0.3.1"));
  assert.equal(world.inChannel().length, before, "nothing in the channel");
});

for (const action of ["update", "restart"] as const) {
  test(`\`!allaboard ${action}\` inside a thread is refused: the offer lives in the channel`, async (t) => {
    const { world, host } = await updating(t);
    const ref = await world.opened();
    await world.says(`!allaboard ${action}`, ref.thread);
    assert.equal(
      world.shown(ref).at(-1),
      fill(texts.WORD_IN_THREAD, { word: `allaboard ${action}` }),
    );
    assert.equal(world.chat.lists().length, 0);
    assert.ok(!host.calls.includes("restart"));
  });

  test(`\`!allaboard ${action}\` inside a thread that holds no session is refused too`, async (t) => {
    const { world } = await updating(t);
    const ref = world.chat.openThread(world.channel);
    await world.says(`!allaboard ${action}`, ref.thread);
    assert.equal(
      world.shown(ref).at(-1),
      fill(texts.WORD_IN_THREAD, { word: `allaboard ${action}` }),
    );
  });
}

test("anything else after the word gets the list of words", async (t) => {
  const { world } = await updating(t);
  await world.says("!allaboard upgrade");
  const answer = world.inChannel().at(-1) ?? "";
  assert.ok(answer.includes("`!allaboard [update|restart]`"));
});

test("`!help` lists the word, and the guide describes it", async (t) => {
  const { world } = await updating(t);
  await world.says("!help");
  assert.ok((world.inChannel().at(-1) ?? "").includes("`!allaboard [update|restart]`"));
  await world.says("!guide");
  assert.ok((world.inChannel().at(-1) ?? "").includes("**Updates**"));
});

// ---- `update`: the offer

test("`!allaboard update` offers the latest version with the changelog and the sharing instances", async (t) => {
  const host = new FakeUpdatesHost();
  host.others = [null, "work2"];
  const { world } = await updating(t, host);
  const list = await offered(world);
  assert.equal(list.title, "Update allaboard 0.3.0 → 0.3.1");
  assert.deepEqual(list.list, {
    type: "update",
    from: "0.3.0",
    to: "0.3.1",
    changelog: host.changelog("0.3.1"),
    sharing: [null, "work2"],
  });
  assert.equal(list.channel, world.channel);
});

test("`!allaboard update` asks the registry again", async (t) => {
  const { world, host } = await updating(t);
  await world.says("!allaboard");
  await world.says("!allaboard update");
  assert.equal(host.calls.filter((call) => call === "latest").length, 2);
});

test("`!allaboard update` on the latest version offers nothing", async (t) => {
  const host = new FakeUpdatesHost();
  host.newest = { version: "0.3.0" };
  const { world } = await updating(t, host);
  await world.says("!allaboard update");
  assert.equal(world.chat.lists().length, 0);
  assert.equal(world.inChannel().at(-1), "allaboard 0.3.0 is already the latest version.");
});

test("`!allaboard update` says when the registry could not be reached, and tries again next time", async (t) => {
  const host = new FakeUpdatesHost();
  host.newest = { failure: { kind: "network" } };
  const { world } = await updating(t, host);
  await world.says("!allaboard update");
  assert.equal(
    world.inChannel().at(-1),
    "The latest version is unknown: npm could not reach the registry. `!allaboard update` tries again.",
  );
  host.newest = { version: VERSION };
  await world.says("!allaboard update");
  assert.equal(world.chat.lists().length, 1);
});

// ---- the click

test("the click installs, restarts the others, then asks this daemon to stop", async (t) => {
  const host = new FakeUpdatesHost();
  host.others = ["work2"];
  const { world, updates } = await updating(t, host);
  const list = await offered(world);
  const mark = host.calls.length;
  assert.equal(await world.chat.as(OWNER).picks(list.message, VERSION), true);
  assert.deepEqual(host.calls.slice(mark), [
    "lock",
    "updatable",
    "supervised",
    "copyVersion",
    "install 0.3.1",
    "restartOthers",
    "restart",
    "unlock",
  ]);
  assert.deepEqual(host.installs, [{ copy: COPY, version: VERSION }]);
  assert.equal(host.heldLocks, 0);
  // the offer is rewritten in place, with nothing left to press
  assert.equal(world.chat.lists().length, 0);
  assert.equal(
    world.inChannel().at(-1),
    "Installed allaboard 0.3.1. Restarting once running turns finish.",
  );
  assert.equal(updates.line()?.phase, "restarting");
  assert.equal(world.sessions.startsBlocked, true, "no agent starts between the swap and the exit");
});

test("an instance that did not restart is told on the offer and on the page, with the command to run", async (t) => {
  const host = new FakeUpdatesHost();
  host.others = ["work2", null];
  host.restartFailures = [
    { instance: "work2", status: 1 },
    { instance: null, status: null },
  ];
  const { world, updates } = await updating(t, host);
  const list = await offered(world);
  await world.chat.as(OWNER).picks(list.message, VERSION);
  const lines = [
    "Instance `work2` did not restart: the service manager ended with status 1. `allaboard service restart --instance work2` in a terminal restarts it.",
    "The default instance did not restart: it has no service manager. `allaboard service restart` in a terminal restarts it.",
  ];
  assert.equal(
    world.inChannel().at(-1),
    ["Installed allaboard 0.3.1. Restarting once running turns finish.", ...lines].join("\n"),
  );
  assert.equal(updates.line()?.phase, "restarting");
  assert.equal(updates.line()?.note, lines.join("\n"));
  assert.ok(host.calls.includes("restart"), "this daemon still restarts");
});

test("an update whose other instances all restarted adds nothing to the line", async (t) => {
  const { world, updates } = await updating(t);
  const list = await offered(world);
  await world.chat.as(OWNER).picks(list.message, VERSION);
  assert.equal(updates.line()?.note, null);
});

test("the offer shows the install under way while npm runs", async (t) => {
  const { world, host } = await updating(t);
  const list = await offered(world);
  let release: () => void = () => {};
  host.hold = new Promise((resolve) => {
    release = resolve;
  });
  const clicking = world.chat.as(OWNER).picks(list.message, VERSION);
  await world.settle();
  assert.equal(world.inChannel().at(-1), "Installing allaboard 0.3.1…");
  assert.equal(world.updates?.line()?.phase, "installing");
  assert.equal(world.sessions.startsBlocked, true);
  release();
  await clicking;
});

test("a second click while the install runs installs nothing and tells the owner alone", async (t) => {
  const { world, host } = await updating(t);
  const list = await offered(world);
  let release: () => void = () => {};
  host.hold = new Promise((resolve) => {
    release = resolve;
  });
  const first = world.chat.as(OWNER).picks(list.message, VERSION);
  await world.settle();
  await world.inbound.picked(pickOf(world, list));
  assert.equal(world.inChannel().at(-1), "An update to 0.3.1 is already under way.");
  assert.equal(host.installs.length, 1);
  release();
  await first;
  assert.equal(host.installs.length, 1);
  assert.equal(host.calls.filter((call) => call === "restart").length, 1);
});

test("a click while another instance of the machine updates installs nothing", async (t) => {
  const { world, host, updates } = await updating(t);
  const list = await offered(world);
  host.lockTaken = true;
  await world.chat.as(OWNER).picks(list.message, VERSION);
  // Whose update it is and which version is not known: the sentence names none.
  assert.equal(world.inChannel().at(-1), "An update of allaboard is already under way.");
  assert.equal(host.installs.length, 0);
  assert.equal(updates.phase.kind, "idle", "the claim is let go");
  assert.equal(world.sessions.startsBlocked, false);
  assert.equal(world.chat.lists().length, 1, "the offer stays: it is the other update that runs");
});

test("a click on a daemon that is already stopping installs nothing", async (t) => {
  const { world, host } = await updating(t);
  const list = await offered(world);
  await world.sessions.drain(AbortSignal.abort());
  await world.chat.as(OWNER).picks(list.message, VERSION);
  assert.equal(
    world.inChannel().at(-1),
    "allaboard is restarting: send `!allaboard update` again once it is back.",
  );
  assert.deepEqual(host.installs, []);
  assert.ok(!host.calls.includes("lock"));
});

test("a stop that cancels the install before npm starts leaves a click installing nothing", async (t) => {
  const { world, host, updates } = await updating(t);
  const list = await offered(world);
  // The stop (a SIGINT, a failure) arrives while the click asks whether the copy updates.
  const updatable = host.updatable.bind(host);
  host.updatable = async (signal) => {
    const found = await updatable(signal);
    void updates.cancelInstall();
    return found;
  };
  await world.chat.as(OWNER).picks(list.message, VERSION);
  assert.deepEqual(host.installs, [], "npm was not started");
  assert.equal(
    world.inChannel().at(-1),
    "allaboard is restarting: send `!allaboard update` again once it is back.",
  );
  assert.equal(updates.phase.kind, "idle", "the claim is let go");
  assert.equal(world.sessions.startsBlocked, false);
});

test("a drain does not wait for a click that is still asking whether the copy updates", async (t) => {
  const { world, host, updates } = await updating(t);
  const list = await offered(world);
  // npm that hangs: the question ends only when it is aborted.
  host.updatable = (signal) =>
    new Promise((resolve) => {
      signal.addEventListener(
        "abort",
        () => resolve({ refusal: { kind: "npm", failure: { kind: "other", status: null } } }),
        { once: true },
      );
    });
  const clicking = world.chat.as(OWNER).picks(list.message, VERSION);
  await world.settle();
  assert.equal(updates.working, true, "the click is at work");
  const never = new AbortController();
  const drained = Promise.all([world.sessions.drain(never.signal), updates.settled(never.signal)]);
  const held = await Promise.race([
    drained.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 500)),
  ]);
  assert.equal(held, false, "the drain waited for a question to npm");
  await clicking;
  assert.deepEqual(host.installs, []);
  assert.equal(
    world.inChannel().at(-1),
    "allaboard is restarting: send `!allaboard update` again once it is back.",
  );
  assert.equal(updates.phase.kind, "idle");
  assert.equal(
    updates.canUpdate,
    true,
    "an aborted question does not turn the copy into a refusal",
  );
});

test("a click that carries no version installs nothing and changes nothing", async (t) => {
  const { world, host, updates } = await updating(t);
  const list = await offered(world);
  const mark = host.calls.length;
  for (const version of ["", "latest", "0.3.1 --global", "../0.3.1", "0.3"]) {
    await world.inbound.picked({ ...pickOf(world, list), version });
  }
  assert.deepEqual(host.calls.slice(mark), [], "no lock, no check, no install");
  assert.equal(updates.phase.kind, "idle");
  assert.equal(world.sessions.startsBlocked, false);
  assert.equal(world.chat.lists().length, 1, "the offer stays");
});

test("a click for the version the daemon already runs withdraws the controls", async (t) => {
  const { world, host } = await updating(t);
  const list = await offered(world);
  host.installed = VERSION;
  await world.chat.as(OWNER).picks(list.message, VERSION);
  assert.equal(world.inChannel().at(-1), "allaboard already runs 0.3.1.");
  assert.equal(world.chat.lists().length, 0);
  assert.deepEqual(host.installs, []);
  assert.equal(host.heldLocks, 0);
});

test("a click when the copy stopped being the updatable one says why, with no controls", async (t) => {
  const { world, host } = await updating(t);
  const list = await offered(world);
  host.copy = { refusal: { kind: "link" } };
  await world.chat.as(OWNER).picks(list.message, VERSION);
  assert.equal(
    world.inChannel().at(-1),
    "This copy updates outside Memory chat: it is a link, not an install.",
  );
  assert.deepEqual(host.installs, []);
  assert.equal(world.updates?.line(), null, "the page draws no line for it");
});

test("`!allaboard update` while another process replaces the copy makes no offer and says so", async (t) => {
  const host = new FakeUpdatesHost();
  host.copy = { swapping: true };
  const { world } = await updating(t, host);
  await world.says("!allaboard update");
  assert.equal(world.inChannel().at(-1), "An update of allaboard is already under way.");
  assert.equal(world.chat.lists().length, 0);
});

test("a click while another process replaces the copy installs nothing and keeps the offer", async (t) => {
  const { world, host, updates } = await updating(t);
  const list = await offered(world);
  host.copy = { swapping: true };
  await world.chat.as(OWNER).picks(list.message, VERSION);
  assert.equal(world.inChannel().at(-1), "An update of allaboard is already under way.");
  assert.deepEqual(host.installs, []);
  assert.equal(updates.phase.kind, "idle");
  assert.equal(world.sessions.startsBlocked, false);
  assert.equal(host.heldLocks, 0);
  assert.equal(world.chat.lists().length, 1, "the offer stays");
});

test("a click when npm cannot prove the copy says the latest version is unknown", async (t) => {
  const { world, host } = await updating(t);
  const list = await offered(world);
  host.copy = { refusal: { kind: "npm", failure: { kind: "network" } } };
  await world.chat.as(OWNER).picks(list.message, VERSION);
  assert.equal(
    world.inChannel().at(-1),
    "The latest version is unknown: npm could not reach the registry. `!allaboard update` tries again.",
  );
  assert.deepEqual(host.installs, []);
});

test("a click when no service runs the daemon says so, with no controls", async (t) => {
  const { world, host } = await updating(t);
  const list = await offered(world);
  host.service = false;
  await world.chat.as(OWNER).picks(list.message, VERSION);
  assert.equal(world.inChannel().at(-1), named(texts.UPDATE_NOT_A_SERVICE, PLAIN_NAMES));
  assert.deepEqual(host.installs, []);
});

test("a click when the copy already holds the version tells to restart instead", async (t) => {
  const { world, host } = await updating(t);
  const list = await offered(world);
  host.held = VERSION;
  await world.chat.as(OWNER).picks(list.message, VERSION);
  assert.equal(
    world.inChannel().at(-1),
    "The copy already holds 0.3.1; allaboard runs 0.3.0 until it restarts: `!allaboard restart`.",
  );
  assert.deepEqual(host.installs, []);
  assert.equal(world.updates?.line()?.failure !== null, true, "the page says it too");
});

test("a newer version that came out since the offer is named, and the click installs the one it shows", async (t) => {
  const { world, host, updates } = await updating(t);
  const list = await offered(world);
  host.newest = { version: "0.3.2" };
  await updates.check();
  let release: () => void = () => {};
  host.hold = new Promise((resolve) => {
    release = resolve;
  });
  const clicking = world.chat.as(OWNER).picks(list.message, VERSION);
  await world.settle();
  assert.equal(
    world.inChannel().at(-1),
    "Installing allaboard 0.3.1… 0.3.2 came out since this message: `!allaboard update` installs it after the restart.",
  );
  release();
  await clicking;
  assert.deepEqual(host.installs, [{ copy: COPY, version: VERSION }]);
});

const FAILURES = [
  [
    "a folder npm may not write",
    { kind: "failed", failure: { kind: "permission", path: "/fake/lib/node_modules" } },
    "The update failed: npm may not write to /fake/lib/node_modules. allaboard keeps running 0.3.0. npm's message is in the log, /fake/logs/allaboard.log.",
  ],
  [
    "a folder npm did not name",
    { kind: "failed", failure: { kind: "permission", path: null } },
    "The update failed: npm may not write to the folder it installs into. allaboard keeps running 0.3.0. npm's message is in the log, /fake/logs/allaboard.log.",
  ],
  [
    "a registry that cannot be reached",
    { kind: "failed", failure: { kind: "network" } },
    "The update failed: npm could not reach the registry. allaboard keeps running 0.3.0; `!allaboard update` tries again.",
  ],
  [
    "another npm failure",
    { kind: "failed", failure: { kind: "other", status: 243 } },
    "The update failed: npm ended with status 243. allaboard keeps running 0.3.0. npm's message is in the log, /fake/logs/allaboard.log.",
  ],
  [
    "a copy that holds another version",
    { kind: "mismatch", found: "0.2.9" },
    "npm ended, but the copy now holds 0.2.9 instead of 0.3.1, so allaboard does not restart and keeps running 0.3.0. In a terminal, `npm install -g allaboard@0.3.0` puts back the version that runs.",
  ],
  [
    "a copy left unreadable",
    { kind: "mismatch", found: null },
    "npm ended, but the copy's version cannot be read, so allaboard does not restart and keeps running 0.3.0. In a terminal, `npm install -g allaboard@0.3.0` repairs it.",
  ],
] as const;

for (const [name, outcome, sentence] of FAILURES) {
  test(`an install that ends with ${name} restarts nothing and says so`, async (t) => {
    const { world, host, updates } = await updating(t);
    host.outcome = outcome;
    const list = await offered(world);
    const mark = host.calls.length;
    await world.chat.as(OWNER).picks(list.message, VERSION);
    assert.equal(world.inChannel().at(-1), sentence);
    assert.deepEqual(
      host.calls.slice(mark).filter((call) => call.startsWith("restart")),
      [],
    );
    assert.equal(host.heldLocks, 0);
    assert.equal(world.chat.lists().length, 0);
    // nothing to undo: the daemon goes on, starts are allowed again, the page keeps the sentence
    assert.equal(world.sessions.startsBlocked, false);
    assert.equal(updates.phase.kind, "failed");
    assert.equal(updates.line()?.failure, sentence);
  });
}

test("an install that cannot run at all is a failed install", async (t) => {
  const { world, host } = await updating(t);
  host.install = async () => {
    throw new Error("spawn failed");
  };
  const list = await offered(world);
  await world.chat.as(OWNER).picks(list.message, VERSION);
  assert.match(world.inChannel().at(-1) ?? "", /^The update failed: npm ended with status unknown/);
  assert.equal(world.sessions.startsBlocked, false);
  assert.equal(host.heldLocks, 0);
});

test("a failed update may be tried again", async (t) => {
  const { world, host } = await updating(t);
  host.outcome = { kind: "failed", failure: { kind: "network" } };
  await world.says("!allaboard update");
  await world.chat.as(OWNER).picks(theOffer(world).message, VERSION);
  host.outcome = { kind: "installed", version: VERSION };
  await world.says("!allaboard update");
  await world.chat.as(OWNER).picks(theOffer(world).message, VERSION);
  assert.equal(host.installs.length, 2);
  assert.equal(host.calls.filter((call) => call === "restart").length, 1);
});

test("a click from somebody else never reaches the daemon", async (t) => {
  const { world, host } = await updating(t);
  const list = await offered(world);
  assert.equal(await world.chat.as(SOMEONE).picks(list.message, VERSION), false);
  assert.deepEqual(host.installs, []);
});

// ---- the chat's own page

test("a click on the chat's own page installs, and the page follows through the state", async (t) => {
  const { world, host, updates } = await updating(t);
  await updates.check();
  const phases: Array<string | undefined> = [];
  updates.onChange = () => phases.push(updates.line()?.phase);
  assert.equal(await world.chat.as(OWNER).picksOnPage(VERSION), true);
  assert.deepEqual(host.installs, [{ copy: COPY, version: VERSION }]);
  assert.deepEqual(
    phases.filter((phase, at) => phase !== phases[at - 1]),
    ["installing", "restarting"],
  );
  assert.equal(world.inChannel().length, 0, "nothing was written in a channel");
  assert.ok(host.calls.includes("restart"));
});

test("a failed click on the page leaves the sentence on the line and writes nowhere", async (t) => {
  const { world, host, updates } = await updating(t);
  await updates.check();
  host.outcome = { kind: "failed", failure: { kind: "network" } };
  await world.chat.as(OWNER).picksOnPage(VERSION);
  assert.equal(updates.line()?.phase, "failed");
  assert.equal(
    updates.line()?.failure,
    "The update failed: npm could not reach the registry. allaboard keeps running 0.3.0; `!allaboard update` tries again.",
  );
  assert.equal(world.inChannel().length, 0);
});

test("a second click on the page while one installs does nothing", async (t) => {
  const { world, host, updates } = await updating(t);
  await updates.check();
  let release: () => void = () => {};
  host.hold = new Promise((resolve) => {
    release = resolve;
  });
  const first = world.chat.as(OWNER).picksOnPage(VERSION);
  await world.settle();
  await world.chat.as(OWNER).picksOnPage(VERSION);
  assert.equal(host.installs.length, 1);
  release();
  await first;
  assert.equal(world.inChannel().length, 0);
});

test("a click on the page from somebody else never reaches the daemon", async (t) => {
  const { world, host, updates } = await updating(t);
  await updates.check();
  assert.equal(await world.chat.as(SOMEONE).picksOnPage(VERSION), false);
  assert.deepEqual(host.installs, []);
});

// ---- no new agent process while npm replaces the copy

test("while an install runs a session goes on and a new one is not started", async (t) => {
  const { world, host } = await updating(t);
  const connected = await world.opened("first");
  const list = await offered(world);
  const before = started(world);
  let release: () => void = () => {};
  host.hold = new Promise((resolve) => {
    release = resolve;
  });
  const clicking = world.chat.as(OWNER).picks(list.message, VERSION);
  await world.settle();
  // the connected session takes its message
  await world.says("and more", connected.thread);
  assert.ok((await world.prompts()).includes("and more"));
  // a message that opens a new thread is refused, and starts nothing
  const fresh = await world.says("a new topic");
  assert.equal(world.shown(fresh.ref).at(-1), texts.RESTARTING);
  assert.equal(started(world), before);
  assert.equal(world.state.thread(fresh.ref.channel, fresh.ref.thread), null, "nothing was opened");
  release();
  await clicking;
});

test("while an install runs a word that would start the agent is refused", async (t) => {
  const { world, host } = await updating(t);
  // a thread the daemon knows from before its restart: no process yet
  const ref = world.chat.openThread(world.channel);
  world.state.openThread(world.channel, ref.thread, "stored-session");
  const list = await offered(world);
  const before = started(world);
  let release: () => void = () => {};
  host.hold = new Promise((resolve) => {
    release = resolve;
  });
  const clicking = world.chat.as(OWNER).picks(list.message, VERSION);
  await world.settle();
  await world.says("!status", ref.thread);
  assert.equal(world.shown(ref).at(-1), texts.RESTARTING);
  await world.says("!help", ref.thread);
  assert.equal(world.shown(ref).at(-1), texts.RESTARTING);
  await world.says("a prompt", ref.thread);
  assert.equal(world.shown(ref).at(-1), texts.RESTARTING);
  assert.equal(started(world), before, "none of the three started a process");
  release();
  await clicking;
});

test("while another process updates a new thread is refused and starts nothing, a connected one goes on", async (t) => {
  const { world, host } = await updating(t);
  const connected = await world.opened("first");
  const before = started(world);
  host.updating = true;
  await world.says("and more", connected.thread);
  assert.ok((await world.prompts()).includes("and more"));
  const fresh = await world.says("a new topic");
  assert.equal(world.shown(fresh.ref).at(-1), texts.RESTARTING);
  assert.equal(started(world), before);
  assert.equal(world.state.thread(fresh.ref.channel, fresh.ref.thread), null, "nothing was opened");
  host.updating = false;
  await world.opened("after the update");
  assert.equal(started(world), before + 1);
});

test("once the install failed, a new thread starts a process again", async (t) => {
  const { world, host } = await updating(t);
  host.outcome = { kind: "failed", failure: { kind: "network" } };
  const list = await offered(world);
  await world.chat.as(OWNER).picks(list.message, VERSION);
  await world.opened("after the failure");
  assert.equal(started(world), 1);
});

test("once the install succeeded no process starts before the exit", async (t) => {
  const { world } = await updating(t);
  const list = await offered(world);
  await world.chat.as(OWNER).picks(list.message, VERSION);
  const fresh = await world.says("a new topic");
  assert.equal(world.shown(fresh.ref).at(-1), texts.RESTARTING);
  assert.equal(started(world), 0);
});

// ---- `restart`

test("`!allaboard restart` says so and asks the daemon to stop once running turns finish", async (t) => {
  const { world, host } = await updating(t);
  await world.says("!allaboard restart");
  assert.equal(world.inChannel().at(-1), "Restarting allaboard once running turns finish.");
  assert.deepEqual(
    host.calls.filter((call) => call === "restart"),
    ["restart"],
  );
});

test("`!allaboard restart` on a daemon no service runs does not stop it", async (t) => {
  const host = new FakeUpdatesHost();
  host.service = false;
  const { world } = await updating(t, host);
  await world.says("!allaboard restart");
  assert.equal(world.inChannel().at(-1), named(texts.UPDATE_NOT_A_SERVICE, PLAIN_NAMES));
  assert.ok(!host.calls.includes("restart"));
});

test("`!allaboard restart` during an install does not cut it", async (t) => {
  const { world, host } = await updating(t);
  const list = await offered(world);
  let release: () => void = () => {};
  host.hold = new Promise((resolve) => {
    release = resolve;
  });
  const clicking = world.chat.as(OWNER).picks(list.message, VERSION);
  await world.settle();
  await world.says("!allaboard restart");
  assert.equal(world.inChannel().at(-1), "An update to 0.3.1 is already under way.");
  assert.ok(!host.calls.includes("restart"));
  release();
  await clicking;
});

test("`!allaboard restart` while another process updates restarts nothing and says so", async (t) => {
  const { world, host } = await updating(t);
  host.updating = true;
  await world.says("!allaboard restart");
  assert.equal(world.inChannel().at(-1), "An update of allaboard is already under way.");
  assert.ok(!host.calls.includes("restart"));
  host.updating = false;
  await world.says("!allaboard restart");
  assert.equal(world.inChannel().at(-1), "Restarting allaboard once running turns finish.");
});

test("`!allaboard restart` on a daemon that is stopping says it is restarting", async (t) => {
  const { world, host } = await updating(t);
  await world.sessions.drain(AbortSignal.abort());
  await world.says("!allaboard restart");
  assert.equal(world.inChannel().at(-1), texts.RESTARTING);
  assert.ok(!host.calls.includes("restart"));
});

// ---- the line told once per version

const AVAILABLE =
  "allaboard 0.3.1 is available (this copy runs 0.3.0) · `!allaboard update` installs it";

/** Whether `ref` shows a line that tells of a version. */
function told(world: MessagesWorld, ref: Parameters<MessagesWorld["shown"]>[0]): boolean {
  return world.shown(ref).some((line) => line.includes(" is available (this copy runs "));
}

test("the owner's first message after the daemon learned of a version is told, once", async (t) => {
  const { world, updates } = await updating(t);
  await updates.check();
  const first = await world.opened("hello");
  assert.equal(world.state.updateNotice, VERSION);
  await world.says("hello again", first.thread);
  const other = await world.says("!help");
  assert.equal(world.inChannel().filter((line) => line === AVAILABLE).length, 1);
  assert.equal(told(world, first), false, "nor in the thread");
  assert.equal(told(world, other.ref), false, "nor under a message of another thread");
});

test("a message in a thread is told in that thread", async (t) => {
  const { world, updates } = await updating(t);
  const first = await world.opened("hello");
  await updates.check();
  await world.says("hello again", first.thread);
  assert.ok(world.shown(first).includes(AVAILABLE));
  assert.equal(world.inChannel().includes(AVAILABLE), false);
});

test("a message of the channel is told in the channel: its thread has no reply yet", async (t) => {
  // A chat may show a line for the owner alone in a thread only once that thread is active
  // (as a line shown to the owner alone does), and a message of the channel has none yet.
  const { world, updates } = await updating(t);
  await updates.check();
  const first = await world.opened("hello");
  assert.ok(world.inChannel().includes(AVAILABLE));
  assert.equal(told(world, first), false);
});

test("the message is handled as it was, whether the owner was told or not", async (t) => {
  const { world, updates } = await updating(t);
  await updates.check();
  await world.opened("work on it");
  assert.deepEqual(await world.prompts(), ["work on it"]);
});

test("a restart of the daemon does not tell him of the same version again", async (t) => {
  const first = await updating(t);
  await first.updates.check();
  await first.world.says("!help");
  assert.ok(first.world.inChannel().includes(AVAILABLE));
  assert.equal(first.world.state.updateNotice, VERSION);
  const again = await MessagesWorld.make(t, {
    host: new FakeUpdatesHost(),
    restartOf: first.world,
  });
  assert.equal(again.state.updateNotice, VERSION, "state.json kept it");
  await again.updates?.check();
  // The chat is the same one: the line of the first run is still in the channel.
  const before = again.inChannel().filter((line) => line === AVAILABLE).length;
  await again.says("!help");
  assert.equal(again.inChannel().filter((line) => line === AVAILABLE).length, before);
});

test("a version newer still is told once more", async (t) => {
  const { world, host, updates } = await updating(t);
  await updates.check();
  await world.says("!help");
  host.newest = { version: "0.3.2" };
  await updates.check();
  await world.says("!help");
  assert.ok(
    world
      .inChannel()
      .includes(
        "allaboard 0.3.2 is available (this copy runs 0.3.0) · `!allaboard update` installs it",
      ),
  );
  assert.equal(world.state.updateNotice, "0.3.2");
});

test("nobody is told when the daemon is up to date, has not checked, or cannot update", async (t) => {
  const host = new FakeUpdatesHost();
  const { world, updates } = await updating(t, host);
  assert.equal(told(world, (await world.says("!help")).ref), false, "before any check");
  host.newest = { version: "0.3.0" };
  await updates.check();
  assert.equal(told(world, (await world.says("!help")).ref), false, "up to date");
  host.newest = { version: VERSION };
  host.copy = { refusal: { kind: "not-global", folder: "/elsewhere" } };
  await updates.check();
  assert.equal(told(world, (await world.says("!help")).ref), false, "a copy that updates outside");
  assert.equal(world.state.updateNotice, null, "nothing was recorded");
});

test("asking about allaboard is being told: the line is not added to its answer", async (t) => {
  const { world, updates } = await updating(t);
  await updates.check();
  const asked = await world.says("!allaboard");
  assert.equal(told(world, asked.ref), false);
  assert.equal(world.state.updateNotice, VERSION);
  assert.equal(told(world, (await world.says("!help")).ref), false);
});

test("a state that cannot be written does not hold the message back", async (t) => {
  const { world, updates } = await updating(t);
  await updates.check();
  t.mock.method(StateStore.prototype, "setUpdateNotice", () => {
    throw new Error("disk full");
  });
  const ref = await world.opened("still handled");
  assert.deepEqual(await world.prompts(), ["still handled"]);
  assert.equal(told(world, ref), false);
});

test("a chat that refuses the line in a thread does not hold the message back", async (t) => {
  const { world, updates } = await updating(t);
  const first = await world.opened("hello");
  await updates.check();
  // The thread's own `tell` is what the line goes through; the chat may refuse it.
  const thread = world.provider.thread(first);
  t.mock.method(Object.getPrototypeOf(thread) as { tell(): Promise<void> }, "tell", async () => {
    throw new Error("a chat that refused the line");
  });
  await world.says("hello again", first.thread);
  assert.deepEqual(await world.prompts(), ["hello", "hello again"]);
});

test("the line does not reorder the owner's messages of a thread", async (t) => {
  const { world, updates } = await updating(t);
  const ref = await world.opened("first");
  await updates.check();
  const one = world.says("one", ref.thread);
  const two = world.says("two", ref.thread);
  await Promise.all([one, two]);
  await world.settle();
  assert.deepEqual(await world.prompts(), ["first", "one", "two"]);
});

test("a message that opens a thread while a stop closes the sessions is told, and opens nothing", async (t) => {
  const { world, host } = await updating(t);
  // The question about another update is slow enough for the stop to come in between.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  host.updateHeld = async () => {
    await held;
    return false;
  };
  const sending = world.says("first");
  await world.settle();
  await world.sessions.closeAll();
  release();
  const sent = await sending;
  await world.settle();
  assert.ok(world.shown(sent.ref).some((line) => line.includes(texts.SESSION_CLOSED)));
  assert.equal(started(world), 0, "no agent process was started");
});

// ---- the message the next start rewrites

/** The restart notice `state.json` holds at the moment the host is asked to stop the daemon. */
function recordedAtRestart(world: MessagesWorld, host: FakeUpdatesHost) {
  const seen: Array<ReturnType<typeof readNotice>> = [];
  host.restart = () => {
    host.calls.push("restart");
    seen.push(readNotice(world));
  };
  return seen;
}

function readNotice(world: MessagesWorld) {
  const file = JSON.parse(readFileSync(join(world.folder, "state.json"), "utf8")) as {
    restart_notice?: unknown;
  };
  return file.restart_notice ?? null;
}

test("`!allaboard restart` records its message in state.json before it asks the stop", async (t) => {
  const { world, host } = await updating(t);
  const seen = recordedAtRestart(world, host);
  await world.says("!allaboard restart");
  const message = world.chat
    .messages(world.channel)
    .find((m) => m.text === texts.UPDATE_RESTART)?.id;
  assert.ok(message, "the line is a message of the channel");
  const expected = { channel: world.channel, message, version: null };
  assert.deepEqual(seen, [expected], "on disk when the stop is asked");
  assert.deepEqual(world.state.restartNotice, expected);
});

test("two `!allaboard restart` at once: one line, one record, one stop; the second is told it is restarting", async (t) => {
  const { world, host } = await updating(t);
  await Promise.all([world.says("!allaboard restart"), world.says("!allaboard restart")]);
  const shown = world.chat.messages(world.channel).map((m) => m.text);
  assert.equal(shown.filter((text) => text === texts.UPDATE_RESTART).length, 1);
  assert.equal(shown.filter((text) => text === texts.RESTARTING).length, 1);
  assert.equal(host.calls.filter((call) => call === "restart").length, 1);
  const message = world.chat
    .messages(world.channel)
    .find((m) => m.text === texts.UPDATE_RESTART)?.id;
  assert.deepEqual(world.state.restartNotice, { channel: world.channel, message, version: null });
});

test("a restart that was refused does not keep the next one from going ahead", async (t) => {
  const host = new FakeUpdatesHost();
  host.updating = true;
  const { world } = await updating(t, host);
  await world.says("!allaboard restart");
  assert.ok(!host.calls.includes("restart"));
  host.updating = false;
  await world.says("!allaboard restart");
  assert.ok(host.calls.includes("restart"));
});

test("a click from a channel's offer records the offer's message and the version asked, before the stop", async (t) => {
  const { world, host } = await updating(t);
  const seen = recordedAtRestart(world, host);
  const list = await offered(world);
  await world.chat.as(OWNER).picks(list.message, VERSION);
  const expected = { channel: world.channel, message: list.message, version: VERSION };
  assert.deepEqual(seen, [expected]);
  assert.deepEqual(world.state.restartNotice, expected);
});

test("an offer that tells of an instance that did not restart is kept as it is: nothing recorded", async (t) => {
  // The next start would rewrite the whole offer into `Updated to…`, and the instance still to
  // restart by hand would no longer be named anywhere in the channel.
  const host = new FakeUpdatesHost();
  host.others = ["work2"];
  host.restartFailures = [{ instance: "work2", status: 1 }];
  const { world } = await updating(t, host);
  const seen = recordedAtRestart(world, host);
  const list = await offered(world);
  await world.chat.as(OWNER).picks(list.message, VERSION);
  assert.deepEqual(seen, [null], "the stop was asked, with nothing recorded");
  assert.equal(world.state.restartNotice, null);
});

test("a click on the chat's own page has no message and records nothing", async (t) => {
  const { world, host, updates } = await updating(t);
  const seen = recordedAtRestart(world, host);
  await updates.check();
  assert.equal(await world.chat.as(OWNER).picksOnPage(VERSION), true);
  assert.deepEqual(seen, [null], "the stop was asked, with nothing recorded");
  assert.equal(world.state.restartNotice, null);
});

test("a chat that cannot name the message leaves nothing recorded, and the restart goes on", async (t) => {
  const { world, host } = await updating(t);
  t.mock.method(
    Object.getPrototypeOf(world.provider.channel(world.channel)),
    "notice",
    async () => null,
  );
  await world.says("!allaboard restart");
  assert.equal(world.state.restartNotice, null);
  assert.ok(host.calls.includes("restart"));
});

test("a state that cannot be written does not hold the restart back", async (t) => {
  const { world, host } = await updating(t);
  t.mock.method(StateStore.prototype, "setRestartNotice", () => {
    throw new Error("disk full");
  });
  await world.says("!allaboard restart");
  assert.ok(host.calls.includes("restart"));
});

for (const [name, arrange] of [
  [
    "an install that failed",
    (host: FakeUpdatesHost) => {
      host.outcome = { kind: "failed", failure: { kind: "network" } };
    },
  ],
  [
    "an install that left another version",
    (host: FakeUpdatesHost) => {
      host.outcome = { kind: "mismatch", found: "0.2.9" };
    },
  ],
] as const) {
  test(`${name} stops nothing and records nothing`, async (t) => {
    const { world, host } = await updating(t);
    arrange(host);
    const list = await offered(world);
    await world.chat.as(OWNER).picks(list.message, VERSION);
    assert.ok(!host.calls.includes("restart"));
    assert.equal(world.state.restartNotice, null);
  });
}

test("a restart refused (not a service, another update, a stop under way) records nothing", async (t) => {
  const host = new FakeUpdatesHost();
  host.service = false;
  const { world } = await updating(t, host);
  await world.says("!allaboard restart");
  host.service = true;
  host.updating = true;
  await world.says("!allaboard restart");
  host.updating = false;
  await world.sessions.drain(AbortSignal.abort());
  await world.says("!allaboard restart");
  assert.equal(world.state.restartNotice, null);
});
