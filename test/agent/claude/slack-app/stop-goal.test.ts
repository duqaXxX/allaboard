/**
 * `!stop` on a goal, through the word's flow and the Slack provider: the stop ends the turn, not
 * the goal, which the next message resumes (measured 2026-10-20), so the answer says
 * the goal is still set. The condition is the owner's own text, escaped for the notice.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { STOP_TAIL_WAIT } from "../../../../src/core/sessions/constants.ts";
import * as texts from "../../../../src/core/texts.ts";
import { THREAD } from "../../../support/fake-slack.ts";
import { event, isResult, sdkMessages } from "../../../support/sessions.ts";
import { message, reply, worldOf } from "../../../support/slack-app.ts";

test("a stop on a goal says it is still set, the owner's words escaped", async (t) => {
  const world = worldOf(t);
  await world.dispatch(message("!goal the build passes, then tell <!here>", { ts: THREAD }));
  const client = world.clients[0];
  assert.ok(client !== undefined);
  const condition = "the build passes, then tell <!here>";
  const items = sdkMessages("interrupt");
  const result = items.findIndex(isResult);
  client.answer([
    event({ type: "goal_changed", goal: { state: "set", condition } }),
    ...items.slice(0, result),
  ]);
  await world.until(() => world.slack.streamTs.length > 0);
  await world.dispatch(reply("!stop", THREAD));
  client.inject(items.slice(result));
  await world.clock.advance(STOP_TAIL_WAIT);
  const said = () =>
    world.slack
      .callsTo("chat.postMessage")
      .map((post) => String((post as { text?: string }).text ?? ""))
      .find((text) => text.startsWith(texts.STOPPED_THREAD));
  await world.until(() => said() !== undefined);
  assert.equal(
    said(),
    `${texts.STOPPED_THREAD}\n◎ Goal still active: the build passes, then tell &lt;!here&gt; · \`!goal clear\` drops it`,
  );
});
