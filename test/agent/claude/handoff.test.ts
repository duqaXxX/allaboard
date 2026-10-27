/**
 * What the Claude back end tells the core about a session open in a terminal: who holds it
 * (`holders.ts`), which messages the daemon's own process saved (`goals.savedMessage`) and the
 * turns another process wrote after them (`turns.ts`).
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { SessionMessage, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeBackend } from "../../../src/agent/claude/backend.ts";
import { goalStore, savedMessage } from "../../../src/agent/claude/goals.ts";
import { listed, parents, sessionHolders } from "../../../src/agent/claude/holders.ts";
import { projectKey } from "../../../src/agent/claude/listing.ts";
import { promptOf, turnsAfter, turnsOf } from "../../../src/agent/claude/turns.ts";
import type { SessionEvent } from "../../../src/agent/seam.ts";

const SESSION = "1f3f5507-0000-4000-8000-000000000001";
const OTHER = "a9ebe601-0000-4000-8000-000000000002";

// The fields `claude agents --json` prints, as Claude Code 2.1.310 printed them on 2026-10-27.
function agentsOutput(entries: { pid: number; sessionId: string; status: string }[]): string {
  return JSON.stringify(
    entries.map((e, index) => ({
      pid: e.pid,
      cwd: "/work/demo",
      kind: "interactive",
      startedAt: 1793061644599 + index,
      sessionId: e.sessionId,
      name: `demo-${index}`,
      status: e.status,
    })),
  );
}

test("the list keeps the entries of the session, with whether each runs a turn", () => {
  const output = agentsOutput([
    { pid: 10, sessionId: SESSION, status: "idle" },
    { pid: 11, sessionId: OTHER, status: "busy" },
    { pid: 12, sessionId: SESSION, status: "busy" },
  ]);
  assert.deepEqual(listed(output, SESSION), [
    { pid: 10, busy: false },
    { pid: 12, busy: true },
  ]);
  assert.throws(() => listed("{}", SESSION));
});

test("ps output gives each pid its parent", () => {
  assert.deepEqual(
    [...parents("   10     1\n12  4242\n\n")],
    [
      [10, 1],
      [12, 4242],
    ],
  );
});

test("a holder whose parent is the daemon is its own, any other is a terminal", async () => {
  const calls: string[] = [];
  const holders = await sessionHolders(SESSION, {
    command: "claude",
    env: { CLAUDE_CONFIG_DIR: "/work/login" },
    self: 4242,
    run: async (command, args, env) => {
      calls.push(`${command} ${args.join(" ")} ${env.CLAUDE_CONFIG_DIR}`);
      if (command === "claude") {
        return agentsOutput([
          { pid: 10, sessionId: SESSION, status: "idle" },
          { pid: 12, sessionId: SESSION, status: "busy" },
        ]);
      }
      return "10 4242\n12 777\n";
    },
  });
  assert.deepEqual(holders, [
    { id: "10", own: true, busy: false },
    { id: "12", own: false, busy: true },
  ]);
  assert.deepEqual(calls, [
    "claude agents --json /work/login",
    "ps -o pid= -o ppid= -p 10,12 /work/login",
  ]);
});

test("no holder asks nothing of ps, and a failure of either list is no answer", async () => {
  const none = await sessionHolders(SESSION, {
    command: "claude",
    env: {},
    self: 1,
    run: async (command) => {
      assert.equal(command, "claude");
      return agentsOutput([{ pid: 11, sessionId: OTHER, status: "busy" }]);
    },
  });
  assert.deepEqual(none, []);
  const failed = await sessionHolders(SESSION, {
    command: "claude",
    env: {},
    self: 1,
    run: async (command) => {
      if (command === "ps") throw new Error("no ps");
      return agentsOutput([{ pid: 10, sessionId: SESSION, status: "idle" }]);
    },
  });
  assert.equal(failed, null);
});

// Real entries a session store received for one turn (SDK 0.3.310, Claude Code 2.1.310,
// 2026-10-27), scrubbed: their uuids are those `getSessionMessages` returned for the session.
async function storeEntries(): Promise<SessionStoreEntry[]> {
  const path = new URL("../../fixtures/sdk/message-store.json", import.meta.url);
  return JSON.parse(await readFile(path, "utf8")) as SessionStoreEntry[];
}

test("a user or an assistant entry is a saved message, with its uuid and time", async () => {
  const [user, assistant] = (await storeEntries()) as [SessionStoreEntry, SessionStoreEntry];
  assert.deepEqual(savedMessage(user), {
    id: user.uuid,
    at: Date.parse(user.timestamp as string),
  });
  assert.equal(savedMessage(assistant)?.id, assistant.uuid);
  assert.equal(
    savedMessage({ type: "queue-operation", timestamp: "2026-10-27T03:12:51.350Z" }),
    null,
  );
  assert.equal(
    savedMessage({ type: "attachment", uuid: "x", timestamp: "2026-10-27T03:12:51Z" }),
    null,
  );
});

test("the store hands the last message of each batch of the main transcript", async () => {
  const entries = await storeEntries();
  const last = entries[1] as SessionStoreEntry;
  const events: SessionEvent[] = [];
  const store = goalStore((event) => events.push(event));
  await store.append({ projectKey: "p", sessionId: SESSION }, entries);
  await store.append({ projectKey: "p", sessionId: SESSION, subpath: "subagents/a" }, entries);
  await store.append({ projectKey: "p", sessionId: SESSION }, [{ type: "queue-operation" }]);
  assert.deepEqual(events, [
    {
      type: "message_saved",
      message: { id: last.uuid, at: Date.parse(last.timestamp as string) },
    },
  ]);
});

/** A message as `getSessionMessages` returns it, around a real entry's `message`. */
function sessionMessage(
  type: "user" | "assistant",
  uuid: string,
  message: Record<string, unknown>,
): SessionMessage {
  return {
    type,
    uuid,
    session_id: SESSION,
    message,
    parent_tool_use_id: null,
    parent_agent_id: null,
  };
}

