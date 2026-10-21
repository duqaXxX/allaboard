/**
 * The update of allaboard from Slack, through Bolt's own entry point and the real
 * core flows: the line only the owner sees under his first message, the offer `!allaboard update`
 * posts, its button, the Update button of the Home tab, and what the click leaves on both. The
 * host (npm, the service) is `FakeUpdatesHost`: nothing is installed or signalled. The payloads
 * are the recorded events and clicks of `test/fixtures/slack/`, through the builders of
 * `test/support/slack-app.ts`; the Home click is the `block_actions` payload of the Home tab
 * (block_actions payload reference, docs.slack.dev, read 2026-10-01).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { HOME_UPDATE_ACTION } from "../../../../src/chat/slack/home.ts";
import { UPDATE_ACTION } from "../../../../src/chat/slack/update.ts";
import * as texts from "../../../../src/core/texts.ts";
import { fill } from "../../../../src/core/texts.ts";
import { CHANNEL, OWNER, THREAD } from "../../../support/fake-slack.ts";
import {
  type Body,
  clickIn,
  homeAction,
  message,
  reply,
  updatingWorld,
  type World,
} from "../../../support/slack-app.ts";
import { COPY } from "../../../support/updates.ts";

const NOTICE = fill(texts.UPDATE_NOTICE, { latest: "0.3.1", installed: "0.3.0" });

/** The ephemeral messages with this text, as the calls that posted them. */
function ephemeralsSaying(world: World, text: string): Body[] {
  return (world.slack.callsTo("chat.postEphemeral") as Body[]).filter((call) => call.text === text);
}

/** The offer `!allaboard update` posted: its `ts` and its blocks. */
function theOffer(world: World): { ts: string; blocks: Body[] } {
  const posts = world.slack.callsTo("chat.postMessage") as Body[];
  const index = posts.findIndex((post) => JSON.stringify(post.blocks).includes(UPDATE_ACTION));
  assert.ok(index >= 0, "the offer was posted");
  return { ts: world.slack.postedTs[index] as string, blocks: posts[index]?.blocks };
}

test("the owner's first message of the channel after a check is answered with one line only he sees, in the channel", async (t) => {
  const { world, updates } = updatingWorld(t);
  await updates.check();
  await world.dispatch(message("hello", { ts: THREAD }));
  await world.settle();
  const told = ephemeralsSaying(world, NOTICE);
  assert.equal(told.length, 1);
  assert.equal(told[0]?.channel, CHANNEL);
  assert.equal(told[0]?.user, OWNER);
  // Slack shows an ephemeral message in a thread only once the thread is active
  // (`chat.postEphemeral` reference), and his message has no reply yet.
  assert.equal(told[0]?.thread_ts, undefined, "in the channel, not in the thread it opens");
  // Once per version: the next message, in the thread or out of it, is not told again.
  await world.dispatch(reply("and again", THREAD));
  await world.dispatch(message("a new one", { ts: "1780000000.000050" }));
  await world.settle();
  assert.equal(ephemeralsSaying(world, NOTICE).length, 1);
});

test("a first message that is a reply in a thread is told in that thread", async (t) => {
  const { world, updates } = updatingWorld(t);
  await updates.check();
  await world.dispatch(reply("hello", THREAD));
  await world.settle();
  const told = ephemeralsSaying(world, NOTICE);
  assert.equal(told.length, 1);
  assert.equal(told[0]?.thread_ts, THREAD);
});

test("nothing is told before a check found a newer version", async (t) => {
  const { world } = updatingWorld(t);
  await world.dispatch(message("hello", { ts: THREAD }));
  await world.settle();
  assert.equal(ephemeralsSaying(world, NOTICE).length, 0);
});

