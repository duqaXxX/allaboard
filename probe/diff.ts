/**
 * What a release of `@anthropic-ai/claude-agent-sdk` adds or removes, beside what it could change:
 * two `sdk.d.ts` texts compared name by name, and the names matched against the `Rests on` cells
 * of `docs/limits.md` and `docs/features.md` (the SDK names and `/commands` a row depends on).
 *
 * Pure over text: it reads with the `Declarations` reader of `surface.ts`, which needs no compiler.
 * A match is a candidate for a person to look at (a limit may have fallen, a feature may break),
 * never a verdict, and a run's exit status does not depend on it.
 */
import { Declarations, groupMembers, operands, withoutComments } from "./surface.ts";

export const CATEGORIES = ["declaration", "member", "SDKMessage member", "system subtype"] as const;
export type Category = (typeof CATEGORIES)[number];

/** The names of one release, by category. */
export type Surface = Readonly<Record<Category, ReadonlySet<string>>>;

/** Names added to and removed from the SDK, by category. */
export type SurfaceDiff = Readonly<Record<Category, { added: string[]; removed: string[] }>>;

const EXPORTED =
  /^export\s+declare\s+(?:abstract\s+)?(?:type|interface|class|function|const|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm;
const SYSTEM = /\btype:\s*'system'/;
const SUBTYPE = /\bsubtype:\s*'([^']+)'/;

/**
 * The names a `sdk.d.ts` declares: every exported declaration, the members of each as
 * `Type.member` (`Options.model`, `Query.interrupt`), the types `SDKMessage` is a union of, and the `subtype` of each of those that is a
 * system message (`system:task_started`). A category the text does not declare is empty.
 */
export function readSurface(text: string): Surface {
  const declarations = new Declarations(text);
  const found: Record<Category, Set<string>> = {
    declaration: new Set(),
    member: new Set(),
    "SDKMessage member": new Set(),
    "system subtype": new Set(),
  };
  for (const match of withoutComments(text).matchAll(EXPORTED)) {
    found.declaration.add(match[1] ?? "");
  }
  // A member of an object type or an interface, as `Type.member`: a row that names the type is
  // looked at when the type gains or loses one. Unions and intersections hold none of their own.
  for (const name of found.declaration) {
    for (const key of groupMembers(declarations.rightSide(name)).keys()) {
      found.member.add(`${name}.${key}`);
    }
  }
  for (const member of operands(declarations.rightSide("SDKMessage"))) {
    if (!declarations.has(member)) continue;
    found["SDKMessage member"].add(member);
    const block = declarations.block(member) ?? "";
    const subtype = SYSTEM.test(block) ? SUBTYPE.exec(block)?.[1] : undefined;
    if (subtype !== undefined) found["system subtype"].add(`system:${subtype}`);
  }
  return found;
}

/** The names `after` has and `before` lacks, and the other way, sorted, by category. */
export function diffSurface(before: Surface, after: Surface): SurfaceDiff {
  const gap = (from: ReadonlySet<string>, other: ReadonlySet<string>) =>
    [...from].filter((name) => !other.has(name)).sort();
  const entries = CATEGORIES.map((category) => [
    category,
    {
      added: gap(after[category], before[category]),
      removed: gap(before[category], after[category]),
    },
  ]);
  return Object.fromEntries(entries) as SurfaceDiff;
}

/** A `Rests on` cell read without throwing: the names, or why the cell cannot be read. */
export function readRests(cell: string, row: string): { names: string[]; error: string | null } {
  try {
    return { names: restsOn(cell, row), error: null };
  } catch (error) {
    return { names: [], error: error instanceof Error ? error.message : String(error) };
  }
}

const NAME = /^(?:\/[a-z][a-z-]*|system:\w+|[A-Za-z_$][\w$]*(?:\.[\w$]+)*)$/;

/**
 * The names of a `Rests on` cell: backticked SDK names (`Options.model`, `SDKTaskStartedMessage`,
 * `system:task_started`) and `/commands`, joined by commas; an empty cell names none. Throws on
 * any other text, so a cell nobody can match never passes as one that rests on nothing.
 */
