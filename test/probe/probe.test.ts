import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  broken,
  CLAIMS,
  type Claim,
  canCertify,
  certificate,
  checklist,
  claim,
  evaluate,
  type Observation,
  observation,
  result,
} from "../../probe/claims.ts";
import { changes, notOffered, recorded, report } from "../../probe/commands.ts";
import { baselineOf, certified, compared, pinnedTo, storedResults } from "../../probe/main.ts";
import { writeObservations } from "../../probe/verdicts.ts";
import { type JsonObject, sdkRecords } from "../support/fixtures.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const GESTURE = claim(
  "P90",
  "gesture",
  "a gesture",
  "src/agent/claude/session.ts#ClaudeSession",
  "do it",
);
const MODEL = claim(
  "P91",
  "model",
  "a model act",
  "src/agent/claude/requests.ts#toRequest",
  "ask for it",
);

const OBSERVATIONS: [string, Claim, Observation | null, string][] = [
  ["gesture, caused and holds", GESTURE, observation(true, true), "HOLDS"],
  ["gesture, caused and absent", GESTURE, observation(true, false), "BROKEN"],
  ["gesture, not caused", GESTURE, observation(false, false), "UNPROVEN"],
  ["gesture, not attempted", GESTURE, null, "UNPROVEN"],
  ["model, caused and holds", MODEL, observation(true, true), "HOLDS"],
  // Claude decides a model claim: its absence proves nothing, so it is never broken.
  ["model, caused and absent", MODEL, observation(true, false), "UNPROVEN"],
  ["model, not caused", MODEL, observation(false, false), "UNPROVEN"],
];

for (const [name, subject, seen, outcome] of OBSERVATIONS) {
  test(`an observation becomes an outcome [${name}]`, () => {
    assert.equal(evaluate(subject, seen).outcome, outcome);
  });
}

test("a retired claim stays retired whatever the run saw", () => {
  const retired = claim(
    "P92",
    "gesture",
    "gone",
    "src/agent/claude/session.ts#ClaudeSession",
    "n/a",
    "measured",
  );
  assert.equal(evaluate(retired, observation(true, false)).outcome, "RETIRED");
});

test("a release is certified only when every gesture claim holds", () => {
  const holds = evaluate(GESTURE, observation(true, true));
  const unproven = evaluate(GESTURE, null);
  const modelUnproven = evaluate(MODEL, null);
  assert.ok(canCertify([holds, modelUnproven]));
  // A run that caused nothing breaks nothing, and certifies nothing either.
  assert.ok(!canCertify([unproven, modelUnproven]));
  assert.ok(!broken([unproven]) && broken([evaluate(GESTURE, observation(true, false))]));
});

test("the checklist lists what the run could not prove", () => {
  const results = [evaluate(GESTURE, observation(true, true)), evaluate(MODEL, null)];
  const text = checklist(results);
  assert.ok(
    text.includes("a model act") && text.includes("ask for it") && text.includes("toRequest"),
  );
  assert.ok(!text.includes("a gesture"));
  assert.equal(checklist(results.slice(0, 1)), "");
  // The kind says whether the claim blocks certification: a gesture does, a model claim does not.
  assert.match(text, /\[ \] P91 model {3}a model act/);
});

test("the baseline is the newest certified release below the probed one", () => {
  const entry = { cli: "2", date: "d", holds: [], open: [], retired: [] };
  const known = { "0.3.99": entry, "0.3.296": entry, "0.3.304": entry };
  assert.equal(baselineOf(known, "0.3.305"), "0.3.304");
  // Never the release itself, and numeric order: 0.3.99 is below 0.3.296.
  assert.equal(baselineOf(known, "0.3.304"), "0.3.296");
  assert.equal(baselineOf(known, "0.3.296"), "0.3.99");
  assert.equal(baselineOf(known, "0.3.99"), null);
  assert.equal(baselineOf({}, "0.3.1"), null);
});

