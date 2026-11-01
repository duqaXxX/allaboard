import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FILE_BUTTONS,
  labels,
  OPEN_FIELD,
  OPEN_FIELD_BLOCK,
  OPEN_FILE,
  OPEN_FILE_ACTIONS,
  offered,
  type SearchShown,
  searchBlocks,
} from "../../../../src/chat/slack/openfile/search.ts";
import * as slackTexts from "../../../../src/chat/slack/texts.ts";
import { fill } from "../../../../src/core/texts.ts";

type Path = Array<string | number>;

/** What a payload holds at `path`: undefined where the shape stops. */
function at(value: unknown, ...path: Path): unknown {
  let found = value;
  for (const key of path) {
    if (typeof found !== "object" || found === null) return undefined;
    found = (found as Record<string | number, unknown>)[key];
  }
  return found;
}

function shown(paths: string[], extra: Partial<SearchShown> = {}): SearchShown {
  return { paths, count: paths.length, complete: true, ...extra };
}

// --- labels ---

test("a label is the last two segments of the path", () => {
  assert.deepEqual(labels(["src/chat/slack/openfile/modal.ts", "docs/setup.md", "README.md"]), [
    "openfile/modal.ts",
    "docs/setup.md",
    "README.md",
  ]);
});

test("two labels that collide are both shown as their paths", () => {
  assert.deepEqual(labels(["a/x/index.ts", "b/x/index.ts", "c/other.ts"]), [
    "a/x/index.ts",
    "b/x/index.ts",
    "c/other.ts",
  ]);
});

test("a path shown whole is shortened in its middle past 75 characters, keeping its end", () => {
  const [short, long] = labels(["p/x/index.ts", `${"q".repeat(90)}/x/index.ts`, "z/x/index.ts"]);
  assert.equal(short, "p/x/index.ts");
  assert.equal(Array.from(long ?? "").length, 75);
  assert.ok(long?.startsWith("qqq") && long.endsWith("/x/index.ts") && long.includes("…"));
});

test("names count code points, and a cut never lands inside one", () => {
  const [label] = labels([`${"😀".repeat(80)}.md`]);
  assert.equal(Array.from(label ?? "").length, 75);
  assert.ok(!label?.includes("�"));
});

test("a path longer than a button's value is not offered, and five are", () => {
  const paths = ["z".repeat(151), ...Array.from({ length: 12 }, (_, i) => `f${i}.py`)];
  assert.deepEqual(
    offered(paths),
    Array.from({ length: FILE_BUTTONS }, (_, i) => `f${i}.py`),
  );
  assert.deepEqual(offered(["y".repeat(150)]), ["y".repeat(150)]);
});

// --- the message ---

test("the message opens with the field: Enter sends, the words ride as the initial value", () => {
  const [field] = searchBlocks("", shown(["a.py"]));
  assert.deepEqual(field, {
    type: "input",
    block_id: OPEN_FIELD_BLOCK,
    dispatch_action: true,
    label: { type: "plain_text", text: slackTexts.OPEN_QUERY_LABEL },
    element: {
      type: "plain_text_input",
      action_id: OPEN_FIELD,
      max_length: 200,
      placeholder: { type: "plain_text", text: "Type part of a name" },
      dispatch_action_config: { trigger_actions_on: ["on_enter_pressed"] },
    },
  });
  const [typed] = searchBlocks("set<up", shown(["a.py"]));
  assert.equal(at(typed, "element", "initial_value"), "set<up");
});

test("a button for each file, as plain text with no emoji, carrying the path", () => {
  const [, actions] = searchBlocks("", shown(["docs/:tada:.md", "src/a/b.py"]));
  assert.equal(at(actions, "type"), "actions");
  assert.deepEqual(at(actions, "elements"), [
    {
      type: "button",
      action_id: `${OPEN_FILE}:0`,
      text: { type: "plain_text", text: "docs/:tada:.md", emoji: false },
      value: "docs/:tada:.md",
    },
    {
      type: "button",
      action_id: `${OPEN_FILE}:1`,
      text: { type: "plain_text", text: "a/b.py", emoji: false },
      value: "src/a/b.py",
    },
  ]);
});

