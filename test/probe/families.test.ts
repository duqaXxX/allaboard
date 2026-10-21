import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { costOf, FAMILIES, type FamilyRun, familiesReport } from "../../probe/families.ts";
import { type FullRecording, fullDue, lastFull } from "../../probe/main.ts";
import { FIXTURES, fixtureRecords, missing } from "../../probe/shapes.ts";
import { sdkRecords } from "../support/fixtures.ts";

const LAST: FullRecording = {
  date: "2026-10-20",
  sdk: "0.3.304",
  cli: "2.1.304",
  types: ["SDKAssistantMessage", "SDKResultMessage"],
};

test("the full recording runs when asked, on a difference, on new message types and weekly", () => {
  const types = [...LAST.types];
  assert.equal(fullDue(LAST, types, 0, false, "2026-10-21"), null);
  assert.match(fullDue(LAST, types, 0, true, "2026-10-21") ?? "", /--full/);
  assert.match(fullDue(LAST, types, 2, false, "2026-10-21") ?? "", /shape/);
  assert.match(fullDue(null, types, 0, false, "2026-10-21") ?? "", /no full recording/);
  assert.match(
    fullDue(LAST, [...types, "SDKSyntheticMessage"], 0, false, "2026-10-21") ?? "",
    /message types changed/,
  );
  assert.equal(fullDue(LAST, [...types].reverse(), 0, false, "2026-10-21"), null);
  assert.equal(fullDue(LAST, types, 0, false, "2026-10-26"), null);
  assert.match(fullDue(LAST, types, 0, false, "2026-10-27") ?? "", /7 days old/);
});

test("every family names fixtures that exist", () => {
  for (const family of FAMILIES) {
    assert.ok(family.fixtures.length > 0, family.name);
    for (const name of family.fixtures) {
      assert.ok(existsSync(join(FIXTURES, `${name}.jsonl`)), `${family.name}: ${name}`);
    }
  }
});

test("only the fixtures named are read", () => {
  assert.deepEqual(fixtureRecords(FIXTURES, ["clear"]), sdkRecords("clear"));
});

test("a path the fixture holds under a kind the run produced, under no type, is missing", () => {
  const recorded = structuredClone(sdkRecords("tools"));
  const live = structuredClone(sdkRecords("tools"));
  assert.deepEqual(missing(live, recorded), []);
  const init = live.find((record) => record.subtype === "init");
  assert.ok(init);
  delete init.output_style;
  assert.deepEqual(missing(live, recorded), [{ kind: "system/init", path: "output_style:string" }]);
  // Another type is no absence: the comparison of shapes reports it.
  init.output_style = 3;
  assert.deepEqual(missing(live, recorded), []);
  // An empty list says nothing about its items' fields.
  init.mcp_servers = [];
  assert.deepEqual(missing(live, recorded), []);
  // A kind the run never produced says nothing about its paths.
  assert.deepEqual(
    missing(
      live.filter((record) => record.type !== "result"),
      recorded,
    ),
    [],
  );
});

test("the report names each family's count, what it did not produce, and the one that failed", () => {
  const live = structuredClone(sdkRecords("clear"));
  // `/clear` starts a second session: each has its init.
  for (const record of live) if (record.subtype === "init") delete record.output_style;
  const runs: FamilyRun[] = [
    { name: "commands", fixtures: ["clear"], records: live, failed: null },
    {
      name: "ask",
      fixtures: ["ask"],
      records: [],
      failed: "raised ProbeTimeout: a turn did not end in time",
    },
  ];
  const report = familiesReport(runs);
  assert.match(report, /Full recording: 2 families, \$\d+\.\d{3} of API usage\./);
  assert.match(
    report,
    new RegExp(
      `commands: ${live.length} messages, \\$\\d+\\.\\d{3}; 1 paths of clear not produced`,
    ),
  );
  assert.match(report, /- system\/init output_style:string/);
  assert.match(report, /ask: raised ProbeTimeout: a turn did not end in time; the next run/);
});

test("a session's cost is its last total, and sessions add up", () => {
  const records = [
    { type: "result", session_id: "a", total_cost_usd: 0.1 },
    { type: "result", session_id: "a", total_cost_usd: 0.25 },
    { type: "assistant", session_id: "a" },
    { type: "result", session_id: "b", total_cost_usd: 0.5 },
  ];
  assert.equal(costOf(records), 0.75);
});

test("each family checks it caused what it exists for", () => {
  const byName = new Map(FAMILIES.map((family) => [family.name, family]));
  const caused = (name: string, records: unknown[]) => byName.get(name)?.caused(records);
  assert.equal(caused("subagent", sdkRecords("subagent")), true);
  assert.equal(caused("subagent", sdkRecords("clear")), false);
  assert.equal(caused("ask", sdkRecords("ask-answered")), true);
  assert.equal(caused("monitor", sdkRecords("monitor-ended-in-turn")), true);
  assert.equal(caused("skill-fork", sdkRecords("skill-fork")), true);
  assert.equal(caused("commands", sdkRecords("clear")), true);
  assert.equal(caused("commands", sdkRecords("usage")), false);
  assert.equal(caused("api-error", sdkRecords("api-error-400")), true);
  assert.equal(caused("api-error", sdkRecords("clear")), false);
});

test("the last full recording is read whole or refused", () => {
  const folder = mkdtempSync(join(tmpdir(), "allaboard-full-"));
  const path = join(folder, "full-recording.json");
  assert.equal(lastFull(path), null);
  writeFileSync(path, JSON.stringify(LAST));
  assert.deepEqual(lastFull(path), LAST);
  writeFileSync(path, JSON.stringify({ ...LAST, date: "20-10-2026" }));
  assert.throws(() => lastFull(path), RangeError);
  writeFileSync(path, JSON.stringify({ date: LAST.date }));
  assert.throws(() => lastFull(path), RangeError);
});
