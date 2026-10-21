/**
 * What the host layer asks of npm: the latest version, whether a version is published, whether the
 * running copy is the one `npm install -g` replaces, and the install itself. npm is faked at
 * `RunAsync` with the shapes measured on npm 11.17.0 (2026-10-17); the folders are real, under a
 * temporary directory, since the answers depend on real paths and links.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  classifyFailure,
  installVersion,
  isNewer,
  isVersion,
  latestVersion,
  publishedVersion,
  updatableCopy,
} from "../../src/host/npm.ts";
import type { CommandResult, RunAsync } from "../../src/host/run.ts";
import { setLevel, setWriter } from "../../src/log.ts";

// The failed installs below log npm's words; the lines are not wanted in the test report.
setWriter(() => {});

const ok = (stdout: string): CommandResult => ({ status: 0, stdout, stderr: "" });

// npm's own words for the failures measured on 2026-10-17 (npm 11.17.0).
const REFUSED: CommandResult = {
  status: 1,
  stdout: "",
  stderr: [
    "npm error code ECONNREFUSED",
    "npm error syscall connect",
    "npm error errno ECONNREFUSED",
    "npm error network request to http://127.0.0.1:9/allaboard failed, reason: connect ECONNREFUSED",
    "npm error network This is a problem related to network connectivity.",
  ].join("\n"),
};
const folder = (prefix: string) => `${prefix}/lib/node_modules/allaboard`;
const unwritable = (prefix: string): CommandResult => ({
  status: 243,
  stdout: "",
  stderr: [
    "npm error code EACCES",
    "npm error syscall rename",
    `npm error path ${folder(prefix)}`,
    `npm error dest ${prefix}/lib/node_modules/.allaboard-a1b2c3d4`,
    "npm error errno -13",
    "npm error Error: EACCES: permission denied, rename",
  ].join("\n"),
});
const NOT_FOUND: CommandResult = {
  status: 1,
  stdout: '{\n  "error": {\n    "code": "E404"\n  }\n}\n',
  stderr: "npm error code E404\nnpm error 404 No match found for version 9.9.9\n",
};

interface Call {
  command: string;
  args: readonly string[];
  signal?: AbortSignal;
}

/** A `RunAsync` answering by the command line, recording every call; unknown lines fail loudly. */
function fakeNpm(answers: Record<string, CommandResult>): RunAsync & { calls: Call[] } {
  const calls: Call[] = [];
  const run = (async (command: string, args: readonly string[], signal?: AbortSignal) => {
    calls.push(signal === undefined ? { command, args } : { command, args, signal });
    const line = `${command} ${args.join(" ")}`;
    const answer = answers[line];
    if (answer === undefined) throw new Error(`unexpected command: ${line}`);
    return answer;
  }) as RunAsync & { calls: Call[] };
  run.calls = calls;
  return run;
}

function scratch(t: { after(fn: () => void): void }): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "allaboard-npm-")));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

/** A global prefix under `base` holding a copy of the package at `version`; returns the paths. */
function globalCopy(base: string, version: string | null) {
  const root = join(base, "lib", "node_modules");
  const copy = join(root, "allaboard");
  mkdirSync(join(copy, "dist"), { recursive: true });
  writeFileSync(join(copy, "dist", "main.js"), "");
  if (version !== null) writeFileSync(join(copy, "package.json"), JSON.stringify({ version }));
  return { root, copy, main: join(copy, "dist", "main.js") };
}

test("isVersion accepts a semantic version and nothing that npm could read as more", () => {
  for (const text of ["0.2.0", "10.20.30", "1.0.0-rc.1", "1.0.0-0"])
    assert.equal(isVersion(text), true);
  for (const text of [
    "",
    "1.2",
    "v1.2.3",
    "01.2.3",
    "1.2.3 ",
    "1.2.3\n",
    "1.2.3+build",
    "latest",
    "^1.2.3",
    "1.2.3 --global",
    "-g",
    "../x",
  ]) {
    assert.equal(isVersion(text), false, JSON.stringify(text));
  }
});

test("a registry that cannot be reached is a network failure", () => {
  assert.deepEqual(classifyFailure(REFUSED), { kind: "network" });
});

test("every code that means the network is down is a network failure", () => {
  for (const code of [
    "ECONNREFUSED",
    "ENOTFOUND",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ECONNRESET",
    "ENETUNREACH",
  ]) {
    const result = { status: 1, stdout: "", stderr: `npm error code ${code}\n` };
    assert.deepEqual(classifyFailure(result), { kind: "network" }, code);
  }
});

