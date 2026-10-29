/**
 * The words of one module stay in that module. Outside the modules (a directory under
 * `src/agent/` or `src/chat/`) and the registry, no identifier and no string of the source names
 * an agent, a chat or what only one of them has: the core and the seams are written for any agent
 * and any chat. A module's own name is one of the words, and its directory one of the homes, from
 * the directories themselves; the rest it declares itself, as the `words` of its registry entry.
 * Comments are exempt: they may say what was measured, and on what.
 *
 * The scans by what they catch: `named` (a module's names, anywhere in `src/` outside the
 * modules); the tool names, the module's whole-string `literals`, the SDK's names read from
 * `docs/sdk-surface.md`, the model aliases and the `AgentWords` literals (the core, the chat seam
 * and the entry files); the `patterns` of the Web API's methods (all of `src/` outside the
 * modules); the ids of Slack in the core's tests and the scenarios.
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
import { loadSurface, type Row, setAside } from "../probe/surface.ts";
import type { AgentWords, ToolVocabulary } from "../src/agent/seam.ts";
import { systemClock } from "../src/clock.ts";
import type { ModuleWords } from "../src/module-setup.ts";
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

/** The `words` each module of the registry declares. */
function declaredWords(): ModuleWords[] {
  return [...Object.values(REGISTRY.agents), ...Object.values(REGISTRY.chats)].map(
    (entry) => entry.words,
  );
}

/**
 * The words of the modules under `src`: the name of each, and the `names` the modules declare
 * (`declared`, those of the registry by default).
 */
