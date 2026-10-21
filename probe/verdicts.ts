/**
 * What a release did to each claim, against the newest certified release before it.
 *
 * A claim's outcome says whether its behaviour held; `seen` says what it held on. Kept per
 * release in `probe/observations/<sdk version>.json`, the facts of one release are the baseline
 * of the next: the same outcome with other facts is a change a person reads before pinning. The
 * probe does not judge a change better or worse.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Fact, Facts, Result } from "./claims.ts";

export type Case =
  | "changed"
  | "no longer supported"
  | "newly supported"
  | "not proven"
  | "no baseline"
  | "unchanged"
  | "retired";

/** The order the report lists the cases in: what needs a reader first. */
export const CASES: readonly Case[] = [
  "changed",
  "no longer supported",
  "newly supported",
  "not proven",
  "no baseline",
  "unchanged",
  "retired",
];

/** The facts each claim saw on a release that was certified. */
export interface Observations {
  readonly cli: string;
  readonly date: string;
  readonly claims: { readonly [id: string]: Facts };
}

export interface Verdict {
  readonly result: Result;
  readonly case: Case;
  /** One line per fact that differs from the baseline; empty unless the case is `changed`. */
  readonly diff: readonly string[];
}

function isFacts(value: unknown): value is Facts {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The leaves of `facts` by dotted path; an array is one leaf, written as JSON. */
function leaves(facts: Facts, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(facts)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isFacts(value)) {
      const inner = leaves(value, path);
      // An empty record is a leaf too: its absence is a difference.
      if (inner.size === 0) out.set(path, "{}");
      for (const [name, text] of inner) out.set(name, text);
    } else {
      // Sorted as the file stores it, so an array of records equals its stored copy.
      out.set(path, JSON.stringify(sortedKeys(value satisfies Fact)));
    }
  }
  return out;
}

/** The facts of `after` that differ from `before`, one line each: `+` added, `-` removed, `~` changed. */
export function diffFacts(before: Facts, after: Facts): string[] {
  const was = leaves(before);
  const now = leaves(after);
  const lines: string[] = [];
  for (const path of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    const old = was.get(path);
    const next = now.get(path);
    if (old === next) continue;
    if (old === undefined) lines.push(`+ ${path} = ${next}`);
    else if (next === undefined) lines.push(`- ${path} (was ${old})`);
    else lines.push(`~ ${path}: ${old} -> ${next}`);
  }
  return lines;
}

/**
 * Each result as one of the cases, against `baseline` (null: that release has no stored
 * observations, or no release is certified before this one). A HOLDS the baseline holds nothing for is `no baseline`, never `unchanged`.
 */
export function classify(results: readonly Result[], baseline: Observations | null): Verdict[] {
  return results.map((result) => {
    if (result.outcome === "RETIRED") return { result, case: "retired", diff: [] };
    if (result.outcome === "BROKEN") return { result, case: "no longer supported", diff: [] };
    // A limit that no longer holds is a gain: the page of limits changes, nothing is broken.
    if (result.outcome === "FELL") return { result, case: "newly supported", diff: [] };
    if (result.outcome === "UNPROVEN") return { result, case: "not proven", diff: [] };
    const before = baseline?.claims[result.claim.id];
    if (before === undefined) return { result, case: "no baseline", diff: [] };
    const diff = diffFacts(before, result.seen);
    return diff.length === 0
      ? { result, case: "unchanged", diff }
      : { result, case: "changed", diff };
  });
}

/** What a certified run keeps: the facts of every claim that holds, by id. */
export function observationsOf(
  results: readonly Result[],
  cli: string,
  date: string,
): Observations {
  const claims = Object.fromEntries(
    results.filter((r) => r.outcome === "HOLDS").map((r) => [r.claim.id, r.seen]),
  );
  return { cli, date, claims };
}

/** `value` with the keys of every record sorted, so a file is the same on every run. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, inner]) => [key, sortedKeys(inner)]),
  );
}

/** Claim ids in their number order, `P` before `L`: `P2` before `P10` before `L1`. */
function byId(a: string, b: string): number {
  return a[0] === b[0] ? Number(a.slice(1)) - Number(b.slice(1)) : a[0] === "P" ? -1 : 1;
}