test("the changed files say how many, and to type for the others", () => {
  const blocks = searchBlocks("", shown(["a.py", "b.py"]));
  assert.equal(
    at(blocks.at(-1), "elements", 0, "text"),
    fill(slackTexts.OPEN_CHANGED, { count: 2 }),
  );
  const one = searchBlocks("", shown(["a.py"]));
  assert.equal(at(one.at(-1), "elements", 0, "text"), slackTexts.OPEN_CHANGED_ONE);
  const seven = searchBlocks("", shown(Array.from({ length: 7 }, (_, i) => `f${i}.py`)));
  // Five buttons, and the one line: it already says to type for the others.
  assert.equal(seven.length, 3);
  assert.equal(
    at(seven.at(-1), "elements", 0, "text"),
    fill(slackTexts.OPEN_CHANGED, { count: 7 }),
  );
});

test("with nothing changed the message says to type, and has no buttons", () => {
  const blocks = searchBlocks("", shown([]));
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["input", "context"],
  );
  assert.equal(at(blocks[1], "elements", 0, "text"), slackTexts.OPEN_TYPE_A_NAME);
});

test("matches say how many, and that only the first are listed when there are more", () => {
  const paths = Array.from({ length: 9 }, (_, i) => `m${i}.py`);
  const blocks = searchBlocks("m", shown(paths, { count: 137 }));
  assert.equal(
    at(blocks[2], "elements", 0, "text"),
    fill(slackTexts.OPEN_ROWS_MATCH, { count: 137 }),
  );
  assert.equal(
    at(blocks[3], "elements", 0, "text"),
    fill(slackTexts.OPEN_MATCHES_CAPPED, { shown: 5, count: 137 }),
  );
  const one = searchBlocks("m", shown(["m.py"]));
  assert.equal(at(one.at(-1), "elements", 0, "text"), slackTexts.OPEN_ROWS_MATCH_ONE);
});

test("no match says so in the same message, and the field keeps the words", () => {
  const blocks = searchBlocks("zz<", shown([]));
  assert.equal(at(blocks[0], "element", "initial_value"), "zz<");
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["input", "context"],
  );
  assert.equal(
    at(blocks[1], "elements", 0, "text"),
    fill(slackTexts.OPEN_NO_MATCH, { words: "zz&lt;" }),
  );
  const partial = searchBlocks("zz", shown([], { complete: false }));
  assert.equal(
    at(partial[1], "elements", 0, "text"),
    fill(slackTexts.OPEN_NO_MATCH_PARTIAL, { words: "zz" }),
  );
});

test("a listing that was cut keeps its line under the matches", () => {
  const blocks = searchBlocks("m", shown(["m.py"], { complete: false }));
  assert.equal(at(blocks.at(-1), "elements", 0, "text"), slackTexts.OPEN_PARTIAL);
});

test("matches none of whose paths fit a button say so, and offer no button", () => {
  const blocks = searchBlocks("e", shown(["e".repeat(200)]));
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["input", "context", "context"],
  );
  assert.equal(at(blocks[2], "elements", 0, "text"), slackTexts.OPEN_MATCHES_TOO_LONG);
});

test("no two buttons of a message share an action_id, as Slack's reference asks", () => {
  const blocks = searchBlocks("", {
    paths: ["a.md", "b.md", "c.md", "d.md", "e.md"],
    count: 5,
    complete: true,
  });
  const ids = (blocks[1] as { elements: { action_id: string }[] }).elements.map((e) => e.action_id);
  assert.equal(new Set(ids).size, 5);
  assert.ok(ids.every((id) => OPEN_FILE_ACTIONS.test(id)));
});

test("words too long for the field are cut in it", () => {
  const blocks = searchBlocks("x".repeat(300), { paths: [], count: 0, complete: true });
  const input = blocks[0] as { element: { initial_value: string; max_length: number } };
  assert.equal(input.element.initial_value.length, input.element.max_length);
});
