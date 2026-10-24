/** How a task's ends are written into a reply: each subagent's card under its own end line. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TurnRenderer } from "../../../src/core/reply/renderer.ts";
import { type EndLine, writeEnds } from "../../../src/core/sessions/session.ts";

function recorder(): [TurnRenderer, string[]] {
  const written: string[] = [];
  const renderer = {
    feedLine: async (text: string) => {
      written.push(`line ${text}`);
    },
    feedCard: async (_id: string, title: string, body: string) => {
      written.push(`card ${title}: ${body}`);
    },
  } as unknown as TurnRenderer;
  return [renderer, written];
}

test("two subagents that end together each have their card under their own line", async () => {
  const [renderer, written] = recorder();
  const ends: EndLine[] = [
    { text: '✓ Agent "a" finished', card: { id: "message-1", title: "Message from a", body: "A" } },
    { text: '✓ Agent "b" finished', card: { id: "message-2", title: "Message from b", body: "B" } },
    { text: '✓ Background command "c" completed (exit code 0)', card: null },
  ];
  await writeEnds(renderer, ends, async (text) => {
    written.push(`opening ${text}`);
  });
  assert.deepEqual(written, [
    'opening ✓ Agent "a" finished',
    "card Message from a: A",
    'line ✓ Agent "b" finished',
    "card Message from b: B",
    'line ✓ Background command "c" completed (exit code 0)',
  ]);
});

test("ends with no card are one text, as before", async () => {
  const [renderer, written] = recorder();
  await writeEnds(
    renderer,
    [
      { text: "one", card: null },
      { text: "two", card: null },
    ],
    async (text) => {
      written.push(`opening ${text}`);
    },
  );
  assert.deepEqual(written, ["opening one\ntwo"]);
});
