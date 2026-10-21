/**
 * What `allaboard service list` prints and what an update asks of the same data. Every backend
 * reads its instances as `InstanceRow`s; the table is the same on every system.
 */
import type { InstanceListing, InstanceRow, Report } from "./seam.ts";

/** The cells of one row of the table `list` prints. */
type Row = readonly [instance: string, state: string, copy: string, version: string];

/** The columns of `rows` padded to their widest cell, two spaces apart; the last is not padded. */
function table(rows: readonly Row[]): string[] {
  const widths = [0, 1, 2].map((column) =>
    Math.max(...rows.map((row) => (row[column] as string).length)),
  );
  return rows.map((row) =>
    row
      .map((cell, column) => (column < 3 ? cell.padEnd((widths[column] as number) + 2) : cell))
      .join(""),
  );
}

function cellsOf(row: InstanceRow): Row {
  const state = !row.loaded
    ? "not loaded"
    : row.pid === null
      ? "loaded, not running"
      : `running, pid ${row.pid}`;
  // Not a name to type: `--instance default` is refused.
  const name = row.instance ?? "(default)";
  if (row.entry === "plist-gone") return [name, `${state}; its plist is gone`, "-", "-"];
  if (row.entry === "unreadable") return [name, state, "unreadable plist", "-"];
  return [name, state, row.entry.copy, row.entry.version ?? "unknown"];
}

/** The report of `service list`: the table, then the definitions that are no instance's. */
export function listReport(listing: InstanceListing): Report {
  if ("failure" in listing) return { code: 1, out: [], err: [listing.failure] };
  if (listing.rows.length === 0 && listing.refused.length === 0) {
    return { code: 0, out: ["No allaboard service is installed."], err: [] };
  }
  const header: Row = ["INSTANCE", "STATE", "COPY", "VERSION"];
  return {
    code: 0,
    out: [
      ...(listing.rows.length === 0 ? [] : table([header, ...listing.rows.map(cellsOf)])),
      ...listing.refused,
    ],
    err: [],
  };
}

/** The loaded instances whose copy is the package folder `copy`: the ones an update restarts. */
export function loadedOn(rows: readonly InstanceRow[], copy: string): InstanceRow[] {
  return rows.filter(
    (row) => row.loaded && typeof row.entry === "object" && row.entry.copy === copy,
  );
}
