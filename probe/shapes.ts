/**
 * The shape of Claude Code's stream against the fixtures'. A shape is, per kind of
 * record, the set of key paths with the type of their value; content and order do not count.
 * A run's stream that carries a kind, a path or a tool no fixture shows and
 * `accepted-shapes.json` does not accept is a difference, and a difference stops the
 * certificate: the tests have never read that shape.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../src/values.ts";

/** Per kind of record, the paths its records carry: `message.content[].type:string`. */
export type Shapes = Map<string, Set<string>>;

/** What a stream's shape adds to the fixtures', one entry per kind, path or tool. */
export type Difference =
  | { readonly what: "kind"; readonly kind: string }
  | { readonly what: "path"; readonly kind: string; readonly path: string }
  | { readonly what: "tool"; readonly name: string };

/** The differences accepted so far, each with the Claude Code version it was accepted on. */
export interface Accepted {
  readonly kinds: Readonly<Record<string, string>>;
  readonly paths: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly tools: Readonly<Record<string, string>>;
}

export const FIXTURES = join(import.meta.dirname, "..", "test", "fixtures", "sdk");
export const ACCEPTED = join(import.meta.dirname, "accepted-shapes.json");

// Objects whose keys are data, not names: a tool call's id, a model, a question's text, an agent
// type. Their keys read as `*`, else every run would add paths.
const MAPS = new Set(["wire_tool_inputs", "modelUsage", "answers", "tool_uses", "by_type"]);
const ID = /^(toolu_|srvtoolu_)/;
// A tool of an MCP server is the owner's or the folder's configuration, not the SDK's shape:
// a claude.ai connector shows in one run and not in the next.
const MCP_TOOL = "mcp__";

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function addPaths(value: unknown, prefix: string, into: Set<string>, keysAreData = false): void {
  if (Array.isArray(value)) {
    for (const item of value) addPaths(item, `${prefix}[]`, into);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const name = keysAreData || ID.test(key) ? "*" : key;
    const path = prefix ? `${prefix}.${name}` : name;
    into.add(`${path}:${typeOf(item)}`);
    addPaths(item, path, into, MAPS.has(key));
  }
}

/** The kind of a record: its type and subtype, a stream event's type and its block's or delta's. */
export function kindOf(record: Readonly<Record<string, unknown>>): string {
  const parts = [record.type, record.subtype];
  const event = record.event;
  if (isRecord(event)) {
    parts.push(event.type);
    for (const key of ["delta", "content_block"]) {
      const inner = event[key];
      if (isRecord(inner)) parts.push(inner.type);
    }
  }
  return parts.filter((part) => part !== undefined && part !== "").join("/");
}

/** The shapes of a stream's records, and the tools its `system/init` records list. */
export function shapesOf(records: Iterable<unknown>): { shapes: Shapes; tools: Set<string> } {
  const shapes: Shapes = new Map();
  const tools = new Set<string>();
  for (const record of records) {
    if (!isRecord(record)) continue;
    const kind = kindOf(record);
    let paths = shapes.get(kind);
    if (paths === undefined) {
      paths = new Set();
      shapes.set(kind, paths);
    }
    addPaths(record, "", paths);
    if (record.type === "system" && record.subtype === "init" && Array.isArray(record.tools)) {
      for (const tool of record.tools) {
        if (typeof tool === "string" && !tool.startsWith(MCP_TOOL)) tools.add(tool);
      }
    }
  }
  return { shapes, tools };
}

/** Every record of the stream fixtures named (every one when none is), in file order. */
export function fixtureRecords(folder = FIXTURES, names?: readonly string[]): unknown[] {
  const records: unknown[] = [];
  for (const name of readdirSync(folder)
    .filter((file) => file.endsWith(".jsonl"))
    .filter((file) => names === undefined || names.includes(file.slice(0, -".jsonl".length)))
    .sort()) {
    for (const line of readFileSync(join(folder, name), "utf8").split("\n")) {
      if (line.trim()) records.push(JSON.parse(line));
    }
  }
  return records;
}

const VERSION = /^\d+\.\d+\.\d+$/;

function versions(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) && Object.values(value).every((v) => typeof v === "string" && VERSION.test(v))
  );
}

/** `accepted-shapes.json`; throws on a file that is not its shape, before a run spends tokens. */
export function loadAccepted(path = ACCEPTED): Accepted {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !isRecord(value) ||
    !versions(value.kinds) ||
    !versions(value.tools) ||
    !isRecord(value.paths) ||
    !Object.values(value.paths).every(versions)
  ) {
    throw new Error(`${path}: kinds, paths and tools must map names to Claude Code versions`);
  }
  return value as unknown as Accepted;
}