test("a folder npm may not write to is a permission failure naming the folder npm names", () => {
  assert.deepEqual(classifyFailure(unwritable("/opt/prefix")), {
    kind: "permission",
    path: folder("/opt/prefix"),
  });
  const bare = { status: 1, stdout: "", stderr: "npm error code EPERM\n" };
  assert.deepEqual(classifyFailure(bare), { kind: "permission", path: null });
});

test("any other failure is reported by its exit status", () => {
  assert.deepEqual(classifyFailure(NOT_FOUND), { kind: "other", status: 1 });
  assert.deepEqual(classifyFailure({ status: 137, stdout: "", stderr: "" }), {
    kind: "other",
    status: 137,
  });
  assert.deepEqual(classifyFailure({ status: null, stdout: "", stderr: "spawn npm ENOENT" }), {
    kind: "other",
    status: null,
  });
});

test("the latest version is the string npm view prints, read as JSON", async () => {
  const run = fakeNpm({ "npm view allaboard version --json": ok('"0.2.0"\n') });
  assert.deepEqual(await latestVersion(run), { version: "0.2.0" });
  assert.deepEqual(run.calls, [
    { command: "npm", args: ["view", "allaboard", "version", "--json"] },
  ]);
});

test("an answer that is no version is a failure, whatever the exit status", async () => {
  for (const stdout of ['"latest"\n', '["0.1.0","0.2.0"]\n', "0.2.0\n", "", '"0.2.0; rm -rf"\n']) {
    const run = fakeNpm({ "npm view allaboard version --json": ok(stdout) });
    assert.deepEqual(await latestVersion(run), { failure: { kind: "other", status: 0 } }, stdout);
  }
});

test("a latest version that cannot be read carries npm's failure", async () => {
  const refused = fakeNpm({ "npm view allaboard version --json": REFUSED });
  assert.deepEqual(await latestVersion(refused), { failure: { kind: "network" } });
  const none = fakeNpm({ "npm view allaboard version --json": { ...REFUSED, status: null } });
  assert.deepEqual(await latestVersion(none), { failure: { kind: "network" } });
});

test("a published version is told by npm view, an unknown one by its 404", async () => {
  const run = fakeNpm({
    "npm view allaboard@0.2.0 version --json": ok('"0.2.0"\n'),
    "npm view allaboard@9.9.9 version --json": NOT_FOUND,
    "npm view allaboard@0.3.0 version --json": REFUSED,
  });
  assert.deepEqual(await publishedVersion(run, "0.2.0"), { published: true });
  assert.deepEqual(await publishedVersion(run, "9.9.9"), { published: false });
  assert.deepEqual(await publishedVersion(run, "0.3.0"), { failure: { kind: "network" } });
});

test("a version that is not a version is not asked about", async () => {
  const run = fakeNpm({});
  assert.deepEqual(await publishedVersion(run, "1.0.0 --global"), { published: false });
  assert.deepEqual(run.calls, []);
});

test("the signal reaches every npm command a question or an install runs", async (t) => {
  const { root, main, copy } = globalCopy(scratch(t), "0.2.0");
  const run = fakeNpm({
    "npm view allaboard version --json": ok('"0.3.0"\n'),
    "npm view allaboard@0.2.0 version --json": ok('"0.2.0"\n'),
    "npm root -g": ok(`${root}\n`),
    [INSTALL]: ok(""),
  });
  const { signal } = new AbortController();
  await latestVersion(run, signal);
  await publishedVersion(run, "0.2.0", signal);
  await updatableCopy(run, main, "0.2.0", signal);
  await installVersion(run, copy, "0.3.0", signal);
  assert.equal(run.calls.length, 5);
  for (const call of run.calls) assert.equal(call.signal, signal, call.args.join(" "));
});

test("the copy npm install -g replaces, at a published version, is updatable", async (t) => {
  const { root, copy, main } = globalCopy(scratch(t), "0.2.0");
  const run = fakeNpm({
    "npm root -g": ok(`${root}\n`),
    "npm view allaboard@0.2.0 version --json": ok('"0.2.0"\n'),
  });
  assert.deepEqual(await updatableCopy(run, main, "0.2.0"), { copy });
});