export function wordsOf(src: string, declared: readonly ModuleWords[] = declaredWords()): string[] {
  const names = moduleDirectories(src).map((home) => home.split("/")[1] as string);
  return [...names, ...declared.flatMap((words) => words.names)];
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
function importedBy(path: string): { target: string; typeOnly: boolean }[] {
  const text = readFileSync(path, "utf8");
  // An `import type` statement is erased: it reaches no value of the file it names.
  const types = new Set(
    [...text.matchAll(/import\s+type\b[^;]*?from\s*["']([^"']+)["']/g)].map(
      (match) => match[1] as string,
    ),
  );
  const specifiers = [...text.matchAll(/(?:from|import\(?)\s*["']([^"']+)["']/g)].map(
    (match) => match[1] as string,
  );
  return specifiers
    .filter((s) => s.startsWith("."))
    .map((s) => ({ target: join(path, "..", s), typeOnly: types.has(s) }));
}

/**
 * The files under `test/<layer>/` that reach a file of a module of `kind` (`agent` or `chat`),
 * as the `src/` path of the first module file on the way. A file reaches a module by importing
 * it, or by importing a file under `test/` or `src/` that does, at any depth: the indirect path
 * through `test/support/` hid the Claude harness from the first version of this guard, and the
 * one through `src/registry.ts` or `src/main.ts`, which import the modules, hid their callers
 * from the second. A bare `import "./x.ts"` counts as an import. A `wiring` file (a `src/`
 * path) is not followed when it is reached through one of the importers listed for it, or by an
 * `import type`; any other import of it is followed.
 */
export function importingModules(
  kind: "agent" | "chat",
  tests: string,
  src: string,
  layers: readonly string[],
  wiring: Readonly<Record<string, readonly string[]>> = {},
): string[] {
  const homes = moduleDirectories(src).filter((home) => home.startsWith(`${kind}/`));
  const reached = new Map<string, boolean>();
  function reaches(path: string, seen: Set<string>): boolean {
    const known = reached.get(path);
    if (known !== undefined) return known;
    if (seen.has(path)) return false;
    seen.add(path);
    let found = false;
    const importer = relative(src, path).split(sep).join("/");
    for (const { target, typeOnly } of importedBy(path)) {
      const inSrc = relative(src, target).split(sep).join("/");
      if (!inSrc.startsWith("..") && homes.some((home) => inSrc.startsWith(home))) {
        found = true;
      } else if (inSrc in wiring && (typeOnly || wiring[inSrc]?.includes(importer))) {
        continue;
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
    importingModules("agent", join(root, "tests"), join(root, "src"), ["core", "chat"]),
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
  assert.deepEqual(importingModules("agent", join(root, "tests"), join(root, "src"), ["core"]), [
    "core/bare.test.ts",
    "core/via-core.test.ts",
    "core/via-registry.test.ts",
  ]);
});

// The rule (#119, invariant 8): a test under `test/core/` or `test/chat/` never reaches
// `src/agent/<module>/`, directly or through `test/support/`, and nor does a scenario. Where a
// support file that reaches a module is used today decides what is allowed: only by tests under
// `test/agent/<that module>/`, by `test/conformance/` (which runs every module the registry names)
// and by the top-level tests of the daemon, none of which is under a guarded layer. The scenarios
// run the plain agent and the memory chat. A test of the core that needs a stream or a vocabulary
// of one agent therefore lives under `test/agent/<module>/`.
test("no test of the core or the chat reaches an agent module, directly or through a support file", () => {
  assert.deepEqual(importingModules("agent", TESTS, SRC, ["core", "chat"]), []);
});

// The scenarios run the daemon, which imports the registry: as for the chat, that path is the
// wiring, since `test/scenario/world.ts` passes its own registry built from the plain agent and
// the memory chat. A scenario that imports the registry itself, or a module, is a reach.
test("no scenario reaches an agent module", () => {
  assert.deepEqual(importingModules("agent", TESTS, SRC, ["scenario"], WIRING), []);
});

test("the scan keeps the two kinds of module apart, whatever their names", () => {
  const root = mkdtempSync(join(tmpdir(), "allaboard-imports-"));
  for (const directory of [
    "src/agent/codex",
    "src/chat/discord",
    "tests/core",
    "tests/scenario",
    "tests/support",
  ]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  const client = 'import { c } from "../../src/chat/discord/client.ts";';
  writeFileSync(join(root, "tests/support/fake-discord.ts"), client);
  writeFileSync(join(root, "tests/core/direct.test.ts"), client);
  writeFileSync(
    join(root, "tests/core/indirect.test.ts"),
    'import { f } from "../support/fake-discord.ts";',
  );
  writeFileSync(join(root, "tests/scenario/bare.test.ts"), 'import "../../src/chat/discord/x.ts";');
  writeFileSync(
    join(root, "tests/core/agent.test.ts"),
    'import { a } from "../../src/agent/codex/a.ts";',
  );
  const tests = join(root, "tests");
  const src = join(root, "src");
  assert.deepEqual(importingModules("chat", tests, src, ["core", "scenario"]), [
    "core/direct.test.ts",
    "core/indirect.test.ts",
    "scenario/bare.test.ts",
  ]);
  assert.deepEqual(importingModules("agent", tests, src, ["core", "scenario"]), [
    "core/agent.test.ts",
  ]);
});

test("a file listed as wiring is skipped only through its importers, and a direct import counts", () => {
  const root = mkdtempSync(join(tmpdir(), "allaboard-imports-"));
  for (const directory of ["src/agent", "src/chat/discord", "tests/scenario", "tests/core"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  writeFileSync(join(root, "src/registry.ts"), 'import { d } from "./chat/discord/module.ts";');
  // The daemon is the importer the scenarios run, so the registry behind it is the wiring.
  writeFileSync(join(root, "src/daemon.ts"), 'import { r } from "./registry.ts";');
  writeFileSync(
    join(root, "tests/scenario/world.ts"),
    'import { run } from "../../src/daemon.ts";',
  );
  // A test that takes the registry itself can name a module through it.
  writeFileSync(
    join(root, "tests/scenario/direct-registry.ts"),
    'import { REGISTRY } from "../../src/registry.ts";',
  );
  writeFileSync(
    join(root, "tests/core/direct-registry.test.ts"),
    'import { REGISTRY } from "../../src/registry.ts";',
  );
  // A type is erased: naming the registry's type reaches no module.
  writeFileSync(
    join(root, "tests/scenario/type-only.ts"),
    'import type { Registry } from "../../src/registry.ts";',
  );
  writeFileSync(
    join(root, "tests/scenario/direct.ts"),
    'import { d } from "../../src/chat/discord/module.ts";',
  );
  const tests = join(root, "tests");
  const src = join(root, "src");
  assert.deepEqual(importingModules("chat", tests, src, ["scenario", "core"]), [
    "core/direct-registry.test.ts",
    "scenario/direct-registry.ts",
    "scenario/direct.ts",
    "scenario/type-only.ts",
    "scenario/world.ts",
  ]);
  assert.deepEqual(
    importingModules("chat", tests, src, ["scenario", "core"], { "registry.ts": ["daemon.ts"] }),
    ["core/direct-registry.test.ts", "scenario/direct-registry.ts", "scenario/direct.ts"],
  );
});

// The rule for the chat side (#129, invariant 9): a test under `test/core/` or `test/scenario/`
// never reaches `src/chat/<module>/`, directly or through a support file such as
// `test/support/fake-slack.ts`. A test of the core through a provider lives under
// `test/chat/<module>/`; the core's tests use the memory chat and neutral ids.
// The registry is the one source file meant to import every module, and a scenario runs the
// daemon, which imports it: the scenarios pass their own registry, so the path through the daemon
// is the wiring and not a reach. A test that imports the registry itself is not exempt: it could
// name a module through `REGISTRY`. Only the registry's type is free.
const WIRING = { "registry.ts": ["daemon.ts"] };

test("no test of the core or the scenarios reaches a chat module", () => {
  assert.deepEqual(importingModules("chat", TESTS, SRC, ["core", "scenario"], WIRING), []);
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

/** The string literals of `source` outside a comment, as `line: text`. */
function stringLiterals(source: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  const lines = blank(source, { keepText: true }).split("\n");
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)) {
      found.push({ line: index + 1, text: match[2] as string });
    }
  }
  return found;
}

/** Each of `names` that `source` holds as a whole string literal outside a comment, as `line: name`. */
export function literalsNamed(source: string, names: readonly string[]): string[] {
  return stringLiterals(source)
    .filter(({ text }) => names.includes(text))
    .map(({ line, text }) => `${line}: ${text}`);
}

/** Each string literal of `source` that one of `patterns` matches whole, as `line: text`. */
export function literalsMatching(source: string, patterns: readonly RegExp[]): string[] {
  return stringLiterals(source)
    .filter(({ text }) => patterns.some((pattern) => pattern.test(text)))
    .map(({ line, text }) => `${line}: ${text}`);
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

/**
 * The source files of `src` the guards below read: those under the `layers` (`core`, `chat`), and
 * with `entry` the entry files above the layers. A layer is read whole, a module's folder
 * included: a chat module holds no word of an agent either.
 */
export function filesOf(src: string, layers: readonly string[], entry: boolean): string[] {
  const files = layers.flatMap((layer) =>
    existsSync(join(src, layer)) ? sources(join(src, layer)) : [],
  );
  if (entry) files.push(...entryFiles(src));
  return files.toSorted();
}

/**
 * The entry files: `src/host/` and the files at the top of `src/`, except the registry, which
 * names the modules by design. The daemon, the command line and the host's tooling are written
 * for any agent and any chat as much as the core.
 */
export function entryFiles(src: string): string[] {
  const top = readdirSync(src, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && entry.name !== "registry.ts")
    .map((entry) => join(src, entry.name));
  return [...top, ...(existsSync(join(src, "host")) ? sources(join(src, "host")) : [])];
}

/**
 * What `read` finds in each of `files`, as `file:hit`, without the hits `allowed` lists. A hit is
 * `line: name`; an allowlist key is `file:name` (every hit of that name in that file), and its
 * value says why the name is not a leak.
 */
export function leaks(
  src: string,
  files: readonly string[],
  read: (source: string) => string[],
  allowed: Readonly<Record<string, string>> = {},
): string[] {
  const found: string[] = [];
  for (const path of files) {
    const file = relative(src, path).split(sep).join("/");
    for (const hit of read(readFileSync(path, "utf8"))) {
      const name = hit.slice(hit.indexOf(": ") + 2);
      if (!(`${file}:${name}` in allowed)) found.push(`${file}:${hit}`);
    }
  }
  return found;
}

/** The tool-name literals of the core, the chat and the entry files that `labels` does not list. */
export function toolLeaks(
  src: string,
  names: readonly string[],
  labels: ReadonlySet<string>,
): string[] {
  const found: string[] = [];
  for (const path of filesOf(src, ["core", "chat"], true)) {
    const file = relative(src, path).split(sep).join("/");
    for (const hit of unlabelled(file, readFileSync(path, "utf8"), names, labels)) {
      found.push(`${file}:${hit}`);
    }
  }
  return found;
}

test("no source of the core, the chat or the entry files holds a tool name an agent module knows", () => {
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
  assert.deepEqual(toolLeaks(SRC, names, LABELS), []);
});

// ---- the module's own literals, the Web API's methods

/** The whole-string `literals` of every module, for the core and the entry files. */
export function moduleLiteralLeaks(src: string, literals: readonly string[]): string[] {
  return leaks(src, filesOf(src, ["core"], true), (source) => literalsNamed(source, literals));
}

/** The string literals of any file outside the modules and the registry that a `pattern` matches. */
export function patternLeaks(src: string, patterns: readonly RegExp[]): string[] {
  const homes = [...moduleDirectories(src), "registry.ts"];
  const outside = sources(src).filter((path) => {
    const file = relative(src, path).split(sep).join("/");
    return !homes.some((home) => file === home || file.startsWith(home));
  });
  return leaks(src, outside, (source) => literalsMatching(source, patterns));
}

test("a module's literals and patterns are found in the core, an entry file and the host", () => {
  const src = mkdtempSync(join(tmpdir(), "allaboard-literals-"));
  for (const directory of ["agent/codex", "chat/discord", "core", "host"]) {
    mkdirSync(join(src, directory), { recursive: true });
  }
  writeFileSync(
    join(src, "core", "a.ts"),
    'const x = { type: "blocks" }; const y = "chat.update";\n',
  );
  writeFileSync(join(src, "daemon.ts"), 'const y = "team_id"; const z = "Block Kit";\n');
  writeFileSync(join(src, "host", "h.ts"), "const t = `ts`; const u = 'channel_not_found';\n");
  // The registry, a module and a longer string are not the literal.
  writeFileSync(join(src, "registry.ts"), 'const r = "blocks";\n');
  writeFileSync(
    join(src, "chat", "discord", "m.ts"),
    'const r = "blocks"; const c = "chat.update";\n',
  );
  writeFileSync(join(src, "core", "b.ts"), 'const r = "three blocks"; const f = "tsc";\n');
  const slack = REGISTRY.chats.slack?.words as ModuleWords;
  assert.deepEqual(moduleLiteralLeaks(src, slack.literals), [
    "core/a.ts:1: blocks",
    "core/a.ts:1: chat.update",
    "daemon.ts:1: team_id",
    "daemon.ts:1: Block Kit",
    "host/h.ts:1: ts",
    "host/h.ts:1: channel_not_found",
  ]);
  // A Web API method is caught anywhere outside the modules, the seams and the core's strings too.
  assert.deepEqual(patternLeaks(src, slack.patterns), ["core/a.ts:1: chat.update"]);
  writeFileSync(
    join(src, "chat", "seam.ts"),
    'const m = "views.open"; const f = "files.json5x";\n',
  );
  assert.deepEqual(patternLeaks(src, slack.patterns), [
    "chat/seam.ts:1: views.open",
    "chat/seam.ts:1: files.json5x",
    "core/a.ts:1: chat.update",
  ]);
});

test("the core and the entry files hold no literal a module declares", () => {
  const literals = declaredWords().flatMap((words) => words.literals);
  for (const audited of ["chat.update", "blocks", "team_id", "ts", "channel_not_found"]) {
    assert.ok(literals.includes(audited), audited);
  }
  assert.ok(literals.includes("reaction_added") && literals.includes("Block Kit"));
  assert.deepEqual(moduleLiteralLeaks(SRC, literals), []);
});

test("no source outside the modules names a method of a chat's Web API", () => {
  const patterns = declaredWords().flatMap((words) => words.patterns);
  assert.ok(patterns.length > 0);
  assert.deepEqual(patternLeaks(SRC, patterns), []);
});

test("a module declares its words, and they are lists", () => {
  for (const entry of [...Object.values(REGISTRY.agents), ...Object.values(REGISTRY.chats)]) {
    assert.ok(Array.isArray(entry.words.names));
    assert.ok(Array.isArray(entry.words.literals));
    assert.ok(Array.isArray(entry.words.patterns));
  }
  // The libraries and the vendor's name moved from the central list into the modules.
  assert.ok(REGISTRY.agents.claude?.words.names.includes("anthropic"));
  assert.ok(REGISTRY.chats.slack?.words.names.includes("threadTs"));
});

// ---- the agent's SDK: its names, its model aliases, its commands

const IDENTIFIER = /^[A-Za-z_][\w-]*$/;

/** The identifiers of `source` outside a comment, hyphenated ones (`task-notification`) whole. */
function tokens(source: string): { line: number; token: string }[] {
  const found: { line: number; token: string }[] = [];
  for (const [index, line] of blank(source, { keepText: true }).split("\n").entries()) {
    for (const match of line.matchAll(/[A-Za-z_$][\w$-]*/g)) {
      found.push({ line: index + 1, token: match[0] });
    }
  }
  return found;
}

/**
 * The names of the SDK that no plain English word could be: those of `rows` (the member, a
 * quoted value without its quotes) with an underscore, a hyphen, a capital inside or two capitals
 * at the start, and the SDK types `aside` sets aside. A name the agent seam also holds (`contract`:
 * `sessionId`, `task_started`) is the seam's own word and is left out. `SDK` followed by a capital
 * is forbidden whatever the table lists (`isSdkType`).
 */
export function sdkNames(
  rows: readonly Row[],
  aside: readonly string[],
  contract: string,
): Set<string> {
  const seam = new Set(tokens(contract).map(({ token }) => token));
  const names = new Set<string>(aside);
  for (const row of rows) {
    const member = /^"(.*)"$/.exec(row.member)?.[1] ?? row.member;
    const distinct =
      /[_-]/.test(member) || /[a-z0-9][A-Z]/.test(member) || /^[A-Z]{2,}/.test(member);
    if (IDENTIFIER.test(member) && distinct) names.add(member);
  }
  return new Set([...names].filter((name) => !seam.has(name)));
}

function isSdkType(token: string): boolean {
  return /^SDK[A-Z]/.test(token);
}

/** Each token of `source` that is in `forbidden`, or an SDK type by its name, as `line: token`. */
export function sdkNamed(source: string, forbidden: ReadonlySet<string>): string[] {
  return tokens(source)
    .filter(({ token }) => forbidden.has(token) || isSdkType(token))
    .map(({ line, token }) => `${line}: ${token}`);
}

/** The SDK names held by the core, the chat and the entry files, outside `allowed`. */
export function sdkLeaks(
  src: string,
  forbidden: ReadonlySet<string>,
  allowed: Readonly<Record<string, string>>,
): string[] {
  return leaks(src, filesOf(src, ["core", "chat"], true), (s) => sdkNamed(s, forbidden), allowed);
}

// A name of the SDK's table that the core or a chat module holds and that is not the SDK's, by
// file and name: every hit of that name in that file passes.
const SDK_ALLOWED: Readonly<Record<string, string>> = {
  "core/state.ts:session_id": "the key of `state.json` (invariant 3), the core's own file format",
  "chat/slack/reply/blocks.ts:task_id": "the field of Slack's `task_card` block",
  "chat/slack/repair.ts:task_id":
    "the field of Slack's `task_card` block, read back from a message",
};

function claudeSdkNames(): Set<string> {
  return sdkNames(loadSurface(), setAside(), readFileSync(join(SRC, "agent", "seam.ts"), "utf8"));
}

test("the SDK's names are read from the surface table, minus the seam's own and plain words", () => {
  const rows: Row[] = ["session_id", '"stream_event"', "plan", '"high"', "toolUseID"].map(
    (member) => ({
      owner: "Owner",
      member,
      kind: "key",
      usedIn: [],
      source: "package",
      claims: [],
    }),
  );
  const names = sdkNames(rows, ["SDKOddMessage"], "interface S { session_id: string }");
  assert.deepEqual([...names].toSorted(), ["SDKOddMessage", "stream_event", "toolUseID"]);
  // The real table gives the names the audit put in the core without a guard noticing.
  const real = claudeSdkNames();
  for (const audited of ["bypassPermissions", "compact_boundary", "parent_tool_use_id"]) {
    assert.ok(real.has(audited), audited);
  }
  // A seam word and plain English are not in it.
  for (const plain of ["sessionId", "text", "plan", "default", "high", "user", "result"]) {
    assert.ok(!real.has(plain), plain);
  }
});

test("an SDK name in the core, the chat or an entry file is found, and an allowed one is not", () => {
  const src = mkdtempSync(join(tmpdir(), "allaboard-sdk-"));
  for (const directory of ["core", "chat/discord", "host", "agent/codex"]) {
    mkdirSync(join(src, directory), { recursive: true });
  }
  const forbidden = new Set(["bypassPermissions", "compact_boundary", "parent_tool_use_id"]);
  writeFileSync(join(src, "core", "a.ts"), 'const m = "bypassPermissions";\nlet SDKMessage;\n');
  writeFileSync(join(src, "core", "b.ts"), "const e = { parent_tool_use_id: null };\n");
  writeFileSync(join(src, "chat", "discord", "c.ts"), 'if (kind === "compact_boundary") {}\n');
  writeFileSync(
    join(src, "cli.ts"),
    "// parent_tool_use_id in a comment\nconst k = 'compact_boundary';\n",
  );
  writeFileSync(join(src, "host", "h.ts"), "const k = parent_tool_use_id;\n");
  writeFileSync(join(src, "agent", "codex", "m.ts"), 'const a = "bypassPermissions";\n');
  assert.deepEqual(sdkLeaks(src, forbidden, {}), [
    "chat/discord/c.ts:1: compact_boundary",
    "cli.ts:2: compact_boundary",
    "core/a.ts:1: bypassPermissions",
    "core/a.ts:2: SDKMessage",
    "core/b.ts:1: parent_tool_use_id",
    "host/h.ts:1: parent_tool_use_id",
  ]);
  assert.deepEqual(sdkLeaks(src, forbidden, { "core/b.ts:parent_tool_use_id": "test" }).length, 5);
});

test("the core, the chat and the entry files hold no name of the agent's SDK", () => {
  assert.deepEqual(sdkLeaks(SRC, claudeSdkNames(), SDK_ALLOWED), []);
  // Every allowance is used: a name that left the file takes its line out of the list.
  const names = claudeSdkNames();
  const withoutAllowance = sdkLeaks(SRC, names, {});
  for (const key of Object.keys(SDK_ALLOWED)) {
    const [file, name] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    assert.ok(
      withoutAllowance.some((hit) => hit.startsWith(`${file}:`) && hit.endsWith(`: ${name}`)),
      key,
    );
  }
});

/** The model aliases a recorded model list of the agent holds, but for the default one. */
export function modelAliases(list: { value: string }[]): string[] {
  return list
    .map((model) => model.value)
    .filter((v) => v !== "default" && !v.startsWith("claude-"));
}

test("the core, the chat and the entry files hold no model alias of the agent", () => {
  const recorded = JSON.parse(
    readFileSync(join(TESTS, "fixtures", "sdk", "server-info.json"), "utf8"),
  ) as { models: { value: string }[] };
  const aliases = modelAliases(recorded.models);
  assert.ok(aliases.includes("opus"), "the recording lists the alias the audit used");
  const found = leaks(SRC, filesOf(SRC, ["core", "chat"], true), (s) => literalsNamed(s, aliases));
  assert.deepEqual(found, []);
  const src = mkdtempSync(join(tmpdir(), "allaboard-alias-"));
  mkdirSync(join(src, "core"), { recursive: true });
  writeFileSync(join(src, "core", "m.ts"), 'const model = "opus";\n');
  assert.deepEqual(
    leaks(src, filesOf(src, ["core"], false), (s) => literalsNamed(s, aliases)),
    ["core/m.ts:1: opus"],
  );
});

/**
 * The strings of an agent's `AgentWords` that no file of the core or the chat holds whole: the
 * names of its commands behind its prefix (`/compact`, `/clear`), and the bare names of the
 * commands it has a word of its own for. The bare names of `notOffered` are not listed: they are
 * plain English (`memory`, `diff`) and several are the core's own `!` words. `offered` are the
 * names of the commands the agent's recorded session lists, which `AgentWords` does not: they
 * too are held only behind the prefix.
 */
export function agentLiterals(words: AgentWords, offered: readonly string[] = []): string[] {
  const named = [
    ...offered,
    ...words.newSession,
    ...(words.login === null ? [] : [words.login]),
    ...(words.logout === null ? [] : [words.logout]),
    ...Object.keys(words.notOffered),
    ...(words.goalClear === null ? [] : [words.goalClear]),
  ];
  const bare = [
    ...words.newSession,
    ...(words.login === null ? [] : [words.login]),
    ...(words.logout === null ? [] : [words.logout]),
    ...(words.goalClear === null ? [] : [words.goalClear]),
  ];
  return [...new Set([...named.map((name) => words.commandPrefix + name), ...bare])];
}

/** The `AgentWords` literals held by the core and the chat, outside `allowed`. */
export function agentWordLeaks(
  src: string,
  literals: readonly string[],
  allowed: Readonly<Record<string, string>>,
): string[] {
  return leaks(
    src,
    filesOf(src, ["core", "chat"], true),
    (s) => literalsNamed(s, literals),
    allowed,
  );
}

// A bare word of the agent's commands that the core also uses as plain English or as its own
// field name, by file and word: every literal of that word in that file passes.
const WORDS_ALLOWED: Readonly<Record<string, string>> = {
  "core/sessions/session.ts:new": "the status line's placeholder for a session with no id yet",
  "core/texts.ts:login":
    "a field name of the texts filled with the agent's words (`AgentWords.login`)",
  "core/texts.ts:logout":
    "a field name of the texts filled with the agent's words (`AgentWords.logout`)",
};

function registeredAgentWords(): AgentWords[] {
  return Object.values(REGISTRY.agents).map(
    (entry) => entry.build({ variables: {}, clock: systemClock }).words,
  );
}

test("the strings of an agent's AgentWords are found in the core and the chat", () => {
  const words = {
    newSession: ["clear"],
    login: "login",
    logout: null,
    goalClear: "goal clear",
    commandPrefix: "/",
    notOffered: { rewind: null, memory: null },
  } as unknown as AgentWords;
  assert.deepEqual(agentLiterals(words).toSorted(), [
    "/clear",
    "/goal clear",
    "/login",
    "/memory",
    "/rewind",
    "clear",
    "goal clear",
    "login",
  ]);
  const src = mkdtempSync(join(tmpdir(), "allaboard-agent-words-"));
  for (const directory of ["core", "chat"]) mkdirSync(join(src, directory), { recursive: true });
  writeFileSync(
    join(src, "core", "c.ts"),
    'const a = "/compact"; const b = "/clear"; const c = "clear";\n',
  );
  writeFileSync(join(src, "chat", "seam.ts"), "const d = `/rewind`; const e = '!clear';\n");
  const literals = agentLiterals(words, ["compact"]);
  assert.ok(literals.includes("/compact") && !literals.includes("compact"));
  assert.deepEqual(agentWordLeaks(src, literals, {}), [
    "chat/seam.ts:1: /rewind",
    "core/c.ts:1: /compact",
    "core/c.ts:1: /clear",
    "core/c.ts:1: clear",
  ]);
  assert.deepEqual(agentWordLeaks(src, literals, { "core/c.ts:clear": "test" }).length, 3);
});

test("the core and the chat hold none of the strings an agent's AgentWords declare", () => {
  const recorded = JSON.parse(
    readFileSync(join(TESTS, "fixtures", "sdk", "server-info.json"), "utf8"),
  ) as { commands: { name: string; aliases?: string[] }[] };
  const offered = recorded.commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
  const literals = registeredAgentWords().flatMap((words) => agentLiterals(words, offered));
  for (const audited of ["/compact", "/clear", "/login", "clear", "logout"]) {
    assert.ok(literals.includes(audited), audited);
  }
  assert.deepEqual(agentWordLeaks(SRC, literals, WORDS_ALLOWED), []);
  // Every allowance is used: a word that left the file takes its line out of the list.
  const unallowed = agentWordLeaks(SRC, literals, {});
  for (const key of Object.keys(WORDS_ALLOWED)) {
    const at = key.indexOf(":");
    assert.ok(
      unallowed.some(
        (h) => h.startsWith(`${key.slice(0, at)}:`) && h.endsWith(`: ${key.slice(at + 1)}`),
      ),
      key,
    );
  }
});

test("the scan reaches an agent module from a scenario, except through the daemon's registry", () => {
  const root = mkdtempSync(join(tmpdir(), "allaboard-scenario-"));
  for (const directory of ["src/agent/codex", "src/chat", "tests/scenario"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  writeFileSync(join(root, "src/registry.ts"), 'import { c } from "./agent/codex/module.ts";');
  writeFileSync(join(root, "src/daemon.ts"), 'import { r } from "./registry.ts";');
  writeFileSync(
    join(root, "tests/scenario/world.ts"),
    'import { run } from "../../src/daemon.ts";',
  );
  writeFileSync(
    join(root, "tests/scenario/own.ts"),
    'import { c } from "../../src/agent/codex/module.ts";',
  );
  const wiring = { "registry.ts": ["daemon.ts"] };
  const tests = join(root, "tests");
  const src = join(root, "src");
  assert.deepEqual(importingModules("agent", tests, src, ["scenario"], wiring), [
    "scenario/own.ts",
  ]);
  assert.deepEqual(importingModules("agent", tests, src, ["scenario"]), [
    "scenario/own.ts",
    "scenario/world.ts",
  ]);
});

// ---- Slack-shaped ids in the tests of the core and the scenarios

// A message timestamp (`1700000000.000100`) and an id of a user, channel, team, workspace or bot
// (`U000ALICE`, `C000CHAN`): the tests of the core use the neutral ids of `test/support/ids.ts`.
const SLACK_IDS = [/\b\d{10}\.\d{6}\b/, /\b[UCTWB]0[0-9A-Z]{6,}\b/];

/** Each Slack-shaped id in `source` outside a comment, as `line: id`. */
export function slackIds(source: string): string[] {
  const found: string[] = [];
  for (const [index, line] of blank(source, { keepText: true }).split("\n").entries()) {
    for (const pattern of SLACK_IDS) {
      const match = new RegExp(pattern, "g");
      for (const hit of line.matchAll(match)) found.push(`${index + 1}: ${hit[0]}`);
    }
  }
  return found;
}

test("a Slack timestamp and a Slack id are found, and the neutral ids are not", () => {
  assert.deepEqual(slackIds('const t = "1700000000.000100"; const u = "U000ALICE";'), [
    "1: 1700000000.000100",
    "1: U000ALICE",
  ]);
  assert.deepEqual(slackIds("const c = `C000CHAN`; // T000TEAM"), ["1: C000CHAN"]);
  assert.deepEqual(slackIds('const c = "chan-1"; const m = "msg-1"; const v = "1.2.3.4";'), []);
});

test("no test of the core or the scenarios holds a Slack timestamp or id", () => {
  const found: string[] = [];
  for (const layer of ["core", "scenario"]) {
    for (const path of sources(join(TESTS, layer))) {
      const file = relative(TESTS, path).split(sep).join("/");
      for (const hit of slackIds(readFileSync(path, "utf8"))) found.push(`${file}:${hit}`);
    }
  }
  assert.deepEqual(found, []);
});
