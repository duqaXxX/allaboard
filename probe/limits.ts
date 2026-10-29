/**
 * The limits `docs/limits.md` lists for the Claude Agent SDK, and how each one is checked.
 *
 * Every row of every table under `## Limits of the Claude Agent SDK` (subsections included) has a
 * `Checked by` cell: claim ids in backticks, or `by hand: <why>` when the check needs Claude, a
 * phone or Slack. An optional `Rests on` cell names the SDK names and commands the row depends on
 * (`diff.ts` matches them against what a release adds). The probe prints the row beside a limit claim that no longer holds;
 * `test/docs.test.ts` keeps the cells and `CLAIMS` in step.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIMITS_HEADING } from "../src/agent/claude/module.ts";
import { readRests } from "./diff.ts";

const LIMITS = join(import.meta.dirname, "..", "docs", "limits.md");
const SECTION = LIMITS_HEADING;
const NAME = "What differs";
const SLACK = "From Slack";
const CHECKED = "Checked by";
const RESTS = "Rests on";

export interface Limit {
  /** The first cell: what differs. */
  readonly name: string;
  /** The "From Slack" cell: what Slack does. */
  readonly text: string;
  /** Limit claims that check it; empty when `byHand` is set. */
  readonly checkedBy: readonly string[];
  /** Why the row is checked by hand, null when claims check it. */
  readonly byHand: string | null;
  /** The SDK names and `/commands` in the `Rests on` cell; empty when the cell is empty or absent. */
  readonly restsOn: readonly string[];
  /** Why the `Rests on` cell cannot be read, null when it can: the run goes on without the names. */
  readonly restsOnError: string | null;
}

function cellsOf(row: string): string[] {
  return row
    .replace(/^\|+|\|+$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** The ids of a `Checked by` cell of claims: only backticked ids, joined by commas. */
function claimIds(cell: string): string[] | null {
  const ids = [...cell.matchAll(/`([PL][1-9]\d*)`/g)].map((m) => m[1] ?? "");
  const rest = cell.replace(/`[PL][1-9]\d*`/g, "").replace(/[,\s]/g, "");
  return ids.length > 0 && rest === "" ? ids : null;
}

/**
 * The rows of every table in the Agent SDK section. Throws when the section, a column or a
 * `Checked by` cell is missing or malformed: a page that lists nothing, or a cell nobody can read,
 * must stop a run before it spends tokens.
 */
export function readLimits(path: string = LIMITS): Limit[] {
  const file = path.split("/").at(-1);
  const text = readFileSync(path, "utf8");
  const heading = `## ${SECTION}\n`;
  if (!text.includes(heading)) throw new RangeError(`${file}: no section '${SECTION}'`);
  const lines = ((text.split(heading)[1] ?? "").split("\n## ")[0] ?? "").split(/\r?\n/);
  const limits: Limit[] = [];
  let columns: string[] | null = null;
  // The line after a header is its separator row.
  let separator = false;
  for (const line of lines) {
    if (!line.startsWith("|")) {
      columns = null;
      continue;
    }
    if (columns === null) {
      columns = cellsOf(line);
      separator = true;
      continue;
    }
    if (separator) {
      separator = false;
      continue;
    }
    const name = columns.indexOf(NAME);
    const slack = columns.indexOf(SLACK);
    const checked = columns.indexOf(CHECKED);
    const rests = columns.indexOf(RESTS);
    if (name < 0 || slack < 0 || checked < 0) {
      throw new RangeError(
        `${file}: a table of '${SECTION}' lacks ${NAME}, ${SLACK} or ${CHECKED}`,
      );
    }
    const cells = cellsOf(line);
    if (cells.length !== columns.length) {
      throw new RangeError(`${file}: ${cells.length} cells, not ${columns.length}, in ${cells[0]}`);
    }
    const cell = cells[checked] ?? "";
    const hand = /^by hand: (.+)$/.exec(cell);
    const ids = hand ? null : claimIds(cell);
    if (!hand && !ids) {
      throw new RangeError(
        `${file}: '${cells[0]}': '${cell}' is neither claim ids nor 'by hand: <why>'`,
      );
    }
    const rested =
      rests < 0 ? { names: [], error: null } : readRests(cells[rests] ?? "", cells[0] ?? "");
    limits.push({
      name: cells[name] ?? "",
      text: cells[slack] ?? "",
      checkedBy: ids ?? [],
      byHand: hand?.[1] ?? null,
      restsOn: rested.names,
      restsOnError: rested.error,
    });
  }
  if (limits.length === 0) throw new RangeError(`${file}: the tables of '${SECTION}' hold no row`);
  return limits;
}