const user = (uuid: string, content: unknown) =>
  sessionMessage("user", uuid, { role: "user", content });
const assistant = (uuid: string, content: unknown[]) =>
  sessionMessage("assistant", uuid, { role: "assistant", content });

test("a prompt is what the owner typed: text, or a command as the terminal shows it", () => {
  assert.equal(promptOf(user("u1", [{ type: "text", text: "Rename it" }])), "Rename it");
  assert.equal(promptOf(user("u2", "Plain string")), "Plain string");
  // the prompt Claude Code 2.1.310 writes for `/model opus` typed in a session
  const command =
    "<command-name>/model</command-name>\n            <command-message>model</command-message>\n" +
    "            <command-args>opus</command-args>";
  assert.equal(promptOf(user("u3", command)), "/model opus");
  assert.equal(
    promptOf(user("u4", "<command-name>/usage</command-name>\n<command-args></command-args>")),
    "/usage",
  );
  assert.equal(promptOf(user("u5", "<task-notification>\n<task-id>b1</task-id>")), null);
  assert.equal(
    promptOf(user("u6", [{ type: "tool_result", tool_use_id: "t1", content: "ok" }])),
    null,
  );
  assert.equal(promptOf(assistant("a1", [{ type: "text", text: "OK" }])), null);
});