test("a certified release reprints its comparison from what was stored", () => {
  const dir = mkdtempSync(join(tmpdir(), "allaboard-probe-test-"));
  const [first, second] = CLAIMS.filter((c) => c.retired === null);
  assert.ok(first && second);
  const stored = (a: number) => ({
    cli: "2",
    date: "d",
    claims: { [first.id]: { a }, [second.id]: { a: 1 } },
  });
  writeObservations(dir, "0.3.1", stored(1));
  writeObservations(dir, "0.3.2", stored(2));
  const entry = { cli: "2", date: "d", holds: [first.id, second.id], open: [], retired: [] };
  const known = { "0.3.1": entry, "0.3.2": entry };
  const results = storedResults(entry, stored(2));
  assert.deepEqual(
    results.map((r) => r.outcome),
    ["HOLDS", "HOLDS"],
  );
  const text = compared(results, known, dir, "2", "0.3.2");
  assert.match(text, /Compared with the observations of 0\.3\.1/);
  assert.match(text, new RegExp(`Changed \\(1\\)\\n {2}${first.id} `));
  assert.match(text, /~ a: 1 -> 2/);
  assert.match(text, /Unchanged \(1\)/);
});

test("a certificate that lists the limits that fell is read, one with other keys is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "allaboard-probe-test-"));
  const path = join(dir, "certified-versions.json");
  const entry = { cli: "2", date: "d", holds: [], open: [], retired: [] };
  writeFileSync(path, JSON.stringify({ "0.3.1": { ...entry, fell: ["L1"] }, "0.3.2": entry }));
  assert.deepEqual(Object.keys(certified(path)), ["0.3.1", "0.3.2"]);
  // `fell` is a list of strings: a string would make `includes` match `L1` in `L10`.
  for (const fell of ["L10", [1], null]) {
    writeFileSync(path, JSON.stringify({ "0.3.1": { ...entry, fell } }));
    assert.throws(() => certified(path), /not a map of SDK versions/);
  }
  writeFileSync(path, JSON.stringify({ "0.3.1": { ...entry, extra: [] } }));
  assert.throws(() => certified(path), /not a map of SDK versions/);
  const { fell: _, ...cut } = { ...entry, fell: [] };
  writeFileSync(path, JSON.stringify({ "0.3.1": { cli: "2", date: "d", holds: cut.holds } }));
  assert.throws(() => certified(path), /not a map of SDK versions/);
});

test("a certified release with a fallen limit reprints it as newly supported", () => {
  const dir = mkdtempSync(join(tmpdir(), "allaboard-probe-test-"));
  const entry = { cli: "2", date: "d", holds: [], open: [], retired: [], fell: ["L9"] };
  const stored = { cli: "2", date: "d", claims: {} };
  writeObservations(dir, "0.3.2", stored);
  const results = storedResults(entry, stored);
  assert.deepEqual(
    results.map((r) => [r.claim.id, r.outcome]),
    [["L9", "FELL"]],
  );
  const text = compared(results, { "0.3.2": entry }, dir, "2", "0.3.2");
  // The row L9 checks is read from the page and printed beside the claim.
  assert.match(text, /Newly supported \(1\)\n {2}L9 {3}limit /);
  assert.match(text, /limit: "A goal still set after a stop/);
  assert.match(text, /1 limit fell: change docs\/limits\.md\./);
});

test("the certificate holds ids and versions only", () => {
  const results = [evaluate(GESTURE, observation(true, true, "x")), evaluate(MODEL, null)];
  assert.deepEqual(certificate(results, "2.1.283", "2026-09-27"), {
    cli: "2.1.283",
    date: "2026-09-27",
    holds: ["P90"],
    open: ["P91"],
    retired: [],
  });
});

/**
 * What a claim's `guards` names: `<file of the repository>#<export>` or
 * `<file>#<class>.<member>`, resolved by importing the file. A renamed symbol would send
 * whoever reads a broken claim to nothing.
 */
async function guarded(guards: string): Promise<unknown> {
  const [file, symbol] = guards.split("#");
  assert.ok(file !== undefined && symbol !== undefined, `${guards} is not <file>#<symbol>`);
  const loaded: Record<string, unknown> = await import(pathToFileURL(join(ROOT, file)).href);
  const [name, ...members] = symbol.split(".");
  let target = loaded[name ?? ""];
  assert.ok(target !== undefined, `${file} exports no ${name}`);
  for (const member of members) {
    const holder = target as { prototype?: Record<string, unknown> } & Record<string, unknown>;
    const next: unknown = holder[member] ?? holder.prototype?.[member];
    assert.ok(next !== undefined, `${name} has no ${member}`);
    target = next;
  }
  return target;
}

for (const each of CLAIMS) {
  test(`every claim names a symbol that exists [${each.id}]`, async () => {
    await guarded(each.guards);
  });
}

test("claim ids are unique", () => {
  assert.equal(new Set(CLAIMS.map((c) => c.id)).size, CLAIMS.length);
});

test("every claim belongs to exactly one scene", async () => {
  const { SCENES } = await import("../../probe/scenes.ts");
  const owned = Object.values(SCENES).flat();
  assert.deepEqual([...owned].sort(), CLAIMS.map((c) => c.id).sort());
});

test("a model claim cannot be made broken by hand", () => {
  assert.throws(() => result(MODEL, "BROKEN", ""));
});

test("a behaviour cannot hold without its event", () => {
  assert.throws(() => observation(false, true));
});

for (const id of ["p1", "P0", "1", "P1 "]) {
  test(`a claim id is p and a number [${id}]`, () => {
    assert.throws(() =>
      claim(id, "gesture", "t", "src/agent/claude/session.ts#ClaudeSession", "how"),
    );
  });
}

test("the pin moves only when there is exactly one", () => {
  const name = "@anthropic-ai/claude-agent-sdk";
  assert.equal(
    pinnedTo(`{"dependencies": {"${name}": "0.3.296"}}`, "0.3.297"),
    `{"dependencies": {"${name}": "0.3.297"}}`,
  );
  // A pin written another way would leave the old SDK installed and certify it as the new one.
  for (const other of [
    `{"${name}": "^0.3.296"}`,
    `{"${name}": ">=0.3.296"}`,
    `{"${name}": "0.3.296", "x": {"${name}": "0.3.1"}}`,
    "",
  ]) {
    assert.throws(() => pinnedTo(other, "0.3.297"));
  }
});

test("a certificate file of another shape is refused", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "allaboard-probe-test-")),
    "certified-versions.json",
  );
  assert.deepEqual(certified(path), {});
  const entry = { cli: "2.1.283", date: "2026-09-27", holds: [], open: [], retired: [] };
  writeFileSync(path, JSON.stringify({ "0.2.160": entry }));
  assert.deepEqual(certified(path), { "0.2.160": entry });
  writeFileSync(path, JSON.stringify({ "0.2.160": { cli: "2.1.283" } }));
  assert.throws(() => certified(path));
});

