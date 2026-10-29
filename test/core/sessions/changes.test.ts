import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileChange } from "../../../src/agent/seam.ts";
import { TURN_CHANGES_KEPT, TurnChanges } from "../../../src/core/sessions/changes.ts";

const change = (path: string): FileChange => ({
  path,
  kind: "edited",
  hunks: [{ oldStart: 1, newStart: 1, lines: ["+x"] }],
  content: null,
});

test("edits are kept per turn, in order, with the turn's place among the prompts", () => {
  const turns = new TurnChanges();
  turns.begin("p1");
  turns.begin("p2");
  turns.note(change("a"));
  turns.note(change("b"));
  assert.deepEqual(turns.list(), [{ id: "p2", number: 2, changes: [change("a"), change("b")] }]);
});

test("an edit with no prompt before it belongs to no turn", () => {
  const turns = new TurnChanges();
  turns.note(change("a"));
  assert.deepEqual(turns.list(), []);
});

test("an edit of a turn the agent starts itself goes to the prompt before it", () => {
  const turns = new TurnChanges();
  turns.begin("p1");
  turns.note(change("a"));
  // A report turn begins no prompt: its edit lands on the last one.
  turns.note(change("b"));
  assert.deepEqual(turns.list()[0]?.changes, [change("a"), change("b")]);
});

test("only the newest turns with edits are kept", () => {
  const turns = new TurnChanges();
  for (let i = 1; i <= TURN_CHANGES_KEPT + 3; i += 1) {
    turns.begin(`p${i}`);
    turns.note(change("a"));
  }
  const kept = turns.list();
  assert.equal(kept.length, TURN_CHANGES_KEPT);
  assert.equal(kept[0]?.id, "p4");
  assert.equal(kept.at(-1)?.number, TURN_CHANGES_KEPT + 3);
});

test("the place of a turn is forgotten with its edits, and a turn with none keeps none", () => {
  const turns = new TurnChanges();
  for (let i = 1; i <= TURN_CHANGES_KEPT * 3; i += 1) turns.begin(`p${i}`);
  assert.ok(turns.tracked <= 1, "only the running turn");
  for (let i = 1; i <= TURN_CHANGES_KEPT + 5; i += 1) {
    turns.begin(`e${i}`);
    turns.note(change("a"));
  }
  assert.ok(turns.tracked <= TURN_CHANGES_KEPT + 1, String(turns.tracked));
});

test("forgetting turns by their prompts drops them, and the edits that follow are nobody's", () => {
  const changes = new TurnChanges();
  changes.begin("t1");
  changes.note(change("a"));
  changes.begin("t2");
  changes.note(change("b"));
  changes.begin("t3");
  changes.note(change("c"));
  changes.forgetIds(["t2", "t3"]);
  assert.deepEqual(
    changes.list().map((turn) => turn.id),
    ["t1"],
  );
  changes.note(change("d"));
  assert.deepEqual(
    changes.list().map((turn) => turn.changes.length),
    [1],
  );
});