export function restsOn(cell: string, row: string): string[] {
  if (cell === "") return [];
  const names = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
  const rest = cell.replace(/`[^`]+`/g, "").replace(/[,\s]/g, "");
  if (names.length === 0 || rest !== "" || !names.every((name) => NAME.test(name))) {
    throw new RangeError(
      `${row.slice(0, 60)}: the Rests on cell '${cell}' is not backticked names`,
    );
  }
  return names;
}

/**
 * Whether `readSurface(text)` yields `name` in any category: a declared type or function, a
 * `Type.member`, an `SDKMessage` member or a `system:subtype`. A `/command` is not a declaration:
 * it is checked against the commands.
 */
export function declares(text: string, name: string): boolean {
  const surface = readSurface(text);
  return CATEGORIES.some((category) => surface[category].has(name));
}

/** A row of a table that names what it rests on: a limit or a feature. */
export interface Resting {
  readonly name: string;
  /** A row of `docs/features.md`: an added name asks to check the row, not to lift a limit. */
  readonly feature?: boolean;
  /** SDK names and `/commands`, as the `Rests on` cell wrote them (the slash kept). */
  readonly restsOn: readonly string[];
}

export interface Match {
  readonly row: string;
  readonly name: string;
  readonly kind: "may now be supported" | "added: check this row" | "may break";
  /** True when the row names the owner type (`Options`) of the name, not the name itself. */
  readonly prefix: boolean;
}

/** The part of `Options.key` before the dot; the name itself when it has none. */
function ownerOf(name: string): string {
  return name.split(".")[0] ?? name;
}

/**
 * The rows a change could touch. An added name, or a new command, that a row names is
 * "may now be supported"; a removed one, or a gone command, "may break". A row that names only
 * the owner type of a changed `Owner.member` matches as a prefix. Candidates, never verdicts.
 */
export function matches(
  rows: readonly Resting[],
  diff: SurfaceDiff,
  commands: { readonly new: readonly string[]; readonly gone: readonly string[] },
): Match[] {
  const added = [
    ...CATEGORIES.flatMap((category) => diff[category].added),
    ...commands.new.map((name) => `/${name}`),
  ];
  const removed = [
    ...CATEGORIES.flatMap((category) => diff[category].removed),
    ...commands.gone.map((name) => `/${name}`),
  ];
  const out: Match[] = [];
  // A message type is both a declaration and an SDKMessage member: one line per row and name.
  const seen = new Set<string>();
  const look = (names: string[], removedNames: boolean) => {
    for (const row of rows) {
      const kind: Match["kind"] = removedNames
        ? "may break"
        : row.feature
          ? "added: check this row"
          : "may now be supported";
      for (const name of names) {
        const exact = row.restsOn.includes(name);
        const prefix = !exact && name.includes(".") && row.restsOn.includes(ownerOf(name));
        const key = `${row.name}\0${name}\0${kind}`;
        if ((!exact && !prefix) || seen.has(key)) continue;
        seen.add(key);
        out.push({ row: row.name, name, kind, prefix });
      }
    }
  };
  look(added, false);
  look(removed, true);
  return out;
}

/** A row name cut at a word near 80 characters. */
function short(name: string): string {
  if (name.length <= 80) return name;
  const cut = name.slice(0, 80);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 40 ? cut.lastIndexOf(" ") : 80)}...`;
}

/** Whether the diff holds any name. */
export function isEmpty(diff: SurfaceDiff): boolean {
  return CATEGORIES.every((category) => {
    const { added, removed } = diff[category];
    return added.length === 0 && removed.length === 0;
  });
}

/** The block a run prints after the claims; empty when nothing was added, removed or matched. */
export function report(diff: SurfaceDiff, found: readonly Match[]): string {
  if (isEmpty(diff) && found.length === 0) return "";
  const lines: string[] = [];
  for (const [title, key] of [
    ["Added to the SDK", "added"],
    ["Removed from the SDK", "removed"],
  ] as const) {
    const parts = CATEGORIES.filter((category) => diff[category][key].length > 0);
    if (parts.length === 0) continue;
    if (lines.length > 0) lines.push("");
    lines.push(`${title}:`);
    for (const category of parts) {
      lines.push(`  ${category} (${diff[category][key].length})`);
      for (const name of diff[category][key]) lines.push(`    ${name}`);
    }
  }
  if (found.length > 0) {
    lines.push("", "Rows that rest on what changed (candidates, look at each):");
    for (const match of found) {
      const how = match.prefix ? `${match.name}, same owner as a name it rests on` : match.name;
      lines.push(`  ${match.kind}: "${short(match.row)}" (${how})`);
    }
  }
  return lines.join("\n");
}