function fileOf(directory: string, sdk: string): string {
  return join(directory, `${sdk}.json`);
}

/** Writes the observations of the SDK release `sdk` into `directory`, creating it. */
export function writeObservations(directory: string, sdk: string, kept: Observations): void {
  mkdirSync(directory, { recursive: true });
  const claims = Object.fromEntries(
    Object.keys(kept.claims)
      .sort(byId)
      .map((id) => [id, sortedKeys(kept.claims[id])]),
  );
  const text = JSON.stringify({ cli: kept.cli, date: kept.date, claims }, null, 2);
  writeFileSync(fileOf(directory, sdk), `${text}\n`);
}

/**
 * The stored observations of the release `sdk`, null when none were stored. Throws on a file of
 * another shape: a baseline is never trusted on its looks.
 */
export function readObservations(directory: string, sdk: string): Observations | null {
  const path = fileOf(directory, sdk);
  if (!existsSync(path)) return null;
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  const shaped =
    isFacts(value) &&
    typeof value.cli === "string" &&
    typeof value.date === "string" &&
    isFacts(value.claims) &&
    Object.values(value.claims).every(isFacts);
  if (!shaped) throw new RangeError(`${sdk}.json is not a cli, a date and the facts by claim`);
  return value as unknown as Observations;
}

/** The count of verdicts in `kind`. */
function count(verdicts: readonly Verdict[], kind: Case): number {
  return verdicts.filter((v) => v.case === kind).length;
}

/** The line that closes the claims: how many changed, and what to do about it. */
export function summary(verdicts: readonly Verdict[]): string {
  const parts = CASES.map((kind) => `${count(verdicts, kind)} ${kind}`);
  const changed = count(verdicts, "changed");
  const read = changed > 0 ? ` ${changed} changed: read them before pinning.` : "";
  const fell = count(verdicts, "newly supported");
  const limits =
    fell > 0 ? ` ${fell} ${fell === 1 ? "limit" : "limits"} fell: change docs/limits.md.` : "";
  return `${parts.join(", ")}.${read}${limits}`;
}

/**
 * The claims grouped by case, `changed` first. `baseline` names the release compared with (null:
 * none stored); `featuresOf` gives the names of the `docs/features.md` rows tied to a claim and
 * `limitsOf` the `docs/limits.md` rows it checks, as `name: what Slack does`.
 */
export function groupedReport(
  verdicts: readonly Verdict[],
  cli: string,
  sdk: string,
  baseline: { readonly sdk: string | null; readonly observations: Observations | null },
  featuresOf: (id: string) => readonly string[],
  limitsOf: (id: string) => readonly string[] = () => [],
): string {
  const against = baseline.observations
    ? `Compared with the observations of ${baseline.sdk} (Claude Code ${baseline.observations.cli}, ${baseline.observations.date})`
    : baseline.sdk === null
      ? "No earlier certified release: nothing to compare with"
      : `No observations stored for ${baseline.sdk}: nothing to compare with`;
  const lines = [`@anthropic-ai/claude-agent-sdk ${sdk}, bundled Claude Code ${cli}`, against, ""];
  for (const kind of CASES) {
    const group = verdicts.filter((v) => v.case === kind);
    lines.push(`${kind[0]?.toUpperCase()}${kind.slice(1)} (${group.length})`);
    for (const { result, diff } of group) {
      const detail = result.detail && kind !== "unchanged" ? `  (${result.detail})` : "";
      const { id, kind: claimKind, text } = result.claim;
      lines.push(`  ${id.padEnd(4)} ${claimKind.padEnd(7)} ${text}${detail}`);
      for (const line of diff) lines.push(`         ${line}`);
      const tied = featuresOf(result.claim.id);
      if (kind === "changed" && tied.length > 0)
        lines.push(`         features: ${tied.join("; ")}`);
      if (kind === "newly supported") {
        for (const row of limitsOf(result.claim.id)) lines.push(`         limit: ${row}`);
      }
    }
  }
  lines.push("", summary(verdicts));
  return lines.join("\n");
}
