/** `!memory` and `!skills` as text (`loaded.ts`): paths shown short, sizes, one-line descriptions. */
import assert from "node:assert/strict";
import { join, sep } from "node:path";
import { test } from "node:test";
import type { CommandInfo, LoadedContext } from "../../src/agent/seam.ts";
import { memoryText, skillsText } from "../../src/core/loaded.ts";
import * as texts from "../../src/core/texts.ts";

// Paths in the system's own form, as Claude Code reports them: `~` keeps the system's separator.
const HOME = join(sep, `ho${"me"}`, "alice");
const FOLDER = join(HOME, "work", "app");
const ELSEWHERE = join(sep, "etc", "claude", "CLAUDE.md");
const same = (text: string) => text;

const LOADED: LoadedContext = {
  memoryFiles: [
    { path: join(HOME, ".claude", "CLAUDE.md"), tokens: 2300 },
    { path: join(FOLDER, "CLAUDE.md"), tokens: 1650 },
    { path: ELSEWHERE, tokens: 170 },
  ],
  skills: [
    { name: "pdf", source: "plugin", tokens: 90 },
    { name: "loop", source: "built-in", tokens: 86 },
  ],
};

const command = (name: string, description: string): CommandInfo => ({
  name,
  description,
  argumentHint: "",
  aliases: [],
});

test("memory files show from the session's folder or the home, with their sizes", () => {
  assert.equal(
    memoryText(LOADED, FOLDER, same, HOME),
    [
      "Memory files loaded (3, 4,120 tokens):",
      `• ~${sep}.claude${sep}CLAUDE.md · 2,300 tokens`,
      "• CLAUDE.md · 1,650 tokens",
      `• ${ELSEWHERE} · 170 tokens`,
    ].join("\n"),
  );
});

test("each path and name goes through the chat's escape", () => {
  const marked = (text: string) => `[${text}]`;
  assert.ok(memoryText(LOADED, FOLDER, marked, HOME).includes("• [CLAUDE.md] · 1,650 tokens"));
  assert.ok(skillsText(LOADED, [], marked).includes("• [loop] · [built-in]"));
});

test("a skill reads its command's description on one line, or its source with none", () => {
  const commands = [command("pdf", "Read, merge and\nfill PDF files"), command("other", "x")];
  assert.equal(
    skillsText(LOADED, commands, same),
    ["Skills (2):", "• pdf · Read, merge and fill PDF files", "• loop · built-in"].join("\n"),
  );
});

test("nothing loaded says so", () => {
  const empty: LoadedContext = { memoryFiles: [], skills: [] };
  assert.equal(memoryText(empty, FOLDER, same, HOME), texts.MEMORY_NONE);
  assert.equal(skillsText(empty, [], same), texts.SKILLS_NONE);
});
