/**
 * The plain agent's own behaviour: what it declares, and how a test scripts it. The seam's
 * promises are checked against it in `test/conformance/agent.test.ts`; here, only what is the
 * plain agent's to say.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type {
  AgentSession,
  PermissionAnswer,
  Prompt,
  QuestionAnswer,
  RequestHandler,
  SessionEvent,
  StartOptions,
} from "../../src/agent/seam.ts";
import { ResumeRefused, RewindRefused } from "../../src/agent/seam.ts";
import {
  call,
  die,
  effort,
  modelSwitched,
  PLAIN_CAPABILITIES,
  PLAIN_COMMANDS,
  PLAIN_MODE,
  PlainAgent,
  type PlainSession,
  PlainSessionClosed,
  PlainStore,
  say,
  whole,
} from "./plain-agent.ts";

const LIMIT = { timeout: 5_000 };
const FOLDER = "/srv/alice/app";
const START: StartOptions = {
  folder: FOLDER,
  resume: null,
  model: null,
  effort: null,
};
let counter = 0;

function prompt(content: string): Prompt {
  counter += 1;
  return { id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`, content };
}

function handler(
  permission: PermissionAnswer = { allow: true },
  asked: QuestionAnswer = { answered: false, message: "skipped" },
): RequestHandler {
  return { permission: async () => permission, question: async () => asked };
}

/** The events of the next turn, up to its `turn_ended`. */
async function turnOf(
  iterator: AsyncIterator<SessionEvent>,
  type: SessionEvent["type"] = "turn_ended",
): Promise<SessionEvent[]> {
  const seen: SessionEvent[] = [];
  for (;;) {
    const next = await iterator.next();
    assert.equal(next.done, false, "the events ended early");
    if (next.done) return seen;
    seen.push(next.value);
    if (next.value.type === type) return seen;
  }
}

async function started(agent: PlainAgent, requests = handler()) {
  const session = (await agent.start(START, requests)) as PlainSession;
  return { session, events: session.events[Symbol.asyncIterator]() };
}

function types(events: readonly SessionEvent[]): string[] {
  return events.map((event) => event.type);
}

test("the plain agent declares what the plan's table lists", () => {
  const agent = new PlainAgent();
  assert.deepEqual(agent.capabilities, PLAIN_CAPABILITIES);
  assert.equal(agent.capabilities.effortLevels.length, 2);
  assert.equal(agent.capabilities.liveEffort, false);
  assert.deepEqual(agent.capabilities.permissionModes, {
    default: PLAIN_MODE,
    auto: null,
    bypass: null,
    plan: null,
  });
  const lacks = ["subagents", "backgroundTasks", "compaction", "usageLimits", "models"] as const;
  for (const capability of [
    ...lacks,
    "promptDuringTurn",
    "folderTrust",
    "declaredState",
    "sessionTags",
    "sessionTitles",
    "goals",
  ] as const) {
    assert.equal(agent.capabilities[capability], false, capability);
  }
  for (const capability of ["questions", "commands", "sessionListing", "sessionForks"] as const) {
    assert.equal(agent.capabilities[capability], true, capability);
  }
  assert.equal("usageLimits" in agent, false);
  assert.equal("tagSession" in agent, false);
  assert.equal("sessionTitle" in agent, false);
  assert.equal(PLAIN_COMMANDS.length, 2);
  assert.ok(!/claude|anthropic/i.test(`${agent.name} ${JSON.stringify(agent.words)}`));
});

test("the plain agent imports the seam and nothing else of the daemon", () => {
  const source = readFileSync(new URL("./plain-agent.ts", import.meta.url), "utf8");
  const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(imports)], ["../../src/agent/seam.ts"]);
});

test(
  "a turn per prompt, in the order scripted, and a plain ok past the script",
  LIMIT,
  async () => {
    const agent = new PlainAgent().next(say("One.")).next(whole("Two."));
    const { session, events } = await started(agent);
    const texts: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      await session.send(prompt("go"));
      const turn = await turnOf(events);
      texts.push(
        turn
          .flatMap((e) => (e.type === "text_delta" || e.type === "text" ? [e.text] : []))
          .join(""),
      );
    }
    assert.deepEqual(texts, ["One.", "Two.", "ok"]);
    assert.equal(session.prompts.length, 3);
  },
);

test("the session is named with its first prompt, not before, as Claude's is", LIMIT, async () => {
  // The core takes a stored session id for a session that ran (`ThreadSession.neverRan`), and
  // resumes it when a setup needs a fresh client: an id announced earlier has no transcript.
  const agent = new PlainAgent().next(say("One."));
  const { session, events } = await started(agent);
  assert.equal(agent.store.has(FOLDER, session.id), false);
  const first = events.next();
  const early = await Promise.race([
    first.then(() => "an event"),
    new Promise<string>((resolve) => setImmediate(() => resolve("nothing"))),
  ]);
  assert.equal(early, "nothing");
  await session.send(prompt("go"));
  const named = await first;
  assert.ok(!named.done && named.value.type === "session_started");
  await turnOf(events);
  assert.equal(agent.store.has(FOLDER, session.id), true);
});