test("the probe runs when started through a symlink, as `--latest` starts it under macOS's tmpdir", () => {
  // `/var` on macOS links to `/private/var`: a guard comparing `process.argv[1]` with the
  // module's own path skipped `main`, and the run in the worktree exited 0 having done nothing.
  const link = join(mkdtempSync(join(tmpdir(), "allaboard-probe-test-")), "probe");
  symlinkSync(join(ROOT, "probe"), link);
  // An unknown option is refused by `main` alone: a run that never reached it exits 0.
  const run = spawnSync(process.execPath, [join(link, "main.ts"), "--no-such-option"], {
    encoding: "utf8",
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /no-such-option/);
});

// --- The commands of a release (probe/commands.ts) ---------------------------------------------

test("the commands not offered are read from the limits page", () => {
  const names = notOffered();
  for (const expected of ["rewind", "plan", "cd", "voice"])
    assert.ok(names.includes(expected), expected);
  assert.equal(new Set(names).size, names.length);
});

const PAGES: [string, string][] = [
  [
    "a table in another section",
    "# Limits\n\n## Limits of Slack\n\n| a | b |\n|---|---|\n| x | `/rewind` |\n",
  ],
  [
    "a table that names no command",
    "# Limits\n\n## Limits of the Claude Agent SDK\n\n| a | b |\n|---|---|\n| x | words |\n",
  ],
];

for (const [name, page] of PAGES) {
  test(`a limits page that names no command is an error [${name}]`, () => {
    // A page that lists nothing would make the claim hold on nothing.
    const path = join(mkdtempSync(join(tmpdir(), "allaboard-probe-test-")), "limits.md");
    writeFileSync(path, page);
    assert.throws(() => notOffered(path), /limits\.md/);
  });
}

test("new and gone commands are told apart", () => {
  const found = changes(
    new Set(["compact", "model", "brand-new"]),
    new Set(["compact", "model", "retired"]),
  );
  assert.deepEqual(found, { new: ["brand-new"], gone: ["retired"] });
  const told = report(found, "9.9.9");
  assert.ok(told.includes("[ ] /brand-new") && told.includes("[ ] /retired"));
  assert.ok(told.includes("test/fixtures/sdk/server-info.json"));
  const same = report(changes(new Set(["compact"]), new Set(["compact"])), "9.9.9");
  assert.equal(same, "Commands: the same as recorded (Claude Code 9.9.9).");
});

test("the recorded commands are the fixture s", () => {
  const names = recorded();
  for (const expected of ["compact", "model", "clear"]) assert.ok(names.has(expected), expected);
});

// --- The scenes' helpers (probe/scenes.ts) -------------------------------------------------------

test("a wait that ran out or a system error is the machine's, any other failure is the SDK's", async () => {
  const { isEnvironment, ProbeTimeout } = await import("../../probe/scenes.ts");
  assert.ok(isEnvironment(new ProbeTimeout("a turn did not end in time")));
  assert.ok(isEnvironment(Object.assign(new Error("reset"), { code: "ECONNRESET" })));
  assert.ok(!isEnvironment(new TypeError("undefined is not a function")));
  assert.ok(!isEnvironment(Object.assign(new Error("x"), { code: "invalid_request" })));
});

test("a number counts only when it is written alone on a line", async () => {
  const { counted } = await import("../../probe/scenes.ts");
  assert.deepEqual([...counted("from 1 to 2000\n1\n2\n 3 \nthree\n4.5")].sort(), [1, 2, 3]);
});

test("the probe's image is a valid PNG of one pixel", async () => {
  const { onePixelPng } = await import("../../probe/scenes.ts");
  const png = Buffer.from(onePixelPng());
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.subarray(12, 16).toString("latin1"), "IHDR");
  assert.equal(png.readUInt32BE(16), 1);
  assert.equal(png.readUInt32BE(20), 1);
  assert.equal(png.subarray(-8, -4).toString("latin1"), "IEND");
});

