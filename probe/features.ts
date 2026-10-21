/**
 * The coverage map in `docs/features.md`: which probe claims each feature has (or why it has
 * none), and what is left to check by hand. The probe prints the second at the end of a run;
 * `test/probe/features.test.ts` keeps the first in step with `CLAIMS`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readRests } from "./diff.ts";

const ROOT = join(import.meta.dirname, "..");
export const FEATURES = join(ROOT, "docs", "features.md");
const COLUMNS = ["Feature", "Test suite", "Probe", "Rests on", "By hand"];

export interface Feature {
  readonly name: string;
  /** Test modules, each the path of a `*.test.ts` file. */
  readonly tests: readonly string[];
  /** Probe claim ids, as `P1` or `L1`; empty when `notApplicable` is set. */
  readonly claims: readonly string[];
  /** Why no claim can check the feature (it does not rest on the SDK), null otherwise. */
  readonly notApplicable: string | null;
  /** Why the feature rests on the SDK and the probe cannot see it, null otherwise. */
  readonly probeByHand: string | null;
  /** The SDK names and `/commands` the feature depends on; empty when none shows a change. */
  readonly restsOn: readonly string[];
  /** Why the `Rests on` cell cannot be read, null when it can: the run goes on without the names. */
  readonly restsOnError: string | null;
  /** Empty when nothing is left to check by hand. */
  readonly byHand: string;
}

/** The cells of a table row, without the bars at its ends. */
function cellsOf(row: string): string[] {
  return row
    .replace(/^\|+|\|+$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * The table's rows. Throws when the table is missing, its header changed, or a row does not have
 * one cell per column: a broken row is an error, never a row left out of the checks and the
 * checklist.
 */
export function features(path: string = FEATURES): Feature[] {
  const rows = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|"));
  const cells = rows.map(cellsOf);
  const header = cells[0];
  if (header === undefined || header.join("\0") !== COLUMNS.join("\0")) {
    throw new RangeError(`${basename(path)}: no table with the columns ${COLUMNS.join(", ")}`);
  }
  const out: Feature[] = [];
  for (const row of cells.slice(2)) {
    if (row.length !== COLUMNS.length) {
      // A `|` inside a cell splits it too: write it another way.
      throw new RangeError(
        `${basename(path)}: ${row.length} cells, not ${COLUMNS.length}, in ${row[0] ?? ""}`,
      );
    }
    const [name = "", tests = "", coverage = "", rests = "", byHand = ""] = row;
    const rested = readRests(rests, name);
    out.push({
      name,
      tests: [...tests.matchAll(/`([\w./-]+\.test\.ts)`/g)].map((m) => m[1] ?? ""),
      ...coverageOf(coverage, name),
      restsOn: rested.names,
      restsOnError: rested.error,
      byHand: byHand === "none" ? "" : byHand,
    });
  }
  return out;
}

const ID = /^[PL][1-9]\d*$/;

/**
 * The Probe cell of a row: claim ids joined by commas, `n/a: <reason>` for a feature that does
 * not rest on the SDK, or `by hand: <why>` for one that does and that the probe cannot see.
 * Throws on `none`, an empty cell, a mix, a repeated id, a reason that names a claim, or any
 * other text: a row with no claim says why.
 */
function coverageOf(
  cell: string,
  row: string,
): Pick<Feature, "claims" | "notApplicable" | "probeByHand"> {
  const bad = (why: string) =>
    new RangeError(`${row.slice(0, 60)}: the Probe cell '${cell}' ${why}`);
  const said = /^(n\/a|by hand): (.+)$/.exec(cell);
  if (said) {
    const reason = said[2] ?? "";
    if (/\b[PL][1-9]\d*\b/.test(reason)) throw bad("gives a reason that names a claim");
    return said[1] === "n/a"
      ? { claims: [], notApplicable: reason, probeByHand: null }
      : { claims: [], notApplicable: null, probeByHand: reason };
  }
  const ids = cell.split(",").map((id) => id.trim());
  if (!ids.every((id) => ID.test(id))) {
    throw bad("is neither claim ids, 'n/a: <reason>' nor 'by hand: <why>'");
  }
  if (new Set(ids).size !== ids.length) throw bad("names a claim twice");
  return { claims: ids, notApplicable: null, probeByHand: null };
}

function basename(path: string): string {
  return path.split("/").at(-1) ?? path;
}

/** Whether a test module the table names exists. */
export function testModuleExists(module: string): boolean {
  return existsSync(join(ROOT, module));
}

/** The checks no test and no probe claim makes, as the probe prints them. */
export function byHand(path: string = FEATURES): string {
  const left = features(path).filter((f) => f.byHand || f.probeByHand);
  if (left.length === 0) return "";
  const lines = [
    "Checked by nothing automatic (docs/features.md), when the feature or Slack changes:",
    "",
  ];
  for (const f of left) {
    lines.push(`  [ ] ${f.name}`);
    if (f.probeByHand) lines.push(`      the probe cannot see it: ${f.probeByHand}`);
    if (f.byHand) lines.push(`      how: ${f.byHand}`);
  }
  return lines.join("\n");
}