test("turns pair each typed prompt with the last text written in its turn", () => {
  const turns = turnsOf([
    user("u1", [{ type: "text", text: "Remember TERM-ONE" }]),
    assistant("a1", [{ type: "thinking", thinking: "", signature: "s" }]),
    assistant("a2", [{ type: "text", text: "OK" }]),
    user("u2", "Rename the helper"),
    assistant("a3", [{ type: "text", text: "Looking." }]),
    assistant("a4", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
    user("u3", [{ type: "tool_result", tool_use_id: "t1", content: "done" }]),
    assistant("a5", [{ type: "text", text: "Renamed it." }]),
    user("u4", "<task-notification>\n<status>completed</status>"),
    assistant("a6", [{ type: "text", text: "The command finished." }]),
    user("u5", "No answer yet"),
  ]);
  assert.deepEqual(turns, [
    { prompt: "Remember TERM-ONE", reply: "OK" },
    { prompt: "Rename the helper", reply: "Renamed it." },
    { prompt: "No answer yet", reply: null },
  ]);
});

let home: string;
let folder: string;
let projects: string;

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "handoff-")));
  folder = join(home, "work");
  await mkdir(folder);
  projects = join(home, ".claude", "projects");
  await mkdir(join(projects, await projectKey(folder)), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function transcript(lastAt: string): Promise<void> {
  const line = JSON.stringify({ type: "assistant", uuid: "last", timestamp: lastAt });
  await writeFile(join(projects, await projectKey(folder), `${SESSION}.jsonl`), `${line}\n`);
}

test("nothing newer than the saved message reads nothing more", async () => {
  await transcript("2026-10-27T03:00:00.000Z");
  const found = await turnsAfter(
    folder,
    SESSION,
    { id: "a1", at: Date.parse("2026-10-27T03:00:00.000Z") },
    {
      projects,
      getSessionMessages: async () => assert.fail("read in full"),
    },
  );
  assert.deepEqual(found, { changed: false, turns: [], last: null });
});

test("a newer message reads the turns written after the saved one", async () => {
  await transcript("2026-10-27T03:05:00.000Z");
  const asked: unknown[] = [];
  const found = await turnsAfter(
    folder,
    SESSION,
    { id: "a1", at: Date.parse("2026-10-27T03:00:00.000Z") },
    {
      projects,
      getSessionMessages: async (session, options) => {
        asked.push([session, options]);
        return [
          user("u0", "From Slack"),
          assistant("a1", [{ type: "text", text: "Done in Slack" }]),
          user("u1", "From the terminal"),
          assistant("a2", [{ type: "text", text: "Done there" }]),
        ];
      },
    },
  );
  assert.deepEqual(found, {
    changed: true,
    turns: [{ prompt: "From the terminal", reply: "Done there" }],
    last: { id: "a2", at: Date.parse("2026-10-27T03:05:00.000Z") },
  });
  assert.deepEqual(asked, [[SESSION, { dir: folder }]]);
});

test("a saved message no longer in the conversation is a change with no turns to show", async () => {
  await transcript("2026-10-27T03:05:00.000Z");
  const found = await turnsAfter(
    folder,
    SESSION,
    { id: "gone", at: 1 },
    { projects, getSessionMessages: async () => [user("u1", "Elsewhere")] },
  );
  assert.deepEqual(found, {
    changed: true,
    turns: [],
    last: { id: "u1", at: Date.parse("2026-10-27T03:05:00.000Z") },
  });
});

test("the back end runs the list for its login, and continues a cut turn with the variable", async () => {
  const configDir = join(home, "login-two");
  const seen: string[] = [];
  const backend = new ClaudeBackend({
    home,
    configDir,
    runOutput: async (command, _args, env) => {
      seen.push(`${command} ${env.CLAUDE_CONFIG_DIR}`);
      return command === "claude" ? agentsOutput([]) : "";
    },
  });
  assert.deepEqual(await backend.sessionHolders(SESSION), []);
  assert.deepEqual(seen, [`claude ${configDir}`]);
  assert.match(
    backend.words.terminalContinue ?? "",
    /CLAUDE_CONFIG_DIR=.* CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1 claude --resume \{session\}$/,
  );
  await backend.close();
});

test("what the agent wrote before any typed prompt is the turn going on, shown first", () => {
  // As `getSessionMessages` returned it after `!terminal` cut a turn and the terminal took it
  // up by itself (Claude Code 2.1.311, 2026-10-27): its `isMeta` prompt is left out.
  const turns = turnsOf([
    user("u1", [{ type: "tool_result", tool_use_id: "t1", content: "Exit code 137" }]),
    assistant("a1", [{ type: "thinking", thinking: "", signature: "s" }]),
    assistant("a2", [{ type: "text", text: "The command was killed. I'll run it once more." }]),
    assistant("a3", [{ type: "tool_use", id: "t2", name: "Bash", input: {} }]),
    user("u2", [{ type: "tool_result", tool_use_id: "t2", content: "" }]),
    assistant("a4", [{ type: "text", text: "FINISHED" }]),
    user("u3", "And now?"),
    assistant("a5", [{ type: "text", text: "Here." }]),
  ]);
  assert.deepEqual(turns, [
    { prompt: null, reply: "FINISHED" },
    { prompt: "And now?", reply: "Here." },
  ]);
  // nothing written before the first prompt: no turn going on
  assert.deepEqual(
    turnsOf([user("u4", "Hi"), assistant("a6", [{ type: "text", text: "Hello" }])]),
    [{ prompt: "Hi", reply: "Hello" }],
  );
});

test("a notification's turn right after the turn going on joins neither", () => {
  const turns = turnsOf([
    user("u1", [{ type: "tool_result", tool_use_id: "t1", content: "Exit code 137" }]),
    assistant("a1", [{ type: "text", text: "FINISHED" }]),
    user("u2", "<task-notification>\n<status>completed</status>"),
    assistant("a2", [{ type: "text", text: "The background command finished." }]),
    user("u3", "Typed"),
    assistant("a3", [{ type: "text", text: "Answered." }]),
  ]);
  assert.deepEqual(turns, [
    { prompt: null, reply: "FINISHED" },
    { prompt: "Typed", reply: "Answered." },
  ]);
});
