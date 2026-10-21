import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CLAIMS } from "../../probe/claims.ts";
import { byHand, FEATURES, features, testModuleExists } from "../../probe/features.ts";

function tableAt(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "allaboard-probe-test-")), "features.md");
  writeFileSync(path, text);
  return path;
}

test("every claim a row names exists, and every claim that is not a limit's is named", () => {
  const known = new Set(CLAIMS.map((c) => c.id));
  const mapped = new Set(features().flatMap((f) => [...f.claims]));
  for (const id of mapped) assert.ok(known.has(id), `${id} is not in CLAIMS`);
  // The claims `L1` and on check a row of docs/limits.md, which maps them; a feature row may
  // name one too.
  for (const subject of CLAIMS.filter((c) => c.kind !== "limit")) {
    assert.ok(mapped.has(subject.id), `${subject.id} is named by no row of docs/features.md`);
  }
});

for (const feature of features()) {
  test(`every row names test modules that exist [${feature.name.slice(0, 40)}]`, () => {
    assert.ok(
      feature.tests.length > 0,
      "a feature no test covers still names where its checks live",
    );
    for (const module of feature.tests) assert.ok(testModuleExists(module), module);
  });
}

test("a by hand Probe cell is read and listed in the checklist with its reason", () => {
  const table = tableAt(
    "| Feature | Test suite | Probe | Rests on | By hand |\n|---|---|---|---|---|\n" +
      "| A | `test/a.test.ts` | by hand: needs the extension | `/chrome` | none |\n" +
      "| B | `test/b.test.ts` | P1 |  | none |\n",
  );
  assert.deepEqual(
    features(table).map((f) => [f.claims, f.notApplicable, f.probeByHand]),
    [
      [[], null, "needs the extension"],
      [["P1"], null, null],
    ],
  );
  const text = byHand(table);
  assert.ok(text.includes("  [ ] A") && text.includes("needs the extension"));
  assert.ok(!text.includes("  [ ] B"));
});

test("the checklist lists only what is left by hand", () => {
  const table = tableAt(
    "| Feature | Test suite | Probe | Rests on | By hand |\n|---|---|---|---|---|\n" +
      "| A | `test/a.test.ts` | P1, L2 |  | none |\n| B | `test/b.test.ts` | n/a: Slack only |  | Look at it |\n",
  );
  assert.deepEqual(
    features(table).map((f) => [f.claims, f.notApplicable]),
    [
      [["P1", "L2"], null],
      [[], "Slack only"],
    ],
  );
  const text = byHand(table);
  assert.ok(text.includes("B") && text.includes("Look at it") && !text.includes("  [ ] A"));
});

test("a Rests on cell is read as names, and a cell of anything else is an error", () => {
  const head = "| Feature | Test suite | Probe | Rests on | By hand |\n|---|---|---|---|---|\n";
  const table = tableAt(
    `${head}| A | \`test/a.test.ts\` | P1 | \`Query.setModel\`, \`/chrome\` | none |\n`,
  );
  assert.deepEqual(features(table)[0]?.restsOn, ["Query.setModel", "/chrome"]);
  const bad = tableAt(`${head}| A | \`test/a.test.ts\` | P1 | Query.setModel | none |\n`);
  assert.match(features(bad)[0]?.restsOnError ?? "", /Rests on/);
});

test("a changed header is an error not an empty map", () => {
  const table = tableAt("| Feature | Tests |\n|---|---|\n| A | x |\n");
  assert.throws(() => features(table));
  assert.equal(FEATURES.endsWith("features.md"), true);
});

const ROWS: [string, string][] = [
  ["too few cells", "| A | `test/a.test.ts` | P1 |"],
  ["a bar inside a cell", "| A | `x | y` | P1 |  | none |"],
  ["too many cells", "| A | `test/a.test.ts` | P1 |  | none | extra |"],
];

const CELLS: [string, string][] = [
  ["none", "none"],
  ["empty", ""],
  ["a mix of ids and n/a", "P1, n/a: Slack only"],
  ["n/a with no reason", "n/a:"],
  ["a lowercase id", "p1"],
  ["a claim id with text", "P1 and more"],
  ["a reason that names a claim", "n/a: Slack only, P1"],
  ["a repeated id", "P1, P1"],
  ["by hand with no reason", "by hand:"],
  ["a by hand reason that names a claim", "by hand: see L2"],
];

for (const [name, cell] of CELLS) {
  test(`a Probe cell that is neither claim ids nor n/a with a reason is an error [${name}]`, () => {
    const table = tableAt(
      `| Feature | Test suite | Probe | Rests on | By hand |\n|---|---|---|---|---|\n| Row A | \`test/a.test.ts\` | ${cell} |  | none |\n`,
    );
    assert.throws(() => features(table), /Row A/);
  });
}

for (const [name, row] of ROWS) {
  test(`a row with the wrong number of cells is an error [${name}]`, () => {
    // A row dropped in silence would leave both the checks and the checklist.
    const table = tableAt(
      `| Feature | Test suite | Probe | Rests on | By hand |\n|---|---|---|---|---|\n${row}\n`,
    );
    assert.throws(() => features(table));
  });
}
