/**
 * A background subagent's message while it runs (#135, recordings `subagent-message-bypass` and
 * `subagent-message-auto`, SDK 0.3.316): a line in the reply the message's turn opens, with no
 * post of its own and no mention that notifies. The subagent's hand-back draws none.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { harnessFor, type Item, sdkMessages, splitTurns } from "../../../support/sessions.ts";

const ZERO_WIDTH = "​";

/** The recording's turns with the mid-run message's body made `body`. */
function turns(name: string, body: string): Item[][] {
  return splitTurns(sdkMessages(name)).map((turn) =>
    turn.map((item): Item => {
      if (!("record" in item)) return item;
      const origin = item.record.origin;
      if (typeof origin !== "object" || origin === null || Array.isArray(origin)) return item;
      if (origin.body !== "halfway there") return item;
      return { record: { ...item.record, origin: { ...origin, body } } };
    }),
  );
}

function written(h: ReturnType<ReturnType<typeof harnessFor>>): string {
  return JSON.stringify(h.slack.apiCalls);
}

for (const mode of ["bypass", "auto"]) {
  test(`${mode}: the message is a line of the reply it opens, without a post of its own`, async (t) => {
    const [first, message] = turns(`subagent-message-${mode}`, "halfway there") as [Item[], Item[]];
    const h = harnessFor(t)({ turns: [first] });
    const session = h.session();
    await (await session.submit("go")).done.wait();
    const posted = h.slack.callsTo("chat.postMessage").length;
    h.clients[0]?.inject(message);
    // The turn answers under the task, in the reply that started it: no stream of its own.
    await h.until(() => written(h).includes("Message from"));
    assert.ok(written(h).includes("Message from general-purpose:\\n> halfway there"), written(h));
    assert.equal(h.slack.callsTo("chat.postMessage").length, posted);
    assert.equal(h.slack.callsTo("chat.startStream").length, 1);
  });
}

test("a mention in a subagent's message notifies nobody", async (t) => {
  const [first, message] = turns("subagent-message-bypass", "<!here> look at this") as [
    Item[],
    Item[],
  ];
  const h = harnessFor(t)({ turns: [first] });
  const session = h.session();
  await (await session.submit("go")).done.wait();
  h.clients[0]?.inject(message);
  await h.until(() => written(h).includes("Message from"));
  assert.ok(written(h).includes(`> <${ZERO_WIDTH}!here> look at this`), written(h));
  assert.ok(!written(h).includes("<!here>"));
});
