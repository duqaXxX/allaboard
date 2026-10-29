/**
 * The reply's tool cards drawn from the vocabulary of an agent that is not Claude: the plain
 * agent names its tools `run` and `change` and declares what the terminal would say of them.
 * What the same code does with Claude's recorded streams is in `test/agent/claude/reply/`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent } from "../../../src/agent/seam.ts";
import type { TaskUpdate } from "../../../src/chat/seam.ts";
import { Fold } from "../../../src/core/reply/fold.ts";
import { Previews } from "../../../src/core/reply/previews.ts";
import { type Sink, TurnRenderer } from "../../../src/core/reply/renderer.ts";
import { PLAIN_NAMES } from "../../support/names.ts";
import { call, PLAIN_TOOLS, PlainAgent, say } from "../../support/plain-agent.ts";

const PREVIEWS = new Previews(PLAIN_TOOLS);

/** The cards the renderer drew for one scripted turn of the plain agent. */
async function cardsOf(...steps: Parameters<PlainAgent["next"]>): Promise<TaskUpdate[]> {
  const agent = new PlainAgent().next(...steps);
  const session = await agent.start(
    { folder: "/work", resume: null, model: null, effort: null },
    {
      permission: async () => ({ allow: true }),
      question: async () => ({ answered: false, message: "skipped" }),
    },
  );
  const cards: TaskUpdate[] = [];
  const sink: Sink = {
    text: async () => undefined,
    task: async (update) => {
      cards.push(update);
    },
    finish: async () => undefined,
    closeOut: async () => true,
    waitLanded: async () => true,
    settle: async () => true,
  };
  const renderer = new TurnRenderer(sink, PLAIN_NAMES, PREVIEWS);
  await session.send({ id: "00000000-0000-4000-8000-000000000001", content: "go" });
  for await (const event of session.events as AsyncIterable<SessionEvent>) {
    await renderer.feed(event);
    if (event.type === "turn_ended") break;
  }
  await renderer.close();
  await renderer.closeOut();
  await session.close();
  return cards;
}

test("a call is titled by the input its tool declares to describe it", async () => {
  const cards = await cardsOf(call("run", { command: "ls", summary: "List the folder" }));
  assert.deepEqual(
    cards.map((card) => [card.status, card.title]),
    [
      ["in_progress", "List the folder"],
      ["complete", "List the folder"],
    ],
  );
});

test("a call of a tool with no description input is titled by its name and command", async () => {
  const [first] = await cardsOf(call("run", { command: "pwd" }));
  assert.equal(first?.title, "run: pwd");
});

test("a finished edit of a file previews as the tool's declared title", async () => {
  const cards = await cardsOf(
    call(
      "change",
      { path: "a.txt" },
      {
        fileChange: {
          path: "a.txt",
          kind: "edited",
          hunks: [{ oldStart: 1, newStart: 1, lines: ["-a", "+b"] }],
          content: null,
        },
      },
    ),
  );
  assert.equal(cards.at(-1)?.preview?.title, "Modify(a.txt)");
  assert.equal(cards.at(-1)?.preview?.summary, "Added 1 line, removed 1 line");
  assert.equal(cards.at(-1)?.preview?.language, "diff");
});

test("a failed call ends its card in error", async () => {
  const cards = await cardsOf(say("Trying."), call("run", { command: "false" }, { isError: true }));
  assert.equal(cards.at(-1)?.status, "error");
});

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
  const fold = new Fold(PREVIEWS);
  fold.task(update("a", "run", "in_progress"));
  const [one] = fold.task(update("a", "run", "complete"));
  assert.equal(one?.title, "Executed 1 job");
  fold.task(update("b", "run", "in_progress"));
  const [two] = fold.task(update("b", "run", "complete"));
  assert.equal(two?.title, "Executed 2 jobs");
});
