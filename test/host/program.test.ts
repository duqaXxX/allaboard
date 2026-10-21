import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { test } from "node:test";
import { copyOf, findOnPath, programOf, servicePath } from "../../src/host/program.ts";

// Executable bits and symlinks: not on Windows, where the service does not exist yet.
const POSIX = { skip: process.platform === "win32" };

function folder(t: { after(fn: () => void): void }): string {
  const path = mkdtempSync(join(tmpdir(), "allaboard-program-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function executable(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
}

test("the first executable node on PATH is found, skipping a file that cannot run", POSIX, (t) => {
  const root = folder(t);
  writeFileSync(join(root, "node"), "not executable");
  chmodSync(join(root, "node"), 0o644);
  mkdirSync(join(root, "dir", "node"), { recursive: true });
  executable(join(root, "a", "node"));
  executable(join(root, "b", "node"));
  const path = [
    root,
    "",
    join(root, "missing"),
    join(root, "dir"),
    join(root, "a"),
    join(root, "b"),
  ].join(delimiter);
  assert.equal(findOnPath("node", path), join(root, "a", "node"));
  assert.equal(findOnPath("node", join(root, "missing")), null);
});

test(
  "a relative folder of PATH is skipped: a service has no working folder to resolve it",
  POSIX,
  (t) => {
    const root = folder(t);
    executable(join(root, "here", "node"));
    executable(join(root, "there", "node"));
    const path = [relative(process.cwd(), join(root, "here")), join(root, "there")].join(delimiter);
    assert.equal(findOnPath("node", path), join(root, "there", "node"));
  },
);

test("a global install names npm's bin folder and the real entry", POSIX, (t) => {
  const prefix = folder(t);
  const main = join(prefix, "lib", "node_modules", "allaboard", "dist", "main.js");
  executable(main);
  mkdirSync(join(prefix, "bin"));
  symlinkSync(main, join(prefix, "bin", "allaboard"));
  executable(join(prefix, "node-bin", "node"));
  const program = programOf(join(prefix, "bin", "allaboard"), join(prefix, "node-bin"), "/x/node");
  assert.equal(program.node, join(prefix, "node-bin", "node"));
  assert.equal(program.main, realpathSync(main));
  assert.equal(program.npmBin, join(realpathSync(prefix), "bin"));
});

test("a run from a checkout has no npm bin, and Node falls back to the running one", POSIX, (t) => {
  const root = folder(t);
  const main = join(root, "allaboard", "src", "main.ts");
  executable(main);
  const program = programOf(main, join(root, "nowhere"), "/usr/local/bin/node");
  assert.equal(program.npmBin, null);
  assert.equal(program.node, "/usr/local/bin/node");
});

test("an agent's command is found on PATH as a link, and one not found is left out", POSIX, (t) => {
  const root = folder(t);
  const main = join(root, "allaboard", "src", "main.ts");
  executable(main);
  // A native install links its command to a versioned file: the link's folder outlives an update.
  executable(join(root, "versions", "1.0.0"));
  mkdirSync(join(root, "bin"));
  symlinkSync(join(root, "versions", "1.0.0"), join(root, "bin", "agent"));
  const program = programOf(main, join(root, "bin"), "/x/node", ["agent", "missing"]);
  assert.deepEqual(program.agentExecutables, [join(root, "bin", "agent")]);
  assert.deepEqual(programOf(main, join(root, "bin"), "/x/node").agentExecutables, []);
});

test("the service PATH holds Node's folder, npm's, then the agents', without repeats", () => {
  const program = {
    node: "/opt/homebrew/bin/node",
    main: "/m.js",
    npmBin: "/u/.local/bin",
    agentExecutables: [],
  };
  assert.equal(
    servicePath(program, ["/opt/homebrew/bin", "/usr/bin"]),
    "/opt/homebrew/bin:/u/.local/bin:/usr/bin",
  );
  assert.equal(
    servicePath({ ...program, npmBin: null }, ["/usr/bin"]),
    "/opt/homebrew/bin:/usr/bin",
  );
  // A named instance's npm folder is its own: the agent's folder is still there.
  assert.equal(
    servicePath(
      { ...program, npmBin: "/u/.local/share/dev/bin", agentExecutables: ["/u/.local/bin/agent"] },
      ["/usr/bin"],
    ),
    "/opt/homebrew/bin:/u/.local/share/dev/bin:/u/.local/bin:/usr/bin",
  );
  assert.equal(
    servicePath({ ...program, agentExecutables: ["/u/.local/bin/agent", "/usr/bin/other"] }, [
      "/usr/bin",
    ]),
    "/opt/homebrew/bin:/u/.local/bin:/usr/bin",
  );
  // An agent in a system folder leaves the system folders in their order.
  assert.equal(
    servicePath(
      { ...program, node: "/n/node", npmBin: null, agentExecutables: ["/usr/local/bin/agent"] },
      ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"],
    ),
    "/n:/opt/homebrew/bin:/usr/local/bin:/usr/bin",
  );
});

test("the copy of an entry file is the package folder above its dist", () => {
  assert.equal(copyOf(join("/p", "allaboard", "dist", "main.js")), join("/p", "allaboard"));
});