test("the global folder is compared by real path: a prefix reached through a link still matches", async (t) => {
  const base = scratch(t);
  const { root, copy, main } = globalCopy(join(base, "real"), "0.2.0");
  symlinkSync(join(base, "real"), join(base, "alias"));
  const run = fakeNpm({
    "npm root -g": ok(`${join(base, "alias", "lib", "node_modules")}\n`),
    "npm view allaboard@0.2.0 version --json": ok('"0.2.0"\n'),
  });
  assert.deepEqual(await updatableCopy(run, main, "0.2.0"), { copy });
  assert.ok(root.startsWith(base));
});

test("a copy outside npm's global folder is refused with its folder", async (t) => {
  const base = scratch(t);
  const { root } = globalCopy(join(base, "global"), "0.2.0");
  const elsewhere = globalCopy(join(base, "checkout"), "0.2.0");
  const run = fakeNpm({ "npm root -g": ok(`${root}\n`) });
  assert.deepEqual(await updatableCopy(run, elsewhere.main, "0.2.0"), {
    refusal: { kind: "not-global", folder: elsewhere.copy },
  });
  // Nothing was asked of the registry for a copy npm would not replace.
  assert.deepEqual(
    run.calls.map((call) => call.args[0]),
    ["root"],
  );
});

test("a main file that is gone is a copy outside the global folder", async (t) => {
  const base = scratch(t);
  const { root } = globalCopy(base, "0.2.0");
  const run = fakeNpm({ "npm root -g": ok(`${root}\n`) });
  const gone = join(base, "nowhere", "allaboard", "dist", "main.js");
  assert.deepEqual(await updatableCopy(run, gone, "0.2.0"), {
    refusal: { kind: "not-global", folder: join(base, "nowhere", "allaboard") },
  });
});

test("a link made by npm link is refused as a link, not as another folder", async (t) => {
  const base = scratch(t);
  const checkout = globalCopy(join(base, "checkout"), "0.2.0");
  const root = join(base, "global", "lib", "node_modules");
  mkdirSync(root, { recursive: true });
  symlinkSync(checkout.copy, join(root, "allaboard"));
  const run = fakeNpm({ "npm root -g": ok(`${root}\n`) });
  assert.deepEqual(await updatableCopy(run, checkout.main, "0.2.0"), { refusal: { kind: "link" } });
});

test("a version npm does not publish is refused with that version", async (t) => {
  const { root, main } = globalCopy(scratch(t), "0.2.1");
  const run = fakeNpm({
    "npm root -g": ok(`${root}\n`),
    "npm view allaboard@0.2.1 version --json": NOT_FOUND,
  });
  assert.deepEqual(await updatableCopy(run, main, "0.2.1"), {
    refusal: { kind: "unpublished", version: "0.2.1" },
  });
});

test("an npm that cannot answer is the refusal, with its failure", async (t) => {
  const { root, main } = globalCopy(scratch(t), "0.2.0");
  const noRoot = fakeNpm({
    "npm root -g": { status: null, stdout: "", stderr: "spawn npm ENOENT" },
  });
  assert.deepEqual(await updatableCopy(noRoot, main, "0.2.0"), {
    refusal: { kind: "npm", failure: { kind: "other", status: null } },
  });
  const offline = fakeNpm({
    "npm root -g": ok(`${root}\n`),
    "npm view allaboard@0.2.0 version --json": REFUSED,
  });
  assert.deepEqual(await updatableCopy(offline, main, "0.2.0"), {
    refusal: { kind: "npm", failure: { kind: "network" } },
  });
});

/** The log lines written while `work` runs. */
async function logged(work: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const before = setWriter((line) => lines.push(line));
  setLevel("DEBUG");
  try {
    await work();
  } finally {
    setWriter(before);
    setLevel("INFO");
  }
  return lines;
}

const INSTALL = "npm install -g allaboard@0.3.0";

test("installVersion installs the exact version and reads the copy again", async (t) => {
  const { copy } = globalCopy(scratch(t), "0.2.0");
  const run = fakeNpm({
    [INSTALL]: ok("changed 1 package in 3s\n"),
  });
  // npm replaces the copy: the package.json now holds the new version.
  const swapping: RunAsync = async (command, args) => {
    const result = await run(command, args);
    writeFileSync(join(copy, "package.json"), JSON.stringify({ version: "0.3.0" }));
    return result;
  };
  assert.deepEqual(await installVersion(swapping, copy, "0.3.0"), {
    kind: "installed",
    version: "0.3.0",
  });
  assert.deepEqual(run.calls, [{ command: "npm", args: ["install", "-g", "allaboard@0.3.0"] }]);
});

