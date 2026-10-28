/**
 * Another of the owner's sessions writes to this one (#30): the agent answers in a turn it opens
 * by itself, and the reply of that turn starts with the message, as the recording
 * `peer-message.jsonl` gives it (SDK 0.3.312). Its mentions notify nobody.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as texts from "../../../src/core/texts.ts";
import { harnessFor, type Item, sdkMessages, splitTurns } from "../../support/sessions.ts";

const ZERO_WIDTH = "​";

/** The recording's two turns, the peer's body in the second made `body`. */
function turns(body: string): [first: Item[], peer: Item[]] {
  const [first, peer] = splitTurns(sdkMessages("peer-message")) as [Item[], Item[]];
  const changed = peer.map((item): Item => {
    if (!("record" in item)) return item;
    const origin = item.record.origin;
    if (typeof origin !== "object" || origin === null || Array.isArray(origin)) return item;
    return { record: { ...item.record, origin: { ...origin, body } } };
  });
  return [first, changed];
}

/** Every text the fake Slack was given, joined. */
function written(h: ReturnType<ReturnType<typeof harnessFor>>): string {
  return JSON.stringify(h.slack.apiCalls);
}

test("a message from another session opens the reply of the turn it starts", async (t) => {
  const [first, peer] = turns("Run the tests\nthen report");
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("hello")).done.wait();
  const posted = h.slack.callsTo("chat.postMessage").length;
  h.clients[0]?.inject(peer);
  await h.until(() => session.idle && h.slack.callsTo("chat.startStream").length === 2);
  await h.idle();
  const line = texts.fill(texts.PEER_MESSAGE, { text: "Run the tests\nthen report" });
  assert.ok(written(h).includes(JSON.stringify(line).slice(1, -1)), written(h));
  // the line rides on the turn's reply: no message of its own
  assert.equal(h.slack.callsTo("chat.postMessage").length, posted);
});

test("a mention in another session's message notifies nobody", async (t) => {
  const [first, peer] = turns("<!here> look at this");
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("hello")).done.wait();
  h.clients[0]?.inject(peer);
  await h.until(() => session.idle && h.slack.callsTo("chat.startStream").length === 2);
  await h.idle();
  assert.ok(written(h).includes(`<${ZERO_WIDTH}!here> look at this`), written(h));
  assert.ok(!written(h).includes("<!here>"));
});

test("a message folded into the owner's running turn shows at its place in that reply", async (t) => {
  // Recorded on SDK 0.3.312 (`peer-message-in-turn.jsonl`): sent while a command ran, replayed
  // after the command's result, answered in the same turn.
  const h = harnessFor(t)({ turns: [sdkMessages("peer-message-in-turn")] });
  const session = h.session();
  await (await session.submit("run it")).done.wait();
  await h.idle();
  const all = written(h);
  const line = all.indexOf("📨 From another session:");
  assert.ok(line > 0, all);
  assert.ok(all.indexOf("time.sleep(40)") < line, "after the command's card");
  assert.ok(line < all.lastIndexOf("HERON"), "before the turn's answer");
  assert.equal(h.slack.callsTo("chat.startStream").length, 1, "one reply");
});
