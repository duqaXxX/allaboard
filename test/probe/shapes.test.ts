import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import {
  type Accepted,
  acceptance,
  differences,
  fixtureRecords,
  kindOf,
  loadAccepted,
  shapesReport,
} from "../../probe/shapes.ts";
import { type Records, tapped } from "../../probe/tap.ts";
import { type JsonObject, sdkRecords } from "../support/fixtures.ts";

const NONE: Accepted = { kinds: {}, paths: {}, tools: {} };

// Recorded records, copied so a test can change one: their shape is Claude Code's own.
function tools(): JsonObject[] {
  return structuredClone(sdkRecords("tools"));
}

test("the fixtures have no difference from themselves", () => {
  const records = fixtureRecords();
  assert.ok(records.length > 1000);
  assert.deepEqual(differences(records, records, NONE), []);
});

test("a key a record gains is one difference, under its kind", () => {
  const recorded = tools();
  const live = tools();
  const init = live.find((record) => record.subtype === "init");
  assert.ok(init);
  init.original_cwd = "/home/dev/project";
  assert.deepEqual(differences(live, recorded, NONE), [
    { what: "path", kind: "system/init", path: "original_cwd:string" },
  ]);
});

test("a value of another type is a difference, a value of the same type is not", () => {
  const recorded = tools();
  const live = tools();
  const init = live.find((record) => record.subtype === "init");
  assert.ok(init);
  init.cwd = "/home/dev/elsewhere";
  assert.deepEqual(differences(live, recorded, NONE), []);
  init.cwd = 7;
  assert.deepEqual(differences(live, recorded, NONE), [
    { what: "path", kind: "system/init", path: "cwd:number" },
  ]);
});

test("a null is covered by any type the path is known with", () => {
  const recorded = tools();
  const init = recorded.find((record) => record.subtype === "init");
  assert.ok(init);
  init.output_style = "default";
  const live = tools();
  const now = live.find((record) => record.subtype === "init");
  assert.ok(now);
  now.output_style = null;
  assert.deepEqual(differences(live, recorded, NONE), []);
  now.output_style = 1;
  assert.deepEqual(differences(live, recorded, NONE), [
    { what: "path", kind: "system/init", path: "output_style:number" },
  ]);
});

test("an accepted file that is not its shape is refused before a run", () => {
  const folder = mkdtempSync(join(tmpdir(), "allaboard-shapes-"));
  const bad = join(folder, "accepted.json");
  writeFileSync(
    bad,
    JSON.stringify({ kinds: {}, paths: { "system/init": { "x:string": "soon" } } }),
  );
  assert.throws(() => loadAccepted(bad), /Claude Code versions/);
});

test("an accepted path is no difference", () => {
  const live = tools();
  const init = live.find((record) => record.subtype === "init");
  assert.ok(init);
  init.original_cwd = "/home/dev/project";
  const accepted: Accepted = {
    ...NONE,
    paths: { "system/init": { "original_cwd:string": "2.1.304" } },
  };
  assert.deepEqual(differences(live, tools(), accepted), []);
});

test("keys that are data, a tool call's id or a model, do not count as paths", () => {
  const live = tools();
  const call = live.find((record) => record.type === "assistant" && record.wire_tool_inputs);
  assert.ok(call);
  call.wire_tool_inputs = { toolu_0SYNTHETIC: { file_path: "/home/dev/project/notes.txt" } };
  const result = live.find((record) => record.type === "result");
  assert.ok(result);
  result.modelUsage = { "claude-synthetic-9": { inputTokens: 1 } };
  const recorded = tools();
  const usage = recorded.find((record) => record.type === "result");
  assert.ok(usage);
  usage.modelUsage = { "claude-haiku-4-5": { inputTokens: 2 } };
  assert.deepEqual(differences(live, recorded, NONE), []);
});

test("a new kind is one difference, not one per path", () => {
  const live = tools();
  live.push({ type: "system", subtype: "synthetic_kind", session_id: "s", uuid: "u", count: 1 });
  assert.deepEqual(differences(live, tools(), NONE), [
    { what: "kind", kind: "system/synthetic_kind" },
  ]);
});

test("a built-in tool the init lists is a difference, an MCP server's tool is not", () => {
  const live = tools();
  const init = live.find((record) => record.subtype === "init");
  assert.ok(init && Array.isArray(init.tools));
  init.tools = [...init.tools, "SyntheticTool", "mcp__claude_ai_Synthetic__read"];
  assert.deepEqual(differences(live, tools(), NONE), [{ what: "tool", name: "SyntheticTool" }]);
});

test("a stream event's kind names its event and its block or delta", () => {
  assert.equal(
    kindOf({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta" } },
    }),
    "stream_event/content_block_delta/text_delta",
  );
  assert.equal(kindOf({ type: "result", subtype: "success" }), "result/success");
});

test("the report gives the entries that accept what it found", () => {
  const found = [
    { what: "kind", kind: "system/synthetic_kind" },
    { what: "path", kind: "system/init", path: "original_cwd:string" },
    { what: "tool", name: "SyntheticTool" },
  ] as const;
  assert.deepEqual(acceptance(found, "2.1.999"), {
    kinds: { "system/synthetic_kind": "2.1.999" },
    paths: { "system/init": { "original_cwd:string": "2.1.999" } },
    tools: { SyntheticTool: "2.1.999" },
  });
  const report = shapesReport(found, "2.1.999");
  assert.match(report, /3 not in the fixtures/);
  assert.match(report, /\+ system\/init original_cwd:string/);
  assert.match(shapesReport([], "2.1.999"), /in the fixtures or accepted/);
});

test("every accepted entry names the Claude Code version it was accepted on", () => {
  const accepted = loadAccepted();
  const versions = [
    ...Object.values(accepted.kinds),
    ...Object.values(accepted.tools),
    ...Object.values(accepted.paths).flatMap((paths) => Object.values(paths)),
  ];
  for (const version of versions) assert.match(version, /^\d+\.\d+\.\d+$/);
});

test("the tap copies every message the session reads and leaves the query's methods alone", async () => {
  const messages = [
    { type: "system", subtype: "init" },
    { type: "result", subtype: "success" },
  ];
  let interrupted = false;
  async function* stream() {
    yield* messages;
  }
  // A stand-in for the SDK's Query: an async generator with a method of its own.
  const run = Object.assign(stream(), {
    async interrupt() {
      interrupted = true;
    },
  }) as unknown as Query;
  const into: Records = [];
  const tap = tapped(run, into);
  const read: unknown[] = [];
  for await (const message of tap) read.push(message);
  await tap.interrupt();
  assert.deepEqual(read, messages);
  assert.deepEqual(into, messages);
  assert.equal(interrupted, true);
});