// A null says the field is there and nothing of its type: it is covered by any type the path is
// known with, so a field that is null on one run and set on another is no difference by itself.
function covered(
  path: string,
  known: ReadonlySet<string>,
  allowed: Readonly<Record<string, string>>,
): boolean {
  if (known.has(path) || path in allowed) return true;
  if (!path.endsWith(":null")) return false;
  const name = path.slice(0, -"null".length);
  return [...known, ...Object.keys(allowed)].some((other) => other.startsWith(name));
}

/**
 * What the live stream carries that neither the fixtures nor `accepted` show, sorted. Only this
 * direction is checked: a kind or path the fixtures have and a run did not produce may be one
 * the run's scenes never caused.
 */
export function differences(
  live: Iterable<unknown>,
  recorded: Iterable<unknown>,
  accepted: Accepted,
): Difference[] {
  const now = shapesOf(live);
  const then = shapesOf(recorded);
  const found: Difference[] = [];
  for (const name of [...now.tools].sort()) {
    if (!then.tools.has(name) && !(name in accepted.tools)) found.push({ what: "tool", name });
  }
  for (const kind of [...now.shapes.keys()].sort()) {
    const known = then.shapes.get(kind);
    if (known === undefined && !(kind in accepted.kinds)) {
      found.push({ what: "kind", kind });
      continue;
    }
    // A path under a new kind is that kind's: the kind is the one difference, or accepted.
    if (known === undefined) continue;
    const allowed = accepted.paths[kind] ?? {};
    for (const path of [...(now.shapes.get(kind) ?? [])].sort()) {
      if (!covered(path, known, allowed)) found.push({ what: "path", kind, path });
    }
  }
  return found;
}

/** The entries `accepted-shapes.json` would need to accept `found` on Claude Code `cli`. */
export function acceptance(found: readonly Difference[], cli: string): Accepted {
  const kinds: Record<string, string> = {};
  const paths: Record<string, Record<string, string>> = {};
  const tools: Record<string, string> = {};
  for (const difference of found) {
    if (difference.what === "kind") kinds[difference.kind] = cli;
    else if (difference.what === "tool") tools[difference.name] = cli;
    else paths[difference.kind] = { ...paths[difference.kind], [difference.path]: cli };
  }
  return { kinds, paths, tools };
}

/** The differences as the probe prints them, with what to do about each. */
export function shapesReport(found: readonly Difference[], cli: string): string {
  if (found.length === 0) {
    return `Stream shapes (Claude Code ${cli}): every kind, path and tool the run produced is in the fixtures or accepted.`;
  }
  const lines = found.map((difference) => {
    if (difference.what === "kind") return `  + kind ${difference.kind}`;
    if (difference.what === "tool") return `  + tool ${difference.name}`;
    return `  + ${difference.kind} ${difference.path}`;
  });
  return [
    `Stream shapes (Claude Code ${cli}): ${found.length} not in the fixtures.`,
    "",
    ...lines,
    "",
    "  For each: if the source reads it, record its fixture again (docs/sdk-surface.md);",
    "  if it does not, accept it in probe/accepted-shapes.json with these entries:",
    "",
    JSON.stringify(acceptance(found, cli), null, 2)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
  ].join("\n");
}

/** A path a fixture holds under a kind the live stream also produced, and the live one does not. */
export interface Missing {
  readonly kind: string;
  readonly path: string;
}

// A path inside a list whose items the live stream never showed: an empty list says nothing of
// its items' fields (the MCP servers of a session started with the connectors off).
function inEmptyList(name: string, names: readonly string[]): boolean {
  for (let at = name.indexOf("[]"); at !== -1; at = name.indexOf("[]", at + 2)) {
    const items = name.slice(0, at + 2);
    if (!names.some((other) => other.startsWith(items))) return true;
  }
  return false;
}

/**
 * The other direction, for a run that reproduces `recorded`: under every kind both produced, the
 * paths the fixtures hold that the live stream has under no type. A warning, not a difference:
 * a field absent from one run may only be one the run did not cause.
 */
export function missing(live: Iterable<unknown>, recorded: Iterable<unknown>): Missing[] {
  const now = shapesOf(live).shapes;
  const then = shapesOf(recorded).shapes;
  const found: Missing[] = [];
  for (const [kind, paths] of [...then].sort(([a], [b]) => a.localeCompare(b))) {
    const seen = now.get(kind);
    if (seen === undefined) continue;
    const names = [...seen].map((path) => path.slice(0, path.lastIndexOf(":")));
    const named = new Set(names);
    for (const path of [...paths].sort()) {
      const name = path.slice(0, path.lastIndexOf(":"));
      if (named.has(name) || inEmptyList(name, names)) continue;
      found.push({ kind, path });
    }
  }
  return found;
}