test("the models are listed when each has a value and a name and its effort levels", async () => {
  const { modelsListed } = await import("../../probe/scenes.ts");
  const fine = {
    value: "a",
    displayName: "A",
    supportsEffort: true,
    supportedEffortLevels: ["low"],
  };
  assert.ok(modelsListed([fine, { value: "b", displayName: "B", supportsEffort: false }]).holds);
  assert.ok(!modelsListed([]).holds);
  assert.ok(!modelsListed([{ value: "a", supportsEffort: false }]).holds);
  assert.ok(!modelsListed([{ ...fine, supportedEffortLevels: [] }]).holds);
  assert.ok(!modelsListed([fine, "not a record"]).holds);
});

test("computer use is judged only when the control server shows the folder's entry was read", async () => {
  const { judgeComputerUse } = await import("../../probe/scenes.ts");
  const read = { name: "control", status: "disabled" };
  // Absent beside a control that was read: the limit stands.
  assert.deepEqual(judgeComputerUse([read]), {
    caused: true,
    holds: true,
    detail: "",
    seen: { servers: ["control disabled"] },
  });
  // Listed, whatever its status: the limit is gone.
  const listed = judgeComputerUse([read, { name: "computer-use", status: "connected" }]);
  assert.equal(listed.caused, true);
  assert.equal(listed.holds, false);
  assert.match(listed.detail, /computer-use connected/);
  // The control missing or not disabled: the entry was not read, so its absence says nothing.
  for (const servers of [[], [{ name: "control", status: "connected" }]]) {
    const unread = judgeComputerUse(servers);
    assert.equal(unread.caused, false);
    assert.equal(unread.holds, false);
  }
});

test("a turn opened by a task's notification is judged on what came before its result", async () => {
  const { judgeWake } = await import("../../probe/scenes.ts");
  // background-forms.jsonl (CLI 2.1.300): three turns opened by notifications, none of them
  // after a user record of that origin. The limit stands.
  const recorded = sdkRecords("background-forms");
  assert.deepEqual(judgeWake(recorded), {
    caused: true,
    holds: true,
    detail: "",
    seen: {},
  });
  // The same with a user record of that origin before the first such result, as a release
  // that sends what woke the turn would: the limit is gone. The record is the wire's user
  // message with an origin of the kind sdk.d.ts 0.3.300 defines.
  const opened = recorded.findIndex(
    (record) => record.type === "result" && isRecordOrigin(record, "task-notification"),
  );
  const woke = {
    type: "user",
    message: { role: "user", content: "Monitor event: tick two" },
    parent_tool_use_id: null,
    origin: { kind: "task-notification" },
  };
  const told = judgeWake([...recorded.slice(0, opened), woke, ...recorded.slice(opened)]);
  assert.equal(told.caused, true);
  assert.equal(told.holds, false);
  assert.match(told.detail, /tick two/);
  // No notification, or no turn it opened: nothing was learned.
  const owners = recorded.slice(0, recorded.findIndex((record) => record.type === "result") + 1);
  assert.equal(judgeWake(owners).caused, false);
});

