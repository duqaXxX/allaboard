import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CLAIMS,
  claim,
  evaluate,
  type Facts,
  observation,
  type Result,
  result,
} from "../../probe/claims.ts";
import {
  CASES,
  classify,
  diffFacts,
  groupedReport,
  type Observations,
  observationsOf,
  readObservations,
  summary,
  writeObservations,
} from "../../probe/verdicts.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const GESTURE = claim("P1", "gesture", "a gesture", "src/core/commands.ts#parseBang", "how");
const OTHER = claim("P2", "gesture", "another gesture", "src/core/commands.ts#parseBang", "how");
const MODEL = claim("P3", "model", "a model claim", "src/core/commands.ts#parseBang", "how");

function holds(subject: typeof GESTURE, seen: Facts): Result {
  return evaluate(subject, observation(true, true, "", seen));
}

function stored(claims: Record<string, Facts>): Observations {
  return { cli: "1.0.0", date: "2026-10-21", claims };
}

test("a claim that holds on the same facts is unchanged", () => {
  const [one] = classify([holds(GESTURE, { a: 1, b: ["x"] })], stored({ P1: { b: ["x"], a: 1 } }));
  assert.equal(one?.case, "unchanged");
  assert.deepEqual(one?.diff, []);
});

test("a claim that holds on other facts is changed, with the difference", () => {
  const before = { limit: 10, gone: true, same: "s", nested: { inner: "a" } };
  const after = { limit: 12, added: ["b"], same: "s", nested: { inner: "b" } };
  const [one] = classify([holds(GESTURE, after)], stored({ P1: before }));
  assert.equal(one?.case, "changed");
  assert.deepEqual(one?.diff, [
    '+ added = ["b"]',
    "- gone (was true)",
    "~ limit: 10 -> 12",
    '~ nested.inner: "a" -> "b"',
  ]);
});

test("a BROKEN claim is no longer supported and an UNPROVEN one is not proven", () => {
  const verdicts = classify(
    [
      evaluate(GESTURE, observation(true, false, "gone")),
      evaluate(OTHER, null),
      evaluate(MODEL, null),
    ],
    stored({ P1: { a: 1 }, P2: { a: 1 } }),
  );
  assert.deepEqual(
    verdicts.map((v) => v.case),
    ["no longer supported", "not proven", "not proven"],
  );
});

test("a limit claim that fell is newly supported and asks for the page to change", () => {
  const limit = claim("L1", "limit", "a limit", "src/core/commands.ts#parseBang", "how");
  const verdicts = classify(
    [
      evaluate(limit, observation(true, false, "gone")),
      evaluate(GESTURE, observation(true, false)),
    ],
    null,
  );
  assert.deepEqual(
    verdicts.map((v) => v.case),
    ["newly supported", "no longer supported"],
  );
  const text = groupedReport(
    verdicts,
    "9.9.9",
    "0.9.9",
    { sdk: null, observations: null },
    () => [],
    (id) => (id === "L1" ? ['"A row": what Slack does'] : []),
  );
  assert.match(
    text,
    /Newly supported \(1\)\n {2}L1 {3}limit {3}a limit {2}\(gone\)\n {9}limit: "A row": what Slack does/,
  );
  assert.match(text, /1 limit fell: change docs\/limits\.md\.$/);
  // The row is for a fallen claim only.
  const quiet = groupedReport(
    classify([evaluate(limit, observation(true, true))], null),
    "9.9.9",
    "0.9.9",
    { sdk: null, observations: null },
    () => [],
    () => ["a row"],
  );
  assert.doesNotMatch(quiet, /limit: a row/);
  assert.doesNotMatch(quiet, /fell/);
});

