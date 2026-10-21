/**
 * Step 9 of the scenario the memory chat carries: the update of allaboard from the chat, through the real `run`. The machine is `FakeMachine`: npm answers from fields and writes
 * the installed version into a copy in the test's folder, a service manager reports pids and
 * counts restarts. The owner types `!allaboard update`, presses the offer's control, the install
 * runs while a turn goes on, and the daemon stops by itself once the turn ends: `run` returns 0
 * and the service (here: nothing) would start it again.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ChatProvider } from "../../src/chat/seam.ts";
import { DRAIN_POLL_SECONDS } from "../../src/core/sessions/constants.ts";
import * as texts from "../../src/core/texts.ts";
import { fill } from "../../src/core/texts.ts";
import { UPDATE_CHECK_SECONDS } from "../../src/core/updates.ts";
import { installedVersion } from "../../src/version.ts";
import { hold, say } from "../support/plain-agent.ts";
import { FakeService } from "../support/updates.ts";
import { CHAT_NAME, World } from "./world.ts";

const RUNNING = installedVersion();
/** A version newer than whatever this checkout is at. */
const NEWER = `${Number(RUNNING.split(".")[0]) + 1}.0.0`;

/** The npm commands of the machine that asked for a version. */
function views(world: World): string[] {
  return world.machine.npm.filter((args) => args[0] === "view").map((args) => args.join(" "));
}

/** The machine has a service for the default instance that runs this very process. */
function supervised(world: World): FakeService {
  const service = new FakeService();
  service.pid = process.pid;
  world.machine.services.set("", service);
  return service;
}

test("the check at start and the click: install while a turn goes on, then the stop, then exit 0", async (t) => {
  const world = World.make(t);
  world.machine.newest = NEWER;
  const service = supervised(world);
  const other = new FakeService();
  other.pid = 4242;
  world.machine.services.set("work2", other);
  const entry = { copy: world.machine.copy, version: RUNNING };
  service.rows = [
    { instance: null, loaded: true, pid: process.pid, entry },
    { instance: "work2", loaded: true, pid: 4242, entry },
  ];
  await world.start();
  await world.settle();
  assert.deepEqual(views(world).slice(0, 1), ["view allaboard version --json"], "checked at start");

  // A turn is running when the owner updates.
  world.script(say("Working"), hold());
  const thread = await world.open("first");
  await world.until(() => world.shown(thread).length === 3, "the reply under way");

  await world.owner.says(world.channel, "!allaboard update");
  await world.settle();
  const [list] = world.chat.lists();
  assert.ok(list, "the offer is posted");
  assert.equal(list.list.type, "update");
  assert.ok(
    world.chat
      .texts(world.channel)
      .includes(fill(texts.UPDATE_OFFER, { installed: RUNNING, latest: NEWER })),
    "the offer says what it installs",
  );

  assert.equal(await world.owner.picks(list.message, NEWER), true);
  await world.settle();

  // Installed over the copy the daemon runs from, and the other instance on it told to restart.
  assert.equal(world.machine.held, NEWER);
  assert.equal(other.restarts, 1);
  assert.equal(service.restarts, 0, "this daemon restarts itself, not through its service");
  // The turn goes on: the daemon waits for it before it stops.
  let code: number | null = null;
  void world.running?.then((value) => {
    code = value;
  });
  await world.settle();
  assert.equal(code, null, "running turns finish first");
  assert.equal(
    world.chat.texts(world.channel).at(-1),
    fill(texts.UPDATE_INSTALLED, { latest: NEWER }),
  );

  world.plain.running[0]?.release();
  // The drain polls the sessions on the daemon's clock.
  for (let poll = 0; poll < 20 && code === null; poll += 1) {
    await world.clock.advance(DRAIN_POLL_SECONDS);
    await world.settle();
  }
  assert.equal(code, 0);
  await world.finish();
});

test("a daemon its service does not run is not offered an update", async (t) => {
  const world = World.make(t);
  world.machine.newest = NEWER;
  const service = new FakeService();
  service.pid = process.pid + 1; // the service runs another process
  world.machine.services.set("", service);
  await world.start();
  await world.owner.says(world.channel, "!allaboard update");
  await world.settle();
  assert.deepEqual(world.chat.lists(), []);
  assert.ok(world.chat.texts(world.channel).at(-1)?.includes("not running as a service"));
  await world.finish();
});

test("a daemon with no service manager at all is not offered one either", async (t) => {
  const world = World.make(t);
  world.machine.newest = NEWER;
  await world.start();
  await world.owner.says(world.channel, "!allaboard update");
  await world.settle();
  assert.deepEqual(world.chat.lists(), []);
  await world.finish();
});

test("the registry is asked every 6 hours, and no more once the daemon stops", async (t) => {
  const world = World.make(t);
  world.machine.newest = NEWER;
  supervised(world);
  await world.start();
  await world.settle();
  const first = views(world).length;
  assert.ok(first >= 1);
  await world.clock.advance(UPDATE_CHECK_SECONDS);
  await world.settle();
  assert.ok(views(world).length > first, "asked again after 6 hours");

  assert.equal(await world.stop("SIGTERM"), 0);
  const stopped = views(world).length;
  await world.clock.advance(UPDATE_CHECK_SECONDS * 2);
  await world.settle();
  assert.equal(views(world).length, stopped);
  await world.finish();
});