// The shape of the first main-loop request Claude Code 2.1.302 wrote with
// OTEL_LOG_RAW_API_BODIES=file:<dir> (recorded 2026-10-19, `query_source` sdk): `system` as text
// blocks, `tools` with a description and an input schema. The content is synthetic.
function terminalRequest(
  over: { system?: string; agent?: string[]; bash?: string; question?: string } = {},
) {
  const agentProperties = over.agent ?? ["description", "prompt", "subagent_type", "model"];
  return {
    model: "claude-haiku-5-5",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    system: [
      { type: "text", text: "A billing header" },
      {
        type: "text",
        text: over.system ?? "# Harness\n# Session-specific guidance\n# Context management\n",
      },
    ],
    tools: [
      {
        name: "Agent",
        description: "Launch a subagent",
        input_schema: {
          type: "object",
          properties: Object.fromEntries(agentProperties.map((name) => [name, { type: "string" }])),
        },
      },
      {
        name: "Bash",
        description:
          over.bash ??
          "- `timeout` is in milliseconds: default 5400000, max 5400000 for a foreground command.",
        input_schema: { type: "object", properties: { command: { type: "string" } } },
      },
      {
        name: "AskUserQuestion",
        description:
          over.question ??
          "Ask the user a question.\n\nPreview feature:\nUse the optional `preview` field on options.",
        input_schema: { type: "object", properties: { questions: { type: "array" } } },
      },
    ],
    stream: true,
  };
}

test("the terminal's form is judged on the first request's prompt, Agent, Bash and AskUserQuestion tools", async () => {
  const { judgeTerminalForm } = await import("../../probe/scenes.ts");
  assert.deepEqual(judgeTerminalForm(terminalRequest(), "5400000"), {
    caused: true,
    holds: true,
    detail: "",
    seen: {},
  });
  // Each option gone breaks the claim and the detail names it alone.
  const minimal = judgeTerminalForm(terminalRequest({ system: "You are Claude Code." }), "5400000");
  assert.equal(minimal.holds, false);
  assert.match(minimal.detail, /lacks the preset's sections/);
  const background = judgeTerminalForm(
    terminalRequest({ agent: ["prompt", "run_in_background"] }),
    "5400000",
  );
  assert.equal(background.holds, false);
  assert.match(background.detail, /run_in_background/);
  const timeout = judgeTerminalForm(
    terminalRequest({ bash: "`timeout` is in milliseconds: default 120000, max 600000" }),
    "5400000",
  );
  assert.equal(timeout.holds, false);
  assert.match(timeout.detail, /default of 120000, not 5400000/);
  assert.doesNotMatch(timeout.detail, /preset|Agent/);
  const previews = judgeTerminalForm(
    terminalRequest({ question: "Ask the user a question." }),
    "5400000",
  );
  assert.equal(previews.holds, false);
  assert.equal(previews.detail, "the AskUserQuestion tool says nothing of previews");
  // A request that is not the main one says nothing about the options.
  for (const body of [null, { system: [], tools: [] }, { ...terminalRequest(), tools: [] }]) {
    const unread = judgeTerminalForm(body, "5400000");
    assert.equal(unread.caused, false);
    assert.equal(unread.holds, false);
  }
});

function isRecordOrigin(record: JsonObject, kind: string): boolean {
  const origin = record.origin;
  return typeof origin === "object" && origin !== null && (origin as JsonObject).kind === kind;
}

// P29 needs no token, so the scene that proves it runs here, on the installed SDK.
test("P29: the SDK lists a transcript under the folder CLAUDE_CONFIG_DIR names", async () => {
  const { configFolderListing } = await import("../../probe/scenes.ts");
  // The real path, as the probe's own root is: Claude Code names a project by it.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "allaboard-probe-test-")));
  const before = process.env.CLAUDE_CONFIG_DIR;
  const seen = await configFolderListing(root);
  assert.deepEqual(seen.P29, observation(true, true, ""));
  // The environment is back as it was: the sessions of the scenes after it inherit it.
  assert.equal(process.env.CLAUDE_CONFIG_DIR, before);
});

// P31 needs no token either: the scene writes a transcript of its own and tags it.
test("P31: the SDK sets, changes and clears the tag of a transcript", async () => {
  const { sessionTag } = await import("../../probe/scenes.ts");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "allaboard-probe-test-")));
  const before = process.env.CLAUDE_CONFIG_DIR;
  const seen = await sessionTag(root);
  assert.deepEqual(seen.P31, observation(true, true, ""));
  assert.equal(process.env.CLAUDE_CONFIG_DIR, before);
});

