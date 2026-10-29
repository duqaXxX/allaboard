/**
 * Going back in a Claude Code session: the prompts of `getSessionMessages`, the point a
 * truncating resume starts at, the files a restore changes, and the refusal of a resume that
 * drops a turn. Fixtures recorded on Claude Code 2.1.312 with SDK 0.3.312 on 2026-10-29
 * (`session-messages-rewind.json`, `rewind-files.json`, `resume-drops-turn-refused.jsonl`), with
 * the daemon's options.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { RewindFilesResult, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeBackend } from "../../../src/agent/claude/backend.ts";
import { filesRestore, rewindPoints, rewindStart } from "../../../src/agent/claude/rewind.ts";
import { ClaudeSession, type SessionConfig } from "../../../src/agent/claude/session.ts";
import type { RequestHandler } from "../../../src/agent/seam.ts";
import { ResumeRefused, RewindRefused } from "../../../src/agent/seam.ts";
import { FakeSdk, fail } from "../../support/fake-query.ts";
import { type JsonObject, sdkJson, sdkRecords } from "../../support/fixtures.ts";

const LIMIT = { timeout: 10_000 };
const MESSAGES = sdkJson("session-messages-rewind") as unknown as SessionMessage[];
const FILES = sdkJson("rewind-files") as {
  session: string;
  prompts: Record<"P1" | "P2" | "P3", string>;
  results: Record<string, RewindFilesResult>;
};
const { P1, P2, P3 } = FILES.prompts;
const FOLDER = "/srv/alice/app";
// A home with Claude Code's record, empty: the back end reads the Chrome setting from it.
const HOME = mkdtempSync(join(tmpdir(), "allaboard-rewind-"));
writeFileSync(join(HOME, ".claude.json"), "{}");
after(() => rmSync(HOME, { recursive: true, force: true }));
const NO_REQUESTS: RequestHandler = {
  permission: async () => ({ allow: true }),
  question: async () => ({ answered: false, message: "" }),
};
const CONFIG: SessionConfig = {
  folder: FOLDER,
  resume: FILES.session,
  settingsSources: ["user", "project", "local"],
  model: null,
  effort: null,
  chrome: false,
};

/** A user entry the way `getSessionMessages` returns it, for the cases the recording lacks. */
function user(uuid: string, content: unknown): SessionMessage {
  return {
    type: "user",
    uuid,
    session_id: FILES.session,
    message: { role: "user", content },
    parent_tool_use_id: null,
  } as SessionMessage;
}

const COMMAND =
  "<command-name>/model</command-name><command-message>model</command-message><command-args>haiku</command-args>";

test("the prompts of a conversation are the user entries the owner typed, oldest first", () => {
  const points = rewindPoints(MESSAGES);
  assert.deepEqual(
    points.map((point) => point.id),
    [P1, P2, P3],
  );
  assert.equal(points[0]?.text, "Using the Write tool, create a.txt containing exactly: one");
  // The recording holds 13 user entries; the others are the tool results of those turns.
  assert.equal(MESSAGES.filter((message) => message.type === "user").length, 13);
});

test("only the first prompt cannot have its conversation cut", () => {
  assert.deepEqual(
    rewindPoints(MESSAGES).map((point) => point.conversation),
    [false, true, true],
  );
});

test("a slash command is no prompt to go back to", () => {
  const messages = [...MESSAGES, user("c-1", COMMAND), user("p-4", "and now this")];
  assert.deepEqual(
    rewindPoints(messages).map((point) => point.id),
    [P1, P2, P3, "p-4"],
  );
});

test("a prompt that is not last drops everything after it with no guard", () => {
  const index = MESSAGES.findIndex((message) => message.uuid === P2);
  assert.deepEqual(rewindStart(MESSAGES, P2), { at: MESSAGES[index - 1]?.uuid });
});

test("the last prompt is dropped under the SDK's guard", () => {
  const index = MESSAGES.findIndex((message) => message.uuid === P3);
  assert.deepEqual(rewindStart(MESSAGES, P3), { at: MESSAGES[index - 1]?.uuid, drops: P3 });
});

test("a command after the last prompt keeps the cut unguarded", () => {
  const messages = [...MESSAGES, user("c-1", COMMAND)];
  assert.equal(rewindStart(messages, P3)?.drops, undefined);
});

test("the first prompt has no entry to resume at, and an unknown one is not a point", () => {
  assert.equal(rewindStart(MESSAGES, P1), null);
  assert.equal(rewindStart(MESSAGES, "not-a-prompt"), null);
  // A tool result carries a uuid too, and is no prompt.
  const toolResult = MESSAGES.find(
    (message) => message.type === "user" && ![P1, P2, P3].includes(message.uuid),
  );
  assert.ok(toolResult !== undefined);
  assert.equal(rewindStart(MESSAGES, toolResult.uuid), null);
});

