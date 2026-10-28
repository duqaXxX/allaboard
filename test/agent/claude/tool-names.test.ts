/**
 * `TOOL_NAMES` lists every built-in tool the recorded `init` records offer: the core's guard
 * (`test/vocabulary.test.ts`) scans for exactly these names.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { TOOL_NAMES, TOOLS } from "../../../src/agent/claude/tools.ts";

const SDK = join(import.meta.dirname, "..", "..", "fixtures", "sdk");

function initTools(): Set<string> {
  const names = new Set<string>();
  for (const file of readdirSync(SDK).filter((name) => name.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(SDK, file), "utf8").split("\n")) {
      if (!line.includes('"subtype":"init"')) continue;
      const record = JSON.parse(line) as { subtype?: string; tools?: string[] };
      if (record.subtype === "init") for (const tool of record.tools ?? []) names.add(tool);
    }
  }
  return names;
}

test("every built-in tool of the recorded init records is a known tool name", () => {
  const recorded = [...initTools()].filter((name) => !name.startsWith("mcp__"));
  assert.ok(recorded.includes("Bash") && recorded.includes("Read"));
  assert.deepEqual(
    recorded.filter((name) => !TOOL_NAMES.includes(name)),
    [],
  );
});

test("the vocabulary names only known tools", () => {
  for (const tool of [
    ...Object.keys(TOOLS.words),
    ...Object.keys(TOOLS.previews),
    ...TOOLS.askers,
  ]) {
    assert.ok(TOOL_NAMES.includes(tool), tool);
  }
});