// The Bash description of Claude Code 2.1.304 (measured 2026-10-21), cut to its time-limit lines.
const BASH_DESCRIPTION =
  "Executes a bash command.\n" +
  "- `timeout` is in milliseconds: default 120000, max 600000 for a foreground command.\n" +
  "- `run_in_background` runs the command detached: it keeps running across turns and re-invokes " +
  "you when it exits. With it, `timeout` is how long the command may run in the background " +
  "(default 1800000, max 7200000); at that limit it is stopped and you are re-invoked.";

test("the Bash limits hold on the three values and the stop, and are unproven on a reworded tool", async () => {
  const { judgeBashLimits } = await import("../../probe/scenes.ts");
  assert.deepEqual(judgeBashLimits(BASH_DESCRIPTION), {
    caused: true,
    holds: true,
    detail: "",
    seen: {},
  });
  // A number changed on its own: the control is there, the limit fell.
  for (const [from, to] of [
    ["default 120000", "default 180000"],
    ["(default 1800000", "(default 3600000"],
  ] as const) {
    const fell = judgeBashLimits(BASH_DESCRIPTION.replace(from, to));
    assert.equal(fell.caused, true, from);
    assert.equal(fell.holds, false, from);
  }
  // A sentence worded another way keeps the numbers or loses them: a reworded tool, never a limit
  // that fell.
  for (const [from, to] of [
    ["(default 1800000", "(defaults to 1800000"],
    ["in the background (default 1800000", "while backgrounded (default 1800000"],
    ["at that limit it is stopped", "at that limit it is killed"],
    ["at that limit it is stopped", "when it reaches the limit it is stopped"],
  ] as const) {
    const reworded = judgeBashLimits(BASH_DESCRIPTION.replace(from, to));
    assert.equal(reworded.caused, false, to);
    assert.equal(reworded.holds, false, to);
  }
  // No sentence on `timeout`, or no description: nothing was read.
  for (const text of ["Executes a bash command.", undefined, 7]) {
    assert.equal(judgeBashLimits(text).caused, false);
  }
});

test("state events are judged on a turn that began and ended", async () => {
  const { judgeStateEvents } = await import("../../probe/scenes.ts");
  const init = { type: "system", subtype: "init" };
  const result = { type: "result", subtype: "success" };
  assert.equal(judgeStateEvents([init, { type: "assistant" }, result]).holds, true);
  const told = judgeStateEvents([
    { type: "system", subtype: "session_state_changed", state: "running" },
    init,
    result,
  ]);
  assert.equal(told.caused, true);
  assert.equal(told.holds, false);
  // A turn that never began or never ended proves nothing.
  assert.equal(judgeStateEvents([init]).caused, false);
  assert.equal(judgeStateEvents([]).caused, false);
});

test("the tool list holds none of the three tools, and is unproven when it holds no known tool", async () => {
  const { judgeToolList } = await import("../../probe/scenes.ts");
  const tools = ["Bash", "Skill", "ToolSearch", "Read"];
  assert.equal(judgeToolList(tools).holds, true);
  for (const name of ["Artifact", "SendFeedback", "EndConversation"]) {
    const listed = judgeToolList([...tools, name]);
    assert.equal(listed.caused, true);
    assert.equal(listed.holds, false);
    assert.match(listed.detail, new RegExp(name));
  }
  assert.equal(judgeToolList([]).caused, false);
  assert.equal(judgeToolList(["Read"]).caused, false);
});

const PRESET =
  "# Harness\n# Session-specific guidance\n - When the user types `/<skill-name>`, invoke it via " +
  "Skill.\n# Context management\n";

