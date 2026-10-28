/**
 * The words of one module stay in that module. Outside the modules (a directory under
 * `src/agent/` or `src/chat/`) and the registry, no identifier and no string of the source names
 * an agent, a chat or what only one of them has: the core and the seams are written for any agent
 * and any chat. A module's own name is one of the words, and its directory one of the homes, from
 * the directories themselves. Comments are exempt: they may say what was measured, and on what.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import type { ToolVocabulary } from "../src/agent/seam.ts";
import { REGISTRY } from "../src/registry.ts";
import { blank } from "./support/source-scan.ts";

const SRC = join(import.meta.dirname, "..", "src");

/**
 * The directories of the modules under a `src/` folder, as `agent/<name>/` and `chat/<name>/`
 * with forward slashes.
 */
export function moduleDirectories(src: string): string[] {
  return ["agent", "chat"].flatMap((layer) =>
    readdirSync(join(src, layer), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${layer}/${entry.name}/`),
  );
}

// What only one module has, besides its name: its libraries and what its chat or agent calls things.
const MODULE_WORDS = ["anthropic", "bolt", "threadTs", "mrkdwn", "modal", "ephemeral", "emoji"];

/** The words of the modules under `src`: the name of each, and `MODULE_WORDS`. */
export function wordsOf(src: string): string[] {
  const names = moduleDirectories(src).map((home) => home.split("/")[1] as string);
  return [...names, ...MODULE_WORDS];
}

// Matched whatever the case, anywhere in an identifier or a string.
export const WORDS = wordsOf(SRC);

/** Where the words belong: a path under `src/` with forward slashes, or a folder of it. */
export const HOMES = [...moduleDirectories(SRC), "registry.ts"];

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** Each word of `WORDS` in `source` outside a comment, as `line: word`. */
export function named(source: string, words: readonly string[] = WORDS): string[] {
  const found: string[] = [];
  const lines = blank(source, { keepText: true }).toLowerCase().split("\n");
  for (const [index, line] of lines.entries()) {
    for (const word of words) {
      if (line.includes(word.toLowerCase())) found.push(`${index + 1}: ${word}`);
    }
  }
  return found;
}

test("the scan finds a word in an identifier and in a string, and not in a comment", () => {
  assert.deepEqual(named("const threadTs = 1;"), ["1: threadTs"]);
  assert.deepEqual(named('say("Opened in Slack");'), ["1: slack"]);
  // A template's expression is code: the word is found there too.
  assert.deepEqual(named(["say(`a $", "{modalTitle} b`);"].join("")), ["1: modal"]);
  assert.deepEqual(named("// Slack limits a block\nconst limit = 50; /* an emoji */"), []);
  assert.deepEqual(named('const url = "https://example.test"; // claude'), []);
});

test("the homes and the words come from the module directories, whatever their names", () => {
  const src = mkdtempSync(join(tmpdir(), "allaboard-vocabulary-"));
  for (const directory of ["agent/codex", "agent/claude", "chat/discord", "core"]) {
    mkdirSync(join(src, directory), { recursive: true });
  }
  writeFileSync(join(src, "agent", "seam.ts"), "");
  writeFileSync(join(src, "chat", "seam.ts"), "");
  assert.deepEqual(moduleDirectories(src).toSorted(), [
    "agent/claude/",
    "agent/codex/",
    "chat/discord/",
  ]);
  const words = wordsOf(src);
  for (const name of ["codex", "claude", "discord"]) assert.ok(words.includes(name), name);
  assert.deepEqual(named("const discordThread = 1; const codexSession = 2;", words), [
    "1: codex",
    "1: discord",
  ]);
  assert.deepEqual(named("const thread = 1;", words), []);
});

test("the directories of this repository are the modules it has", () => {
  assert.deepEqual(HOMES.slice(-1), ["registry.ts"]);
  assert.ok(HOMES.includes("agent/claude/") && HOMES.includes("chat/slack/"));
  assert.ok(WORDS.includes("claude") && WORDS.includes("slack"));
});

test("no source file outside the modules and the registry names an agent or a chat", () => {
  const found: string[] = [];
  for (const path of sources(SRC)) {
    const file = relative(SRC, path).split(sep).join("/");
    if (HOMES.some((home) => file === home || file.startsWith(home))) continue;
    for (const hit of named(readFileSync(path, "utf8"))) found.push(`${file}:${hit}`);
  }
  assert.deepEqual(found, []);
});

const TESTS = import.meta.dirname;

/** The relative specifiers a file imports, resolved against its own folder. */
function importedBy(path: string): string[] {
  const specifiers = [
    ...readFileSync(path, "utf8").matchAll(/(?:from|import\(?)\s*["']([^"']+)["']/g),
  ].map((match) => match[1] as string);
  return specifiers.filter((s) => s.startsWith(".")).map((s) => join(path, "..", s));
}

/**
 * The files under `test/<layer>/` that reach a file of an agent module, as the `src/` path of
 * the first module file on the way. A file reaches a module by importing it, or by importing a
 * file under `test/` or `src/` that does, at any depth: the indirect path through `test/support/`
 * hid the Claude harness from the first version of this guard, and the one through
 * `src/registry.ts` or `src/main.ts`, which import the modules, hid their callers from the second.
 * A bare `import "./x.ts"` counts as an import.
 */
export function importingAgentModules(
  tests: string,
  src: string,
  layers: readonly string[],
): string[] {
  const homes = moduleDirectories(src).filter((home) => home.startsWith("agent/"));
  const reached = new Map<string, boolean>();
  function reaches(path: string, seen: Set<string>): boolean {
    const known = reached.get(path);
    if (known !== undefined) return known;
    if (seen.has(path)) return false;
    seen.add(path);
    let found = false;
    for (const target of importedBy(path)) {
      const inSrc = relative(src, target).split(sep).join("/");
      if (!inSrc.startsWith("..") && homes.some((home) => inSrc.startsWith(home))) {
        found = true;
      } else if ((target.startsWith(tests) || target.startsWith(src)) && existsSync(target)) {
        found = reaches(target, seen);
      }
      if (found) break;
    }
    reached.set(path, found);
    return found;
  }
  const offenders: string[] = [];
  for (const layer of layers) {
    for (const path of sources(join(tests, layer))) {
      if (reaches(path, new Set())) offenders.push(relative(tests, path).split(sep).join("/"));
    }
  }
  return offenders.toSorted();
}

test("the scan finds the files that reach an agent module, whatever its name and however far", () => {
  const root = mkdtempSync(join(tmpdir(), "allaboard-imports-"));
  for (const directory of [
    "src/agent/codex",
    "src/chat",
    "tests/core",
    "tests/chat/x",
    "tests/support",
  ]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  writeFileSync(
    join(root, "tests/core/a.test.ts"),
    'import { f } from "../../src/agent/codex/f.ts";',
  );
  writeFileSync(join(root, "tests/core/b.test.ts"), 'import { s } from "../../src/agent/seam.ts";');
  writeFileSync(
    join(root, "tests/chat/x/c.test.ts"),
    'const m = await import("../../../src/agent/codex/m.ts");',
  );
  // Through a support file, and through a support file of a support file.
  writeFileSync(
    join(root, "tests/support/harness.ts"),
    'import { f } from "../../src/agent/codex/f.ts";',
  );
  writeFileSync(join(root, "tests/support/outer.ts"), 'import { h } from "./harness.ts";');
  writeFileSync(join(root, "tests/support/clean.ts"), "export const x = 1;");
  writeFileSync(join(root, "tests/core/d.test.ts"), 'import { o } from "../support/outer.ts";');
  writeFileSync(join(root, "tests/core/e.test.ts"), 'import { c } from "../support/clean.ts";');
  assert.deepEqual(
    importingAgentModules(join(root, "tests"), join(root, "src"), ["core", "chat"]),
    ["chat/x/c.test.ts", "core/a.test.ts", "core/d.test.ts"],
  );
});

test("the scan follows an import through a source file and finds a bare import", () => {
  const root = mkdtempSync(join(tmpdir(), "allaboard-imports-"));
  for (const directory of ["src/agent/codex", "src/chat", "src/core", "tests/core"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  // The registry shape: a source file outside the modules that imports one.
  writeFileSync(
    join(root, "src/registry.ts"),
    'import { codexAgent } from "./agent/codex/module.ts";',
  );
  writeFileSync(join(root, "src/core/config.ts"), 'import { REGISTRY } from "../registry.ts";');
  writeFileSync(join(root, "src/core/plain.ts"), "export const y = 1;");
  writeFileSync(join(root, "tests/core/via-registry.test.ts"), 'import "../../src/registry.ts";');
  writeFileSync(
    join(root, "tests/core/via-core.test.ts"),
    'import { c } from "../../src/core/config.ts";',
  );
  writeFileSync(
    join(root, "tests/core/bare.test.ts"),
    'import "../../src/agent/codex/side-effect.ts";',
  );
  writeFileSync(
    join(root, "tests/core/clean.test.ts"),
    'import { y } from "../../src/core/plain.ts";',
  );
  assert.deepEqual(importingAgentModules(join(root, "tests"), join(root, "src"), ["core"]), [
    "core/bare.test.ts",
    "core/via-core.test.ts",
    "core/via-registry.test.ts",
  ]);
});

// The rule (#119, invariant 8): a test under `test/core/` or `test/chat/` never reaches
// `src/agent/<module>/`, directly or through `test/support/`. Where a support file that reaches a
// module is used today decides what is allowed: only by tests under `test/agent/<that module>/`,
// by `test/conformance/` and `test/scenario/` (which run every module the registry names), and by
// the top-level tests of the daemon, none of which is under a guarded layer. A test of the core
// that needs a stream or a vocabulary of one agent therefore lives under `test/agent/<module>/`.
test("no test of the core or the chat reaches an agent module, directly or through a support file", () => {
  assert.deepEqual(importingAgentModules(TESTS, SRC, ["core", "chat"]), []);
});

/** The tool names a vocabulary declares: its keys and list entries, never the input keys. */
export function toolNames(tools: ToolVocabulary): string[] {
  return [
    ...Object.keys(tools.words),
    ...Object.keys(tools.previews),
    ...tools.askers,
    ...tools.launchers,
    ...tools.failsCounted,
    ...(tools.plainAgentType === null ? [] : [tools.plainAgentType]),
    ...Object.keys(tools.described),
    ...Object.keys(tools.commanded),
    ...Object.keys(tools.continuers),
    ...(tools.plan === null ? [] : [tools.plan.tool]),
  ];
}

/** Each of `names` that `source` holds as a whole string literal outside a comment, as `line: name`. */
export function literalsNamed(source: string, names: readonly string[]): string[] {
  const found: string[] = [];
  const lines = blank(source, { keepText: true }).split("\n");
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)) {
      const text = match[2] as string;
      if (names.includes(text)) found.push(`${index + 1}: ${text}`);
    }
  }
  return found;
}

test("the scan finds a tool name as a whole literal and not inside a longer word", () => {
  assert.deepEqual(literalsNamed('const tool = "Bash"; const x = "Bash is";', ["Bash"]), [
    "1: Bash",
  ]);
  assert.deepEqual(literalsNamed("const read = 1; // 'Read'", ["Read"]), []);
  assert.deepEqual(literalsNamed("if (name === 'Read') {}", ["Read"]), ["1: Read"]);
});

/**
 * The exported constant whose declaration holds line `line` (1-based) of `source`, or null: from
 * its `export const NAME` line to the first line that closes it, a line ending in `;` that is the
 * first line itself or starts at column 0. A literal elsewhere in the file is not in it.
 */
export function constantAt(source: string, line: number): string | null {
  const lines = source.split("\n");
  for (let start = line - 1; start >= 0; start -= 1) {
    const opened = /^export const (\w+)/.exec(lines[start] as string);
    if (opened === null) continue;
    for (let end = start; end < lines.length; end += 1) {
      const text = lines[end] as string;
      if (text.endsWith(";") && (end === start || /^\S/.test(text))) {
        return end >= line - 1 ? (opened[1] as string) : null;
      }
    }
    return null;
  }
  return null;
}

/**
 * The tool-name literals of `source` (`literalsNamed`) that are not in a constant `labels` lists
 * for `file`, as `line: name`.
 */
export function unlabelled(
  file: string,
  source: string,
  names: readonly string[],
  labels: ReadonlySet<string>,
): string[] {
  return literalsNamed(source, names).filter((hit) => {
    const [line, name] = hit.split(": ") as [string, string];
    const constant = constantAt(source, Number(line));
    return constant === null || !labels.has(`${file}:${constant}:${name}`);
  });
}

// Words the owner reads that are also a tool's name in Claude Code's vocabulary, by file, the
// constant that holds them and the word: a task kind's label and a button's. Neither names a
// tool, and no tool is looked up by it. Any other literal of that name in the same file is caught.
const LABELS = new Set([
  "core/sessions/constants.ts:TASK_WORDS:Agent",
  "core/sessions/constants.ts:TASK_WORDS:Task",
  "chat/slack/texts.ts:QUESTION_EDIT:Edit",
  "chat/slack/texts.ts:HOME_EDIT:Edit",
]);

test("a tool name in a labelled constant passes and the same name elsewhere in the file does not", () => {
  const source = [
    "export const TASK_WORDS = {",
    '  subagent: ["agent", "Agent"],',
    "};",
    'export const OTHER = "Agent";',
    'const inline = (name: string) => name === "Agent";',
  ].join("\n");
  assert.equal(constantAt(source, 2), "TASK_WORDS");
  assert.equal(constantAt(source, 4), "OTHER");
  assert.deepEqual(
    unlabelled("core/x.ts", source, ["Agent"], new Set(["core/x.ts:TASK_WORDS:Agent"])),
    ["4: Agent", "5: Agent"],
  );
});

test("no source of the core or the chat holds a tool name an agent module knows", () => {
  const names = [
    ...new Set(
      Object.values(REGISTRY.agents).flatMap((entry) => [
        ...entry.toolNames,
        ...toolNames(entry.tools),
      ]),
    ),
  ];
  // The names the renderer test banned before the vocabulary left the core.
  for (const banned of ["Bash", "Read", "Write", "Edit", "Agent", "Task", "TodoWrite"]) {
    assert.ok(names.includes(banned), banned);
  }
  assert.ok(names.includes("WebSearch") && names.includes("AskUserQuestion"));
  const found: string[] = [];
  for (const layer of ["core", "chat"]) {
    for (const path of sources(join(SRC, layer))) {
      const file = relative(SRC, path).split(sep).join("/");
      for (const hit of unlabelled(file, readFileSync(path, "utf8"), names, LABELS)) {
        found.push(`${file}:${hit}`);
      }
    }
  }
  assert.deepEqual(found, []);
});