test("a recorded dry run reads as the counts of the restore", () => {
  const dry = filesRestore(FILES.results["dry P2"] as RewindFilesResult);
  assert.equal(dry.possible, true);
  assert.equal(dry.reason, null);
  assert.deepEqual(dry.files, [
    "/private/work/project/a.txt",
    "/private/work/project/b.txt",
    "/private/work/project/tracked.txt",
  ]);
  assert.deepEqual([dry.insertions, dry.deletions, dry.skipped], [2, 3, 0]);
});

test("a real run has no file list and no counts, and a prompt with no checkpoint says why", () => {
  const real = filesRestore(FILES.results["real P2"] as RewindFilesResult);
  assert.deepEqual(
    [real.possible, real.files, real.insertions, real.deletions, real.skipped],
    [true, [], 0, 0, 0],
  );
  const unknown = filesRestore(FILES.results["dry unknown uuid"] as RewindFilesResult);
  assert.equal(unknown.possible, false);
  assert.equal(unknown.reason, "No file checkpoint found for this message.");
});

test("a session asks for file checkpoints, and a bare one does not", LIMIT, async () => {
  const sdk = new FakeSdk();
  const backend = new ClaudeBackend({ query: sdk.query, home: HOME });
  await (
    await backend.start({ folder: FOLDER, resume: null, model: null, effort: null }, NO_REQUESTS)
  ).close();
  await (await backend.startBare(FOLDER, NO_REQUESTS)).close();
  assert.equal(sdk.queries[0]?.options.enableFileCheckpointing, true);
  assert.equal("enableFileCheckpointing" in (sdk.queries[1]?.options ?? {}), false);
});

test("restoreFiles asks the SDK for a dry run or a real one at the prompt", LIMIT, async () => {
  const sdk = new FakeSdk({
    rewinds: {
      [`dry ${P2}`]: FILES.results["dry P2"] as RewindFilesResult,
      [`real ${P2}`]: FILES.results["real P2"] as RewindFilesResult,
    },
  });
  const session = new ClaudeSession(CONFIG, NO_REQUESTS, sdk.query);
  await session.ready();
  const dry = await session.restoreFiles(P2, true);
  assert.deepEqual(
    [dry.possible, dry.files.length, dry.insertions, dry.deletions],
    [true, 3, 2, 3],
  );
  const real = await session.restoreFiles(P2, false);
  assert.equal(real.possible, true);
  assert.deepEqual(
    sdk.only.calls.filter((call) => call.method === "rewindFiles"),
    [
      { method: "rewindFiles", id: P2, dryRun: true },
      { method: "rewindFiles", id: P2, dryRun: false },
    ],
  );
  await session.close();
});

test("a prompt with no checkpoint cannot be restored", LIMIT, async () => {
  const sdk = new FakeSdk();
  const session = new ClaudeSession(CONFIG, NO_REQUESTS, sdk.query);
  await session.ready();
  const restore = await session.restoreFiles("unknown", true);
  assert.equal(restore.possible, false);
  assert.match(restore.reason ?? "", /No file checkpoint/);
  await session.close();
});

test("prompts reads the conversation of the session in its folder", LIMIT, async () => {
  const asked: unknown[] = [];
  const backend = new ClaudeBackend({
    home: HOME,
    getSessionMessages: async (session, options) => {
      asked.push([session, options?.dir]);
      return MESSAGES;
    },
  });
  const points = await backend.prompts(FOLDER, FILES.session);
  assert.deepEqual(asked, [[FILES.session, FOLDER]]);
  assert.deepEqual(
    points.map((point) => point.id),
    [P1, P2, P3],
  );
});

function rewinding(): { backend: ClaudeBackend; sdk: FakeSdk } {
  const sdk = new FakeSdk();
  const backend = new ClaudeBackend({
    query: sdk.query,
    home: HOME,
    getSessionMessages: async () => MESSAGES,
  });
  return { backend, sdk };
}

test(
  "a start with rewindTo resumes the session at the entry before the prompt",
  LIMIT,
  async () => {
    const { backend, sdk } = rewinding();
    const start = { folder: FOLDER, resume: FILES.session, model: null, effort: null };
    await (await backend.start({ ...start, rewindTo: P2 }, NO_REQUESTS)).close();
    const before = MESSAGES[MESSAGES.findIndex((message) => message.uuid === P2) - 1]?.uuid;
    const options = sdk.only.options;
    assert.equal(options.resume, FILES.session);
    assert.equal(options.resumeSessionAt, before);
    // The session keeps its id: a copy would lose the checkpoints.
    assert.equal(options.forkSession, undefined);
    assert.equal(options.resumeDropsTurn, undefined);
  },
);

