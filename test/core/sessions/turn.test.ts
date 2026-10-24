/** The note about turns that never ran, for prompts and for the owner's shell commands. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Reply } from "../../../src/chat/seam.ts";
import { notSent, Turn } from "../../../src/core/sessions/turn.ts";
import * as texts from "../../../src/core/texts.ts";

const SINK = {} as Reply; // never written: the note is built from the turns alone

test("a shell command is quoted as typed, and with how it ended once it ran", () => {
  const queued = new Turn("!!make test", SINK, "make test");
  const ran = new Turn("!!git push", SINK, "git push");
  // What the agent would have been sent replaces the prompt once the command has run.
  ran.prompt = [{ type: "text", text: "<bash-input>git push</bash-input>" }];
  ran.head = "✗ exit 1 · 0.4 s\n```\n$ git push\nrejected\n```";
  const note = notSent([new Turn("hello", SINK), queued, ran], texts.BECAUSE_RESTARTED);
  assert.deepEqual(note.split("\n").slice(1), [
    '- "hello"',
    '- "!!make test"',
    '- "!!git push" (✗ exit 1 · 0.4 s)',
  ]);
});
