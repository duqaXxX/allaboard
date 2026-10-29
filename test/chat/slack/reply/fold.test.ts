/**
 * Slack's run of calls as one card, over the vocabulary of an agent that is not Claude: the plain
 * agent names its tools `run` and `change` and declares the words of a finished run
 * (`test/support/plain-agent.ts`). The same fold over Claude's words is in
 * `test/agent/claude/reply/fold.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskUpdate } from "../../../../src/chat/seam.ts";
import { Fold } from "../../../../src/chat/slack/reply/fold.ts";
import { Previews } from "../../../../src/core/reply/previews.ts";
import { PLAIN_TOOLS } from "../../../support/plain-agent.ts";

const PLAIN = new Previews(PLAIN_TOOLS);

function update(id: string, name: string, status: TaskUpdate["status"]): TaskUpdate {
  return {
    id,
    title: `${name}: ${id}`,
    status,
    details: null,
    output: null,
    name,
    task: false,
    message: false,
    calls: 0,
    preview: null,
    folded: null,
    startedAt: null,
  };
}

test("finished calls of a tool fold into the words the agent declares, one and many", () => {
  const fold = new Fold(PLAIN);
  fold.task(update("a", "run", "in_progress"));
  const [one] = fold.task(update("a", "run", "complete"));
  assert.equal(one?.title, "Executed 1 job");
  fold.task(update("b", "run", "in_progress"));
  const [two] = fold.task(update("b", "run", "complete"));
  assert.equal(two?.title, "Executed 2 jobs");
});

test("a call of a tool the vocabulary does not name folds under its own name", () => {
  const [card] = new Fold(PLAIN).task(update("a", "Bash", "complete"));
  assert.equal(card?.title, "Bash");
});