test("say writes deltas of one message, whole writes one text", LIMIT, async () => {
  const agent = new PlainAgent().next(say("Two words")).next(whole("  Whole.  "));
  const { session, events } = await started(agent);
  await session.send(prompt("a"));
  const first = await turnOf(events);
  assert.deepEqual(types(first), [
    "session_started",
    "message_started",
    "text_started",
    "text_delta",
    "text_delta",
    "message_ended",
    "effort_observed",
    "turn_ended",
  ]);
  await session.send(prompt("b"));
  const second = await turnOf(events);
  assert.deepEqual(
    second.filter((e) => e.type === "text").map((e) => e.type === "text" && e.text),
    ["Whole."],
  );
  const end = second.at(-1);
  assert.ok(end?.type === "turn_ended" && end.finalText === "Whole." && end.steps === 1);
});

test("a handler that throws is a denial", LIMIT, async () => {
  const agent = new PlainAgent().next(call("Shell", {}, { permission: true }));
  const throwing: RequestHandler = {
    permission: () => {
      throw new Error("down");
    },
    question: async () => ({ answered: false, message: "" }),
  };
  const { session, events } = await started(agent, throwing);
  await session.send(prompt("a"));
  const turn = await turnOf(events);
  assert.ok(turn.some((e) => e.type === "call_ended" && e.isError));
});

test("die loses the process: process_lost last, and a send is refused", LIMIT, async () => {
  const agent = new PlainAgent().next(say("Half"), die());
  const { session, events } = await started(agent);
  await session.send(prompt("a"));
  const seen = await turnOf(events, "process_lost");
  assert.equal(seen.at(-1)?.type, "process_lost");
  assert.deepEqual(await events.next(), { done: true, value: undefined });
  await assert.rejects(session.send(prompt("b")), PlainSessionClosed);
  await session.close();
  assert.equal(agent.running.length, 0);
});

test("a command runs without a turn of the script, by its name or its alias", LIMIT, async () => {
  const agent = new PlainAgent().next(say("Scripted."));
  const { session, events } = await started(agent);
  const outputs: string[] = [];
  for (const text of [":echo hi there", ":say again", ":count a b c", ":nope"]) {
    await session.send(prompt(text));
    const turn = await turnOf(events);
    outputs.push(turn.flatMap((e) => (e.type === "text" ? [e.text] : [])).join(""));
    const end = turn.at(-1);
    assert.ok(end?.type === "turn_ended" && end.steps === 0 && end.tokens !== undefined);
  }
  assert.deepEqual(outputs, ["hi there", "again", "3 words", "Unknown command: :nope"]);
  assert.equal(agent.turns.length, 1, "the scripted turn is still waiting");
});

test("an effort step says the level a command set, before the turn ends", LIMIT, async () => {
  const agent = new PlainAgent().next(effort("full"), whole("Done.")).next(effort(null));
  const { session, events } = await started(agent);
  for (const level of ["full", null]) {
    await session.send(prompt("go"));
    const turn = await turnOf(events);
    const changed = turn.findIndex((e) => e.type === "effort_changed");
    assert.deepEqual(turn[changed], { type: "effort_changed", level });
    assert.ok(changed < turn.findIndex((e) => e.type === "turn_ended"));
  }
});

test("a model step says the model a command switched to, before the turn ends", LIMIT, async () => {
  const agent = new PlainAgent().next(modelSwitched("plain-large"));
  const { session, events } = await started(agent);
  await session.send(prompt("go"));
  const turn = await turnOf(events);
  const changed = turn.findIndex((e) => e.type === "model_changed");
  assert.deepEqual(turn[changed], { type: "model_changed", model: "plain-large" });
  assert.ok(changed < turn.findIndex((e) => e.type === "turn_ended"));
});

test("the store outlives the agent: a new agent resumes, lists and refuses", LIMIT, async () => {
  const store = new PlainStore();
  const first = new PlainAgent({ store });
  const { session, events } = await started(first);
  await session.send(prompt("Name this one"));
  await turnOf(events);
  await session.close();
  const again = new PlainAgent({ store });
  const [listed] = await again.listSessions(FOLDER);
  assert.deepEqual(
    { id: listed?.id, title: listed?.title },
    { id: session.id, title: "Name this one" },
  );
  assert.deepEqual(await again.aliveSessions(FOLDER), new Set([session.id]));
  assert.deepEqual(await again.listSessions("/srv/alice/other"), []);
  const resumed = await again.start({ ...START, resume: session.id }, handler());
  assert.equal((resumed as PlainSession).id, session.id);
  await resumed.close();
  await assert.rejects(
    again.start({ ...START, resume: "plain-session-99" }, handler()),
    ResumeRefused,
  );
  await assert.rejects(
    again.start({ ...START, folder: "/srv/alice/other", resume: session.id }, handler()),
    ResumeRefused,
  );
});