test("an install that ends well over another version is a mismatch, with the version found", async (t) => {
  const { copy } = globalCopy(scratch(t), "0.2.0");
  const run = fakeNpm({ [INSTALL]: ok("") });
  assert.deepEqual(await installVersion(run, copy, "0.3.0"), { kind: "mismatch", found: "0.2.0" });
});

test("an install that leaves no package.json is a mismatch with none found", async (t) => {
  const { copy } = globalCopy(scratch(t), null);
  const run = fakeNpm({ [INSTALL]: ok("") });
  assert.deepEqual(await installVersion(run, copy, "0.3.0"), { kind: "mismatch", found: null });
});

test("a killed install is a failure and the copy is not read", async (t) => {
  const { copy } = globalCopy(scratch(t), "0.2.0");
  const run = fakeNpm({ [INSTALL]: { status: 137, stdout: "", stderr: "" } });
  assert.deepEqual(await installVersion(run, copy, "0.3.0"), {
    kind: "failed",
    failure: { kind: "other", status: 137 },
  });
});

test("an install into a folder npm may not write is a permission failure", async (t) => {
  const { copy } = globalCopy(scratch(t), "0.2.0");
  const run = fakeNpm({ [INSTALL]: unwritable("/opt/prefix") });
  assert.deepEqual(await installVersion(run, copy, "0.3.0"), {
    kind: "failed",
    failure: { kind: "permission", path: folder("/opt/prefix") },
  });
});

test("an install with no registry is a network failure", async (t) => {
  const { copy } = globalCopy(scratch(t), "0.2.0");
  const run = fakeNpm({ [INSTALL]: REFUSED });
  assert.deepEqual(await installVersion(run, copy, "0.3.0"), {
    kind: "failed",
    failure: { kind: "network" },
  });
});

test("npm's words go to the log and nowhere else", async (t) => {
  const { copy } = globalCopy(scratch(t), "0.2.0");
  const run = fakeNpm({ [INSTALL]: unwritable("/opt/prefix") });
  let result: unknown;
  const lines = await logged(async () => {
    result = await installVersion(run, copy, "0.3.0");
  });
  assert.ok(
    lines.some((line) => line.includes("npm error code EACCES")),
    lines.join("\n"),
  );
  assert.ok(lines.some((line) => line.includes("status 243")));
  // The returned value carries the classification and the folder, not npm's text.
  assert.equal(JSON.stringify(result).includes("npm error"), false);
});

test("a string that is not a version is refused before anything runs", async (t) => {
  const { copy } = globalCopy(scratch(t), "0.2.0");
  const run = fakeNpm({});
  for (const text of ["latest", "0.3.0 --prefix /", "-g", "", "0.3", "^0.3.0"]) {
    await assert.rejects(installVersion(run, copy, text), RangeError, text);
  }
  assert.deepEqual(run.calls, []);
});

test("a version is newer than another by semantic version precedence", () => {
  const newer: Array<[string, string]> = [
    ["0.3.0", "0.2.0"],
    ["0.10.0", "0.9.9"],
    ["1.0.0", "0.99.99"],
    ["0.2.1", "0.2.0"],
    ["1.0.0", "1.0.0-rc.1"],
    ["1.0.0-rc.2", "1.0.0-rc.1"],
    ["1.0.0-rc.10", "1.0.0-rc.9"],
    ["1.0.0-rc.1", "1.0.0-beta"],
    ["1.0.0-alpha.1", "1.0.0-alpha"],
    ["1.0.0-alpha", "1.0.0-1"],
    ["1.0.0-rc-2", "1.0.0-rc-1"],
  ];
  for (const [candidate, current] of newer) {
    assert.equal(isNewer(candidate, current), true, `${candidate} over ${current}`);
    assert.equal(isNewer(current, candidate), false, `${current} over ${candidate}`);
  }
  assert.equal(isNewer("0.2.0", "0.2.0"), false);
  assert.equal(isNewer("1.0.0-rc.1", "1.0.0-rc.1"), false);
});

test("a string that is no version is never newer, nor older", () => {
  assert.equal(isNewer("latest", "0.2.0"), false);
  assert.equal(isNewer("0.3.0", "latest"), false);
});
