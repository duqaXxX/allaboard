import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { notOffered, recorded } from "../../probe/commands.ts";
import {
  declares,
  diffSurface,
  isEmpty,
  matches,
  readSurface,
  report,
  restsOn,
} from "../../probe/diff.ts";
import { features } from "../../probe/features.ts";
import { readLimits } from "../../probe/limits.ts";
import { addedToSdk } from "../../probe/main.ts";

const here = import.meta.dirname;
const before = readFileSync(join(here, "..", "fixtures", "sdk-d", "before.d.ts"), "utf8");
const after = readFileSync(join(here, "..", "fixtures", "sdk-d", "after.d.ts"), "utf8");
const pinned = readFileSync(
  join(here, "..", "..", "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.d.ts"),
  "utf8",
);
const NO_COMMANDS = { new: [], gone: [] };

test("readSurface reads declarations, Options keys, Query methods, messages and subtypes", () => {
  const surface = readSurface(before);
  assert.deepEqual(
    [...surface.declaration].sort(),
    [
      "AbortError",
      "EXIT_REASONS",
      "Options",
      "Query",
      "SDKAssistantMessage",
      "SDKMessage",
      "SDKTaskStartedMessage",
      "SDKToolProgressMessage",
      "tagSession",
    ].sort(),
  );
  assert.deepEqual(
    [...surface.member].filter((name) => /^(Options|Query)\./.test(name)).sort(),
    [
      "Options.additionalDirectories",
      "Options.model",
      "Options.permissionMode",
      "Query.interrupt",
      "Query.setModel",
      "Query.stopTask",
    ].sort(),
  );
  assert.ok(surface.member.has("SDKTaskStartedMessage.task_id"));
  assert.deepEqual(
    [...surface["SDKMessage member"]].sort(),
    ["SDKAssistantMessage", "SDKTaskStartedMessage", "SDKToolProgressMessage"].sort(),
  );
  assert.deepEqual([...surface["system subtype"]], ["system:task_started"]);
});

test("diffSurface names what was added and removed, by category", () => {
  const diff = diffSurface(readSurface(before), readSurface(after));
  assert.deepEqual(diff.declaration, {
    added: ["SDKFooMessage", "renameSession"],
    removed: ["EXIT_REASONS", "SDKToolProgressMessage"],
  });
  const members = (names: string[]) => names.filter((name) => /^(Options|Query)\./.test(name));
  assert.deepEqual(members(diff.member.added), ["Options.notesDirectory", "Query.rewindFiles"]);
  assert.deepEqual(members(diff.member.removed), ["Options.permissionMode", "Query.stopTask"]);
  assert.ok(diff.member.added.includes("SDKFooMessage.subtype"));
  assert.ok(diff.member.removed.includes("SDKToolProgressMessage.tool_use_id"));
  assert.deepEqual(diff["SDKMessage member"], {
    added: ["SDKFooMessage"],
    removed: ["SDKToolProgressMessage"],
  });
  assert.deepEqual(diff["system subtype"], { added: ["system:foo_happened"], removed: [] });
});

test("a release compared with itself holds no difference and prints nothing", () => {
  const diff = diffSurface(readSurface(before), readSurface(before));
  assert.ok(isEmpty(diff));
  assert.equal(report(diff, []), "");
});

test("an added name a row rests on may now be supported, a removed one may break, once each", () => {
  const diff = diffSurface(readSurface(before), readSurface(after));
  const rows = [
    { name: "Rewind", restsOn: ["Query.rewindFiles"] },
    { name: "Tool progress", restsOn: ["SDKToolProgressMessage"] },
    { name: "Other", restsOn: ["SDKAssistantMessage"] },
  ];
  assert.deepEqual(
    matches(rows, diff, NO_COMMANDS).map((m) => [m.row, m.name, m.kind, m.prefix]),
    [
      ["Rewind", "Query.rewindFiles", "may now be supported", false],
      ["Tool progress", "SDKToolProgressMessage", "may break", false],
      ["Tool progress", "SDKToolProgressMessage.tool_use_id", "may break", true],
      ["Tool progress", "SDKToolProgressMessage.type", "may break", true],
    ],
  );
});