test("the identity line is judged beside the preset's sections", async () => {
  const { judgeIdentity } = await import("../../probe/scenes.ts");
  const sdk = "You are a Claude agent, built on Anthropic's Claude Agent SDK.\n";
  const cli = "You are Claude Code, Anthropic's official CLI for Claude.\n";
  assert.equal(judgeIdentity(sdk + PRESET).holds, true);
  const fell = judgeIdentity(cli + PRESET);
  assert.equal(fell.caused, true);
  assert.equal(fell.holds, false);
  // A third wording, or a prompt that is not the preset's: a reworded prompt proves nothing.
  assert.equal(judgeIdentity(`You are a helper.\n${PRESET}`).caused, false);
  assert.equal(judgeIdentity(sdk).caused, false);
});

test("the hint on `!` is judged beside the line that follows it in the terminal's prompt", async () => {
  const { judgeBangHint } = await import("../../probe/scenes.ts");
  assert.equal(judgeBangHint(PRESET).holds, true);
  const hint = `you can suggest that they type \`! <command>\` in the prompt\n${PRESET}`;
  const fell = judgeBangHint(hint);
  assert.equal(fell.caused, true);
  assert.equal(fell.holds, false);
  // The neighbouring line is gone: the section may have been reworded around the hint.
  assert.equal(judgeBangHint("# Session-specific guidance\n# Context management\n").caused, false);
});

test("agents and skills are judged beside a list that holds a general-purpose agent", async () => {
  const { judgeAgentsAndSkills } = await import("../../probe/scenes.ts");
  const agents = ["claude", "Explore", "general-purpose", "Plan"];
  const skills = ["debug", "loop"];
  assert.equal(judgeAgentsAndSkills(agents, skills).holds, true);
  for (const [more, extra] of [
    [[...agents, "claude-code-guide"], skills],
    [agents, [...skills, "artifact-design"]],
    [agents, [...skills, "artifact-diagramming"]],
    [agents, [...skills, "artifact-capabilities"]],
  ] as const) {
    const fell = judgeAgentsAndSkills(more, extra);
    assert.equal(fell.caused, true);
    assert.equal(fell.holds, false);
  }
  assert.equal(judgeAgentsAndSkills([], skills).caused, false);
  assert.equal(judgeAgentsAndSkills(agents, []).caused, false);
});

test("the compaction instructions are judged in the SDK's form or the terminal's", async () => {
  const { judgeCompactionForm } = await import("../../probe/scenes.ts");
  const sdk =
    "CRITICAL: Respond with TEXT ONLY.\n1. Primary Request and Intent: ...\n<summary>\n</summary>";
  const terminal =
    "Summarize the entire conversation above in 2000 words or fewer. Output only the summary, " +
    "inside <summary></summary> tags.";
  assert.equal(judgeCompactionForm(sdk).holds, true);
  const fell = judgeCompactionForm(terminal);
  assert.equal(fell.caused, true);
  assert.equal(fell.holds, false);
  // No request, or one in neither form: a refused compaction or a reworded prompt proves nothing.
  assert.equal(judgeCompactionForm(null).caused, false);
  assert.equal(judgeCompactionForm("Summarize this <summary>").caused, false);
});

test("the goal stream is judged on a turn that said the goal was set", async () => {
  const { judgeGoalStream } = await import("../../probe/scenes.ts");
  const said = {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Goal set: say tick" }] },
  };
  const result = { type: "result", subtype: "success" };
  assert.equal(judgeGoalStream([said, result]).holds, true);
  const fell = judgeGoalStream([said, { type: "active_goal", value: { condition: "x" } }, result]);
  assert.equal(fell.caused, true);
  assert.equal(fell.holds, false);
  assert.equal(judgeGoalStream([result]).caused, false);
  assert.equal(judgeGoalStream([said]).caused, false);
});

test("a limit claim is FELL, never BROKEN, and a scene that proved nothing leaves it UNPROVEN", () => {
  const limit = claim("L90", "limit", "a limit", "src/core/commands.ts#parseBang", "how");
  assert.equal(evaluate(limit, observation(true, true)).outcome, "HOLDS");
  assert.equal(evaluate(limit, observation(true, false)).outcome, "FELL");
  assert.equal(evaluate(limit, observation(false, false)).outcome, "UNPROVEN");
  assert.equal(evaluate(limit, null).outcome, "UNPROVEN");
  assert.throws(() => result(limit, "BROKEN", ""));
  assert.throws(() => result(GESTURE, "FELL", ""));
  assert.throws(() => claim("Q1", "limit", "t", "g", "h"));
});