test("claim ids sort P before L and by number in the observations file", () => {
  const dir = mkdtempSync(join(tmpdir(), "allaboard-probe-test-"));
  try {
    writeObservations(dir, "0.0.1", stored({ L2: {}, P10: {}, L1: {}, P2: {} }));
    const kept = readObservations(dir, "0.0.1");
    assert.deepEqual(Object.keys(kept?.claims ?? {}), ["P2", "P10", "L1", "L2"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a retired claim stays retired", () => {
  const retired = claim("P4", "gesture", "t", "src/core/commands.ts#parseBang", "how", "measured");
  assert.equal(classify([evaluate(retired, null)], null)[0]?.case, "retired");
});

test("without a baseline a held claim is never called unchanged", () => {
  const results = [holds(GESTURE, { a: 1 }), holds(OTHER, { a: 1 })];
  assert.deepEqual(
    classify(results, null).map((v) => v.case),
    ["no baseline", "no baseline"],
  );
  // A baseline that lacks this claim says nothing of it either.
  assert.deepEqual(
    classify(results, stored({ P1: { a: 1 } })).map((v) => v.case),
    ["unchanged", "no baseline"],
  );
});

test("an empty record added or removed shows as a difference", () => {
  assert.deepEqual(diffFacts({}, { a: {} }), ["+ a = {}"]);
  assert.deepEqual(diffFacts({ a: {} }, {}), ["- a (was {})"]);
});

test("the report lists changed first, then unsupported, unproven, no baseline, unchanged", () => {
  const third = claim("P5", "gesture", "fifth gesture", "src/core/commands.ts#parseBang", "how");
  const fourth = claim("P6", "gesture", "sixth gesture", "src/core/commands.ts#parseBang", "how");
  const results = [
    holds(GESTURE, { a: 1 }),
    evaluate(OTHER, observation(true, false, "no more")),
    holds(MODEL, { a: 2 }),
    evaluate(third, null),
    holds(fourth, { a: 1 }),
  ];
  const verdicts = classify(results, stored({ P1: { a: 1 }, P3: { a: 1 }, P6: { a: 1 } }));
  const text = groupedReport(
    verdicts,
    "9.9.9",
    "0.9.9",
    { sdk: "0.1.0", observations: stored({}) },
    (id) => (id === "P3" ? ["Row one", "Row two"] : []),
  );
  const at = (heading: string) => text.indexOf(`\n${heading} (`);
  const order = ["Changed", "No longer supported", "Not proven", "No baseline", "Unchanged"].map(
    at,
  );
  assert.ok(
    order.every((place) => place >= 0),
    text,
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
  );
  assert.match(
    text,
    /Changed \(1\)\n {2}P3 {3}model {3}a model claim\n {9}~ a: 1 -> 2\n {9}features: Row one; Row two/,
  );
  assert.match(text, /Unchanged \(2\)\n {2}P1 {3}gesture /);
  assert.match(text, /Compared with the observations of 0\.1\.0/);
  assert.match(text, /1 changed: read them before pinning\.$/);
  assert.deepEqual(CASES, [
    "changed",
    "no longer supported",
    "newly supported",
    "not proven",
    "no baseline",
    "unchanged",
    "retired",
  ]);
});

test("an array of records equals its stored copy whatever the order of its keys", () => {
  const stored = JSON.parse('{"rows":[{"b":2,"a":1}]}') as Facts;
  assert.deepEqual(diffFacts(stored, { rows: [{ a: 1, b: 2 }] }), []);
  assert.deepEqual(diffFacts(stored, { rows: [{ a: 1, b: 3 }] }), [
    '~ rows: [{"a":1,"b":2}] -> [{"a":1,"b":3}]',
  ]);
});

test("a report with no earlier certified release says so", () => {
  const verdicts = classify([holds(GESTURE, { a: 1 })], null);
  const text = groupedReport(verdicts, "1", "2", { sdk: null, observations: null }, () => []);
  assert.match(text, /No earlier certified release: nothing to compare with/);
});

test("the summary asks for no reading when nothing changed", () => {
  const verdicts = classify([holds(GESTURE, { a: 1 })], stored({ P1: { a: 1 } }));
  assert.equal(
    summary(verdicts),
    "0 changed, 0 no longer supported, 0 newly supported, 0 not proven, 0 no baseline, 1 unchanged, 0 retired.",
  );
});

test("a report against no stored baseline says so", () => {
  const verdicts = classify([holds(GESTURE, { a: 1 })], null);
  const text = groupedReport(verdicts, "1", "2", { sdk: "0.1.0", observations: null }, () => []);
  assert.match(text, /No observations stored for 0\.1\.0: nothing to compare with/);
  assert.match(text, /No baseline \(1\)/);
  assert.match(text, /Unchanged \(0\)/);
});

test("observations keep the facts of the claims that hold, and read back as written", () => {
  const dir = mkdtempSync(join(tmpdir(), "allaboard-observations-"));
  try {
    const results = [
      holds(GESTURE, { z: 1, a: { y: true, b: ["q"] } }),
      evaluate(OTHER, observation(true, false, "gone")),
      holds(MODEL, { n: null }),
    ];
    const kept = observationsOf(results, "2.0.0", "2026-10-21");
    assert.deepEqual(Object.keys(kept.claims), ["P1", "P3"]);
    writeObservations(dir, "0.3.1", kept);
    const text = readFileSync(join(dir, "0.3.1.json"), "utf8");
    // Keys are sorted on disk, so a rerun of one release writes the same bytes.
    assert.ok(text.indexOf('"a"') < text.indexOf('"z"'));
    assert.deepEqual(readObservations(dir, "0.3.1"), kept);
    assert.equal(readObservations(dir, "0.3.2"), null);
    assert.equal(text, readFileSync(join(dir, "0.3.1.json"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file that is not an observations file is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "allaboard-observations-"));
  try {
    writeObservations(dir, "1.0.0", stored({}));
    writeObservations(dir, "1.0.1", { cli: "1", date: "d", claims: { P1: 3 as unknown as Facts } });
    assert.throws(() => readObservations(dir, "1.0.1"), RangeError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The facts are committed to a public repository: nothing in them may be a path, an id, a time
// or a model's words.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const TIMESTAMP = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const PATH = /(^|\s)(~|\.\.?)?\/[\w.-]+|[A-Za-z]:\\|\/(Users|home|tmp|var|private)\//;
const HEX_ID = /\b[0-9a-f]{8,}\b/i;
const LONGEST = 120;

function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const inner of value) strings(inner, into);
  else if (typeof value === "object" && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      into.push(key);
      strings(inner, into);
    }
  }
  return into;
}

test("the privacy guard flags a path, an id, a time and free text", () => {
  for (const bad of [
    "/Us" + "ers/alice/work",
    "~/notes",
    "a path /tmp/x here",
    "123e4567-e89b-12d3-a456-426614174000",
    "2026-10-21T10:00:00Z",
    "deadbeefcafe",
    "x".repeat(LONGEST + 1),
  ]) {
    const flagged =
      bad.length > LONGEST || [UUID, TIMESTAMP, PATH, HEX_ID].some((pattern) => pattern.test(bad));
    assert.ok(flagged, bad);
  }
});

const pinned = (
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  }
).dependencies["@anthropic-ai/claude-agent-sdk"] as string;

// A claim whose scene finds no fact that can differ while it holds says so here: every fact it
// could keep restates its pass condition or a constant, so a release cannot change it unseen.
const NO_FACTS = new Set([
  "P2",
  "P3",
  "P4",
  "P5",
  "P6",
  "P7",
  "P8",
  "P9",
  "P10",
  "P11",
  "P12",
  "P13",
  "P14",
  "P15",
  "P18",
  "P19",
  "P20",
  "P22",
  "P23",
  "P25",
  "P26",
  "P27",
  "P28",
  "P29",
  "P30",
  "P31",
  "P32",
  "P33",
  "P34",
  "P35",
  "P36",
  "P37",
  "P39",
  // What the stop hooks said is the whole check: no fact of the release beside it.
  "P42",
  // Whether the copy got its note is the whole check.
  "P43",
  // Limit claims: each holds on a constant the page states, or a name that is there or not.
  "L1",
  "L2",
  "L3",
  "L4",
  "L5",
  "L6",
  "L8",
  "L9",
]);

test("the pinned release has observations: every claim that is not retired sets facts", () => {
  const found = readObservations(join(ROOT, "probe", "observations"), pinned);
  assert.ok(
    found,
    `probe/observations/${pinned}.json is missing: a certifying \`node probe/main.ts --latest\` ` +
      "run writes probe/observations/<version>.json; commit it in the pull request that moves the pin",
  );
  for (const subject of CLAIMS.filter((c) => c.retired === null)) {
    const facts: Facts | undefined = found.claims[subject.id];
    // A model claim the run could not prove has none: it is UNPROVEN, not absent by mistake.
    // A limit claim that FELL has none either: only a HOLDS keeps its facts.
    if (facts === undefined) {
      assert.notEqual(subject.kind, "gesture", `${subject.id} has no stored facts`);
      continue;
    }
    // Stored as `{}`, as a run writes it: a claim with no entry would read as "No baseline".
    const none: boolean = Object.keys(facts).length === 0;
    assert.equal(none, NO_FACTS.has(subject.id), `${subject.id}: facts and NO_FACTS disagree`);
  }
});

test("the stored facts hold no path, id, time or free text", () => {
  const text = readFileSync(join(ROOT, "probe", "observations", `${pinned}.json`), "utf8");
  const file = JSON.parse(text) as Observations;
  for (const [id, facts] of Object.entries(file.claims)) {
    for (const one of strings(facts)) {
      assert.ok(one.length <= LONGEST, `${id}: ${one.slice(0, 40)}... is free text`);
      for (const pattern of [UUID, TIMESTAMP, PATH, HEX_ID]) {
        assert.ok(!pattern.test(one), `${id}: ${one} matches ${pattern}`);
      }
    }
  }
});

test("a verdict needs a held result to carry facts", () => {
  assert.deepEqual(result(GESTURE, "BROKEN", "x").seen, {});
});