test("!allaboard update posts the offer, and its button installs the version it shows", async (t) => {
  const { world, host, updates } = updatingWorld(t);
  await updates.check();
  await world.dispatch(message("!allaboard update", { ts: THREAD }));
  await world.settle();
  const offer = theOffer(world);
  const [line, drain] = offer.blocks;
  assert.equal(
    line?.text.text,
    "Update allaboard 0.3.0 → 0.3.1 · <https://example.test/changelog/v0.3.1|What changed>",
  );
  assert.equal(line?.accessory.action_id, UPDATE_ACTION);
  assert.equal(line?.accessory.value, "0.3.1");
  assert.equal(drain?.elements[0].text, texts.UPDATE_DRAIN);

  world.slack.apiCalls.length = 0;
  await world.dispatch(clickIn(UPDATE_ACTION, "0.3.1", CHANNEL, offer.ts, { messageTs: offer.ts }));
  await world.settle();
  assert.deepEqual(host.installs, [{ copy: COPY, version: "0.3.1" }]);
  assert.equal(host.calls.at(-1) === "unlock" ? host.calls.at(-2) : host.calls.at(-1), "restart");
  // The offer was rewritten in place: installing, then installed, with nothing left to press.
  const rewrites = world.slack.callsTo("chat.update") as Body[];
  assert.deepEqual(
    rewrites.map((call) => [call.ts, call.text]),
    [
      [offer.ts, fill(texts.UPDATE_INSTALLING, { latest: "0.3.1" })],
      [offer.ts, fill(texts.UPDATE_INSTALLED, { latest: "0.3.1" })],
    ],
  );
  assert.ok(!JSON.stringify(rewrites).includes("action_id"));
});

test("a second click while the install runs is answered for the owner alone, in the channel", async (t) => {
  const { world, host, updates } = updatingWorld(t);
  await updates.check();
  await world.dispatch(message("!allaboard update", { ts: THREAD }));
  await world.settle();
  const offer = theOffer(world);
  let release: () => void = () => {};
  host.hold = new Promise((resolve) => {
    release = resolve;
  });
  const click = () => clickIn(UPDATE_ACTION, "0.3.1", CHANNEL, offer.ts, { messageTs: offer.ts });
  await world.dispatch(click());
  await world.dispatch(click());
  const under = ephemeralsSaying(world, fill(texts.UPDATE_UNDER_WAY, { version: "0.3.1" }));
  assert.equal(under.length, 1);
  assert.equal(under[0]?.channel, CHANNEL);
  assert.equal(under[0]?.user, OWNER);
  assert.ok(!("thread_ts" in (under[0] ?? {})), "a line of the channel, not of a thread");
  release();
  await world.settle();
  assert.equal(host.installs.length, 1, "one install, whatever the clicks");
});

test("the Home tab shows the update, then installing, and its button installs", async (t) => {
  const { world, host, updates } = updatingWorld(t);
  updates.onChange = () => world.home.request();
  await updates.check();
  await world.homeClock.advance(3);
  await world.idle();
  const pages = () => world.slack.callsTo("views.publish").map((call) => call.view as Body);
  const available = pages()
    .at(-1)
    ?.blocks.find((b: Body) => b.accessory?.action_id === HOME_UPDATE_ACTION);
  assert.equal(available?.accessory.value, "0.3.1");
  assert.equal(available?.accessory.confirm.title.text, texts.UPDATE_CONFIRM_TITLE);

  let release: () => void = () => {};
  host.hold = new Promise((resolve) => {
    release = resolve;
  });
  const action = { type: "button", action_id: HOME_UPDATE_ACTION, value: "0.3.1" };
  await world.dispatch(homeAction(action));
  await world.homeClock.advance(3);
  await world.idle();
  const installing = JSON.stringify(pages().at(-1));
  assert.ok(installing.includes(fill(texts.UPDATE_INSTALLING, { latest: "0.3.1" })));
  assert.ok(!installing.includes(HOME_UPDATE_ACTION), "no button while it installs");

  release();
  await world.settle();
  await world.homeClock.advance(3);
  await world.idle();
  assert.ok(
    JSON.stringify(pages().at(-1)).includes(fill(texts.UPDATE_INSTALLED, { latest: "0.3.1" })),
  );
  assert.equal(host.calls.includes("restart"), true);
});

test("a failed install from the Home tab leaves the sentence and the button again", async (t) => {
  const { world, host, updates } = updatingWorld(t);
  host.outcome = { kind: "failed", failure: { kind: "network" } };
  updates.onChange = () => world.home.request();
  await updates.check();
  await world.dispatch(
    homeAction({ type: "button", action_id: HOME_UPDATE_ACTION, value: "0.3.1" }),
  );
  await world.homeClock.advance(3);
  await world.idle();
  const page = world.slack.callsTo("views.publish").at(-1)?.view as Body;
  const line = page.blocks.find((b: Body) => b.accessory?.action_id === HOME_UPDATE_ACTION);
  assert.equal(line?.text.text, fill(texts.UPDATE_FAILED_NETWORK, { installed: "0.3.0" }));
  assert.equal(host.calls.includes("restart"), false);
});