test(
  "close ends a turn that waits on the owner, and a second close is harmless",
  LIMIT,
  async () => {
    const agent = new PlainAgent().next(call("Shell", {}, { permission: true }));
    const pending: RequestHandler = {
      permission: () => new Promise<PermissionAnswer>(() => undefined),
      question: async () => ({ answered: false, message: "" }),
    };
    const { session, events } = await started(agent, pending);
    await session.send(prompt("a"));
    await turnOf(events, "call_started");
    await session.close();
    await session.close();
    assert.deepEqual(await events.next(), { done: true, value: undefined });
  },
);

test("what a live session cannot do, it refuses", LIMIT, async () => {
  const { session } = (await started(new PlainAgent())) as { session: AgentSession };
  assert.equal(session.setEffort, undefined);
  assert.equal(session.stopTask, undefined);
  await assert.rejects(session.setModel("some-model"));
  await session.setModel(null);
  await session.setPermissionMode(PLAIN_MODE);
  await assert.rejects(session.setPermissionMode("auto"), RangeError);
  const info = await session.info();
  assert.deepEqual([info.models, info.commands.length, info.permissionMode], [[], 2, PLAIN_MODE]);
  await session.close();
});

// Going back: the plain agent keeps the prompts of a session and the files at each of them.

test("without the option the plain agent offers no way back", LIMIT, async () => {
  const agent = new PlainAgent();
  assert.deepEqual(
    [agent.capabilities.fileRestore, agent.capabilities.conversationRewind],
    [false, false],
  );
  assert.equal(agent.prompts, undefined);
  const { session } = await started(agent);
  assert.equal(session.restoreFiles, undefined);
  await session.close();
});

test("the prompts come oldest first and leave out the agent's own commands", LIMIT, async () => {
  const agent = new PlainAgent({ rewind: { files: true, conversation: true } });
  const { session } = await started(agent);
  const [one, two, three] = [prompt("first"), prompt(":echo hi"), prompt("second")];
  for (const sent of [one, two, three]) await session.send(sent);
  await session.close();
  assert.deepEqual(await agent.prompts?.(FOLDER, session.id), [
    { id: one.id, text: "first", conversation: true },
    { id: three.id, text: "second", conversation: true },
  ]);
});

test("a preview changes nothing and a restore goes back and forward", LIMIT, async () => {
  const store = new PlainStore();
  const agent = new PlainAgent({ store, rewind: { files: true } });
  const { session } = await started(agent);
  const [one, two] = [prompt("one"), prompt("two")];
  store.writeFile(FOLDER, "a.txt", "alpha");
  await session.send(one);
  store.writeFile(FOLDER, "a.txt", "beta");
  store.writeFile(FOLDER, "b.txt", "new");
  await session.send(two);
  store.writeFile(FOLDER, "a.txt", "gamma");

  const restore = session.restoreFiles;
  assert.ok(restore !== undefined);
  const dry = await restore(one.id, true);
  assert.deepEqual(
    [dry.possible, dry.files, store.file(FOLDER, "a.txt"), store.file(FOLDER, "b.txt")],
    [true, ["a.txt", "b.txt"], "gamma", "new"],
  );
  assert.deepEqual([dry.insertions, dry.deletions], [1, 2]);

  await restore(one.id, false);
  assert.deepEqual([store.file(FOLDER, "a.txt"), store.file(FOLDER, "b.txt")], ["alpha", null]);
  // Forward: the checkpoint of the later prompt is still there, taken as that prompt was sent.
  await restore(two.id, false);
  assert.deepEqual([store.file(FOLDER, "a.txt"), store.file(FOLDER, "b.txt")], ["beta", "new"]);
  assert.equal((await restore("nothing", true)).possible, false);
  await session.close();
});

test("a rewind keeps the session id and holds only once a prompt is sent", LIMIT, async () => {
  const store = new PlainStore();
  const agent = new PlainAgent({ store, rewind: { conversation: true } });
  const { session } = await started(agent);
  const [one, two] = [prompt("one"), prompt("two")];
  await session.send(one);
  await session.send(two);
  await session.close();

  const cut = (await agent.start(
    { ...START, resume: session.id, rewindTo: two.id },
    handler(),
  )) as PlainSession;
  assert.equal(cut.id, session.id);
  // Nothing written yet: a plain resume sees the whole conversation.
  assert.equal((await agent.prompts?.(FOLDER, session.id))?.length, 2);
  const again = prompt("three");
  await cut.send(again);
  assert.deepEqual(await agent.prompts?.(FOLDER, session.id), [
    { id: one.id, text: "one", conversation: true },
    { id: again.id, text: "three", conversation: true },
  ]);
  await cut.close();
});

test("a refused rewind leaves a session that starts plainly", LIMIT, async () => {
  const store = new PlainStore();
  const agent = new PlainAgent({ store, rewind: { conversation: true, refuse: true } });
  const { session } = await started(agent);
  const sent = prompt("one");
  await session.send(sent);
  await session.close();
  await assert.rejects(
    agent.start({ ...START, resume: session.id, rewindTo: sent.id }, handler()),
    RewindRefused,
  );
  const plain = await agent.start({ ...START, resume: session.id }, handler());
  assert.ok(plain);
  assert.equal((await agent.prompts?.(FOLDER, session.id))?.length, 1);
  await plain.close();
});