test("rewinding to the last prompt declares the turn it drops", LIMIT, async () => {
  const { backend, sdk } = rewinding();
  const start = { folder: FOLDER, resume: FILES.session, model: null, effort: null };
  await (await backend.start({ ...start, rewindTo: P3 }, NO_REQUESTS)).close();
  assert.equal(sdk.only.options.resumeDropsTurn, P3);
});

test("a start without rewindTo passes neither option", LIMIT, async () => {
  const { backend, sdk } = rewinding();
  const start = { folder: FOLDER, resume: FILES.session, model: null, effort: null };
  await (await backend.start(start, NO_REQUESTS)).close();
  assert.equal("resumeSessionAt" in sdk.only.options, false);
  assert.equal("resumeDropsTurn" in sdk.only.options, false);
});

test("a rewind to the first prompt is refused before any process starts", LIMIT, async () => {
  const { backend, sdk } = rewinding();
  const start = { folder: FOLDER, resume: FILES.session, model: null, effort: null };
  await assert.rejects(backend.start({ ...start, rewindTo: P1 }, NO_REQUESTS), RewindRefused);
  assert.equal(sdk.queries.length, 0);
});

test(
  "the recorded refusal of a dropped range is RewindRefused, not ResumeRefused",
  LIMIT,
  async () => {
    const records = sdkRecords("resume-drops-turn-refused");
    const result = records.find((record) => record.type === "result") as JsonObject;
    // The CLI's error result reaches `initializationResult()` as the SDK's error (recorded 2026-10-29).
    const refusal = String((result.errors as string[])[0]);
    const failure = new Error(`Claude Code returned an error result: ${refusal}`);
    const sdk = new FakeSdk({ initError: failure, start: [result, fail(failure)] });
    const session = new ClaudeSession(
      { ...CONFIG, resumeSessionAt: "x", resumeDropsTurn: P3 },
      NO_REQUESTS,
      sdk.query,
    );
    await assert.rejects(session.ready(), (error) => {
      assert.ok(error instanceof RewindRefused);
      assert.ok(!(error instanceof ResumeRefused));
      assert.equal(error.cause, failure);
      assert.match(refusal, /^Resume rejected by --resume-drops-turn:/);
      return true;
    });
    assert.equal(sdk.only.closed, true);
  },
);

test("a refused resume with no rewind stays ResumeRefused", LIMIT, async () => {
  const records = sdkRecords("resume-drops-turn-refused");
  const result = records.find((record) => record.type === "result") as JsonObject;
  const failure = new Error("Claude Code returned an error result: No conversation found");
  const sdk = new FakeSdk({ initError: failure, start: [result, fail(failure)] });
  const session = new ClaudeSession(CONFIG, NO_REQUESTS, sdk.query);
  await assert.rejects(session.ready(), ResumeRefused);
});

test("the cut resumes at the entry just before the prompt, a system entry included", () => {
  const index = MESSAGES.findIndex((message) => message.uuid === P2);
  const notice = { ...MESSAGES[index - 1], type: "system", uuid: "system-1" } as SessionMessage;
  const messages = [...MESSAGES.slice(0, index), notice, ...MESSAGES.slice(index)];
  assert.equal(rewindStart(messages, P2)?.at, "system-1");
});

test(
  "a start with rewindTo reads the system entries too, so that the kept turn's last entry is seen",
  LIMIT,
  async () => {
    const asked: unknown[] = [];
    const sdk = new FakeSdk();
    const backend = new ClaudeBackend({
      query: sdk.query,
      home: HOME,
      getSessionMessages: async (_session, options) => {
        asked.push(options?.includeSystemMessages);
        return MESSAGES;
      },
    });
    const start = { folder: FOLDER, resume: FILES.session, model: null, effort: null };
    await (await backend.start({ ...start, rewindTo: P2 }, NO_REQUESTS)).close();
    assert.deepEqual(asked, [true]);
  },
);

test(
  "a cut gives a token for the conversation, and asked again over a changed one it is refused",
  LIMIT,
  async () => {
    const { backend, sdk } = rewinding();
    const start = { folder: FOLDER, resume: FILES.session, model: null, effort: null };
    const cut = await backend.start({ ...start, rewindTo: P2 }, NO_REQUESTS);
    const token = cut.rewindToken;
    assert.equal(token, MESSAGES.at(-1)?.uuid);
    await cut.close();

    const again = await backend.start({ ...start, rewindTo: P2, rewindToken: token }, NO_REQUESTS);
    assert.equal(again.rewindToken, token);
    await again.close();

    await assert.rejects(
      backend.start(
        { ...start, rewindTo: P2, rewindToken: "an entry a terminal wrote" },
        NO_REQUESTS,
      ),
      RewindRefused,
    );
    assert.equal(sdk.queries.length, 2, "the refused start spawned no process");
  },
);
