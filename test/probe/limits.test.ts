import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readLimits } from "../../probe/limits.ts";

function pageAt(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "allaboard-probe-test-")), "limits.md");
  writeFileSync(path, text);
  return path;
}

const HEAD =
  "| What differs | In the terminal | From Slack | Checked by | Looked into |\n|---|---|---|---|---|\n";

test("every table of the Agent SDK section is read, subsections included", () => {
  const path = pageAt(
    "# Limits\n\n## Limits of the Claude Agent SDK\n\nText.\n\n" +
      `${HEAD}| A | x | Not offered | \`P23\` | none |\n| B | y | Stopped | \`L1\`, \`L2\` | none |\n\n` +
      `### More\n\n${HEAD}| C | z | Hidden | by hand: Slack draws it | none |\n\n` +
      `## Limits of Slack\n\n${HEAD}| D | w | not read | \`L9\` | none |\n`,
  );
  assert.deepEqual(readLimits(path), [
    {
      name: "A",
      text: "Not offered",
      checkedBy: ["P23"],
      byHand: null,
      restsOn: [],
      restsOnError: null,
    },
    {
      name: "B",
      text: "Stopped",
      checkedBy: ["L1", "L2"],
      byHand: null,
      restsOn: [],
      restsOnError: null,
    },
    {
      name: "C",
      text: "Hidden",
      checkedBy: [],
      byHand: "Slack draws it",
      restsOn: [],
      restsOnError: null,
    },
  ]);
});

test("a Rests on column is read, and an unreadable cell is an error", () => {
  const head =
    "| What differs | In the terminal | From Slack | Checked by | Looked into | Rests on |\n|---|---|---|---|---|---|\n";
  const page = (row: string) =>
    pageAt(`# Limits\n\n## Limits of the Claude Agent SDK\n\n${head}${row}\n`);
  assert.deepEqual(
    readLimits(page("| A | x | y | `L1` | none | `Query.stopTask`, `/rewind` |")).map(
      (l) => l.restsOn,
    ),
    [["Query.stopTask", "/rewind"]],
  );
  assert.deepEqual(
    readLimits(page("| A | x | y | `L1` | none |  |")).map((l) => l.restsOn),
    [[]],
  );
  const unreadable = readLimits(page("| A | x | y | `L1` | none | Query.stopTask |"));
  assert.deepEqual(unreadable[0]?.restsOn, []);
  assert.match(unreadable[0]?.restsOnError ?? "", /Rests on/);
});

const BAD: [string, string][] = [
  ["a cell that names nothing", "| A | x | y | none | none |"],
  ["an empty cell", "| A | x | y |  | none |"],
  ["a claim id in no backticks", "| A | x | y | L1 | none |"],
  ["a claim id with words around it", "| A | x | y | `L1` and more | none |"],
  ["a hand check with no reason", "| A | x | y | by hand: | none |"],
  ["a row with a cell short", "| A | x | y | `L1` |"],
];

for (const [name, row] of BAD) {
  test(`a Checked by cell that cannot be read is an error [${name}]`, () => {
    const path = pageAt(`## Limits of the Claude Agent SDK\n\n${HEAD}${row}\n`);
    assert.throws(() => readLimits(path));
  });
}

test("a page with no section, no row or no Checked by column is an error", () => {
  assert.throws(() =>
    readLimits(pageAt(`## Limits of Slack\n\n${HEAD}| A | x | y | \`L1\` | none |\n`)),
  );
  assert.throws(() => readLimits(pageAt("## Limits of the Claude Agent SDK\n\nNo table.\n")));
  assert.throws(() =>
    readLimits(
      pageAt(
        "## Limits of the Claude Agent SDK\n\n| What differs | In the terminal | From Slack | Looked into |\n|---|---|---|---|\n| A | x | y | none |\n",
      ),
    ),
  );
});
