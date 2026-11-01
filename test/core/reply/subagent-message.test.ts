/**
 * A background subagent's message, drawn as a line of the reply already open (#135, owner's
 * decision 2026-11-01). The event is the seam's, so no agent module is involved.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Previews } from "../../../src/core/reply/previews.ts";
import { type Sink, TurnRenderer } from "../../../src/core/reply/renderer.ts";
import { MEMORY_NAMES } from "../../support/names.ts";
import { PLAIN_TOOLS } from "../../support/plain-agent.ts";

/** The texts and options the renderer wrote for a subagent's message. */
async function written(from: string, text: string): Promise<{ text: string; notice?: boolean }[]> {
  const out: { text: string; notice?: boolean }[] = [];
  const sink: Sink = {
    text: async (value, options) => {
      out.push({ text: value, notice: options?.notice });
    },
    task: async () => undefined,
    finish: async () => undefined,
    closeOut: async () => true,
    waitLanded: async () => true,
    settle: async () => true,
  };
  const renderer = new TurnRenderer(sink, MEMORY_NAMES, new Previews(PLAIN_TOOLS));
  await renderer.feed({ type: "subagent_message", from, text });
  await renderer.close();
  return out;
}

test("a subagent's message is a line naming its sender, then the text quoted", async () => {
  const out = await written("general-purpose", "halfway there");
  assert.deepEqual(
    out.map((one) => one.text),
    ["Message from general-purpose:\n> halfway there"],
  );
});

test("the line is text of the open reply: one write, flagged as a notice, no card", async () => {
  const out = await written("general-purpose", "halfway there");
  assert.equal(out.length, 1);
  assert.equal(out[0]?.notice, true);
});