test("a feature row asks to check an added name, and a long row name is cut at a word", () => {
  const diff = diffSurface(readSurface(before), readSurface(after));
  const name = `${"A feature that names a good many words ".repeat(4)}end`;
  const found = matches([{ name, feature: true, restsOn: ["Query"] }], diff, NO_COMMANDS);
  assert.deepEqual(
    found.map((m) => [m.name, m.kind]),
    [
      ["Query.rewindFiles", "added: check this row"],
      ["Query.stopTask", "may break"],
    ],
  );
  const line =
    report(diff, found)
      .split("\n")
      .find((l) => l.includes("check this row")) ?? "";
  assert.match(line, /^ {2}added: check this row: "A feature.* A\.\.\." \(Query\.rewindFiles/);
  assert.ok(line.length < 170);
});

test("a file or a cell the block cannot read costs the block, never the run", () => {
  assert.equal(addedToSdk(join(here, "no-such-sdk.d.ts"), NO_COMMANDS), null);
});

test("a row that names the owner type matches an added key as a prefix candidate", () => {
  const diff = diffSurface(readSurface(before), readSurface(after));
  const found = matches([{ name: "Options row", restsOn: ["Options"] }], diff, NO_COMMANDS);
  assert.deepEqual(
    found.map((m) => [m.name, m.kind, m.prefix]),
    [
      ["Options.notesDirectory", "may now be supported", true],
      ["Options.permissionMode", "may break", true],
    ],
  );
});

test("a new command a row lists is a fallen limit candidate, a gone one may break", () => {
  const rows = [
    { name: "Rewind", restsOn: ["/rewind"] },
    { name: "Plan", restsOn: ["/plan"] },
  ];
  const found = matches(rows, diffSurface(readSurface(before), readSurface(before)), {
    new: ["rewind"],
    gone: ["plan"],
  });
  assert.deepEqual(
    found.map((m) => [m.row, m.kind]),
    [
      ["Rewind", "may now be supported"],
      ["Plan", "may break"],
    ],
  );
});

test("the report lists additions, removals and the rows they could touch", () => {
  const diff = diffSurface(readSurface(before), readSurface(after));
  const text = report(
    diff,
    matches([{ name: "Rewind", restsOn: ["Query.rewindFiles"] }], diff, NO_COMMANDS),
  );
  assert.match(text, /^Added to the SDK:\n {2}declaration \(2\)\n {4}SDKFooMessage/);
  assert.match(text, /Removed from the SDK:/);
  assert.match(text, /system subtype \(1\)\n {4}system:foo_happened/);
  assert.match(text, /may now be supported: "Rewind" \(Query\.rewindFiles\)/);
});

test("a Rests on cell is backticked names, or empty; anything else is an error", () => {
  assert.deepEqual(restsOn("", "row"), []);
  assert.deepEqual(restsOn("`Query.stopTask`, `/rewind`, `system:task_started`", "row"), [
    "Query.stopTask",
    "/rewind",
    "system:task_started",
  ]);
  for (const bad of ["none", "Query.stopTask", "`two words`", "`a`, then b"]) {
    assert.throws(() => restsOn(bad, "row"), RangeError, bad);
  }
});

test("the pinned declarations are read, and a name is found by what declares it", () => {
  const surface = readSurface(pinned);
  assert.ok(surface.member.size > 1000);
  assert.ok(surface.member.has("Options.additionalDirectories"));
  assert.ok(surface.member.has("Query.interrupt"));
  assert.ok(surface["system subtype"].has("system:task_started"));
  assert.ok(declares(pinned, "SDKTaskStartedMessage"));
  assert.ok(declares(pinned, "Query.stopTask"));
  assert.ok(!declares(pinned, "Artifact"));
  assert.ok(!declares(pinned, "SDKNoSuchMessage"));
  assert.ok(!declares(pinned, "Options.noSuchKey"));
});

test("every name a Rests on cell gives exists in the pinned sdk.d.ts or the commands", () => {
  const commands = recorded();
  const limits = readLimits();
  const offeredByRows = new Set(notOffered());
  const rows = [...limits, ...features()];
  assert.ok(rows.filter((row) => row.restsOn.length > 0).length >= 20, "the seeded cells are gone");
  for (const row of rows) {
    for (const name of row.restsOn) {
      const command = /^\/(.+)$/.exec(name)?.[1];
      assert.ok(
        command !== undefined
          ? commands.has(command) || offeredByRows.has(command)
          : declares(pinned, name),
        `${row.name.slice(0, 50)}: ${name} is in neither sdk.d.ts nor the commands`,
      );
    }
  }
});