test("an install that leaves another version changes nothing and the daemon keeps running", async (t) => {
  const world = World.make(t);
  world.machine.newest = NEWER;
  world.machine.leaves = "0.0.1";
  supervised(world);
  await world.start();
  await world.owner.says(world.channel, "!allaboard update");
  await world.settle();
  const [list] = world.chat.lists();
  assert.ok(list);
  await world.owner.picks(list.message, NEWER);
  await world.settle();
  assert.equal(
    world.chat.texts(world.channel).at(-1),
    fill(texts.UPDATE_MISMATCH, { found: "0.0.1", latest: NEWER, installed: RUNNING }),
  );
  assert.equal(world.signals.listenerCount("SIGTERM") > 0, true, "still running");
  assert.equal(await world.stop("SIGTERM"), 0);
  await world.finish();
});

/** The daemon stops by itself once the stop it asked for has drained; resolves with its exit code. */
async function stopsByItself(world: World): Promise<number> {
  let code: number | null = null;
  void world.running?.then((value) => {
    code = value;
  });
  for (let poll = 0; poll < 20 && code === null; poll += 1) {
    await world.clock.advance(DRAIN_POLL_SECONDS);
    await world.settle();
  }
  assert.notEqual(code, null, "the daemon stopped");
  world.running = null;
  return code ?? -1;
}

/** `HH:MM` of `seconds` on this machine's clock, derived here and not by the code under test. */
function clock(seconds: number): string {
  return new Date(seconds * 1000).toTimeString().slice(0, 5);
}

test("`!allaboard restart`: the next start rewrites the line, in place and once", async (t) => {
  const world = World.make(t);
  supervised(world);
  await world.start();
  await world.owner.says(world.channel, "!allaboard restart");
  await world.settle();
  assert.deepEqual(world.chat.texts(world.channel).slice(-1), [texts.UPDATE_RESTART]);
  const [line] = world.chat.messages(world.channel).slice(-1);
  assert.equal(await stopsByItself(world), 0);
  const stored = JSON.parse(readFileSync(world.state, "utf8")) as Record<string, unknown>;
  assert.deepEqual(stored.restart_notice, {
    channel: world.channel,
    message: line?.id,
    version: null,
  });

  // A minute passes while the service starts it again.
  await world.clock.advance(60);
  await world.start();
  const after = world.chat.messages(world.channel).find((m) => m.id === line?.id);
  assert.equal(after?.text, fill(texts.UPDATE_RESTARTED, { time: clock(world.clock.time()) }));
  assert.equal(after?.kind, "notice");
  assert.ok(
    !world.chat.texts(world.channel).includes(texts.UPDATE_RESTART),
    "the old line is gone",
  );
  const kept = JSON.parse(readFileSync(world.state, "utf8")) as Record<string, unknown>;
  assert.ok(!("restart_notice" in kept), "forgotten");

  // A third start has nothing to rewrite.
  const shown = world.chat.texts(world.channel);
  assert.equal(await world.stop("SIGTERM"), 0);
  await world.start();
  assert.deepEqual(world.chat.texts(world.channel), shown);
  await world.finish();
});

test("a restart typed as the chat connects keeps its line and its record", async (t) => {
  const world = World.make(t);
  supervised(world);
  // The owner is heard from the moment `start` has registered the daemon's inbound: the
  // restart arrives before the start has read anything else.
  const entry = world.registry.chats[CHAT_NAME];
  assert.ok(entry);
  (world.registry.chats as Record<string, typeof entry>)[CHAT_NAME] = {
    ...entry,
    build: async (context) => {
      const provider = await entry.build(context);
      return new Proxy(provider, {
        get(target, property) {
          const member = Reflect.get(target, property, target);
          if (property !== "start")
            return typeof member === "function" ? member.bind(target) : member;
          return async (...args: Parameters<ChatProvider["start"]>) => {
            await target.start(...args);
            await world.owner.says(world.channel, "!allaboard restart");
          };
        },
      });
    },
  };
  await world.start();
  await world.settle();
  const [line] = world.chat.messages(world.channel).slice(-1);
  assert.equal(line?.text, texts.UPDATE_RESTART, "it was not rewritten as the daemon connected");
  assert.equal(await stopsByItself(world), 0);
  const stored = JSON.parse(readFileSync(world.state, "utf8")) as Record<string, unknown>;
  assert.deepEqual(stored.restart_notice, {
    channel: world.channel,
    message: line?.id,
    version: null,
  });
  await world.finish();
});

test("an update from the offer that the next start does not run says it did not take", async (t) => {
  const world = World.make(t);
  world.machine.newest = NEWER;
  supervised(world);
  await world.start();
  await world.owner.says(world.channel, "!allaboard update");
  await world.settle();
  const [list] = world.chat.lists();
  assert.ok(list);
  await world.owner.picks(list.message, NEWER);
  await world.settle();
  assert.equal(await stopsByItself(world), 0);
  const stored = JSON.parse(readFileSync(world.state, "utf8")) as Record<string, unknown>;
  assert.deepEqual(stored.restart_notice, {
    channel: world.channel,
    message: list.message,
    version: NEWER,
  });

  // This test process still runs RUNNING: the start finds the update did not take.
  await world.start();
  const after = world.chat.messages(world.channel).find((m) => m.id === list.message);
  assert.equal(after?.text, fill(texts.UPDATE_NOT_TAKEN, { installed: RUNNING, asked: NEWER }));
  assert.equal(after?.pressable ?? false, false);
  await world.finish();
});
