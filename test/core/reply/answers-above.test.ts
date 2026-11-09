/**
 * An end note that says the reply answers messages above it reaches the sink flagged
 * (`answers`, #185): a chat ends the reply below the owner's message with it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Previews } from "../../../src/core/reply/previews.ts";
import { type Sink, TurnRenderer } from "../../../src/core/reply/renderer.ts";
import { MEMORY_NAMES } from "../../support/names.ts";
import { PLAIN_TOOLS } from "../../support/plain-agent.ts";

async function ids(answers: string[] | null): Promise<(readonly string[] | undefined)[]> {
  const out: (readonly string[] | undefined)[] = [];
  const sink: Sink = {
    text: async (_value, options) => {
      out.push(options?.answers);
    },
    task: async () => undefined,
    finish: async () => undefined,
    closeOut: async () => true,
    waitLanded: async () => true,
    settle: async () => true,
  };
  const renderer = new TurnRenderer(sink, MEMORY_NAMES, new Previews(PLAIN_TOOLS));
  await renderer.feedError("a note", answers === null ? {} : { answers });
  await renderer.close();
  return out;
}

test("an end note that names the messages it answers reaches the sink with their ids", async () => {
  assert.deepEqual(await ids(["m-1", "m-2"]), [["m-1", "m-2"]]);
});

test("an end note with no ids reaches the sink with none", async () => {
  assert.deepEqual(await ids(null), [undefined]);
});