test("a fallen limit does not block a certificate, is listed in it and in the checklist only when unproven", () => {
  const limit = claim("L90", "limit", "a limit", "src/core/commands.ts#parseBang", "how");
  const unproven = claim("L91", "limit", "another limit", "src/core/commands.ts#parseBang", "how");
  const results = [
    evaluate(GESTURE, observation(true, true)),
    evaluate(limit, observation(true, false, "gone")),
    evaluate(unproven, null),
  ];
  assert.equal(canCertify(results), true);
  assert.equal(broken(results), false);
  assert.deepEqual(certificate(results, "2.1.1", "2026-10-21"), {
    cli: "2.1.1",
    date: "2026-10-21",
    holds: ["P90"],
    open: ["L91"],
    retired: [],
    fell: ["L90"],
  });
  const text = checklist(results);
  assert.match(text, /L91 limit/);
  assert.doesNotMatch(text, /L90/);
});

test("a scene that raised leaves its limit claims unproven and breaks its gesture claims", async () => {
  const { raised } = await import("../../probe/scenes.ts");
  const seen = raised(["P23", "P28"], new Error("the SDK rejected"), "scene raised");
  assert.equal(evaluate(CLAIMS.find((c) => c.id === "P23") as Claim, seen.P23).outcome, "UNPROVEN");
  assert.equal(evaluate(CLAIMS.find((c) => c.id === "P28") as Claim, seen.P28).outcome, "BROKEN");
});

test("the commands not offered are judged on the refusal Claude Code gives", async () => {
  const { judgeNotOffered } = await import("../../probe/scenes.ts");
  const refusal = (name: string) => `/${name} isn't available in this environment.`;
  const all = new Map([
    ["rewind", refusal("rewind")],
    ["plan", refusal("plan")],
  ]);
  assert.equal(judgeNotOffered(all).holds, true);
  // One answered otherwise while another still refuses: that one is named, the limit fell.
  const fell = judgeNotOffered(new Map([...all, ["cd", "Changed directory"]]));
  assert.equal(fell.caused, true);
  assert.equal(fell.holds, false);
  assert.match(fell.detail, /answered otherwise: \/cd/);
  // A reworded refusal or a removed command in every answer proves nothing about the limits.
  for (const text of ["/rewind is not available", "Unknown command: /rewind"]) {
    const reworded = judgeNotOffered(
      new Map([
        ["rewind", text],
        ["plan", text],
      ]),
    );
    assert.equal(reworded.caused, false, text);
    assert.equal(reworded.holds, false, text);
  }
  // A command that got no answer proves nothing either.
  const silent = judgeNotOffered(new Map([...all, ["cd", " "]]));
  assert.equal(silent.caused, false);
  assert.match(silent.detail, /no answer to \/cd/);
});

test("a /model override is judged only when setModel took and a request named its model", async () => {
  const { judgeModelOverride } = await import("../../probe/scenes.ts");
  const haiku = ["claude-haiku-5-5"];
  assert.equal(judgeModelOverride(true, "claude-sonnet-5-5", true, haiku).holds, true);
  const fell = judgeModelOverride(true, "claude-sonnet-5-5", true, ["claude-sonnet-5-5"]);
  assert.equal(fell.caused, true);
  assert.equal(fell.holds, false);
  // setModel did nothing, no alias, no request: nothing was learned about the override.
  for (const seen of [
    judgeModelOverride(true, "claude-sonnet-5-5", false, ["claude-sonnet-5-5"]),
    judgeModelOverride(false, "claude-sonnet-5-5", false, haiku),
    judgeModelOverride(true, "claude-sonnet-5-5", true, []),
  ]) {
    assert.equal(seen.caused, false);
    assert.equal(seen.holds, false);
  }
});

test("the plain-session scene puts back the variables it removed when it throws", async () => {
  const { plainSession } = await import("../../probe/scenes.ts");
  const names = ["BASH_DEFAULT_TIMEOUT_MS", "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS"];
  const before = names.map((name) => process.env[name]);
  process.env.BASH_DEFAULT_TIMEOUT_MS = "123";
  delete process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS;
  try {
    // A folder that does not exist makes the first mkdir throw, before any session starts.
    const missing = join(mkdtempSync(join(tmpdir(), "allaboard-probe-test-")), "gone");
    await assert.rejects(plainSession({ root: missing } as never));
    assert.equal(process.env.BASH_DEFAULT_TIMEOUT_MS, "123");
    assert.equal(process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, undefined);
  } finally {
    names.forEach((name, at) => {
      const value = before[at];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
});
