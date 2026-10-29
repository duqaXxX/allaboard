/**
 * The footer's git calls over a repository an agent handed the core (`test/support/repositories.ts`:
 * any folder with a `.git` directory). The core runs git with the repository it is given and never
 * lets git search for one, so a planted filter of a repository nested or beside it does not run.
 * What a real agent's trust record has to tell apart (worktrees, gitfiles, bare layouts, folders
 * without trust) is tested with the Claude module (`test/agent/claude/footer-git.test.ts`).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { gitState } from "../../src/core/footer.ts";
import { committed, git, gitEnv } from "../support/git-layouts.ts";
import { repositoryAt } from "../support/repositories.ts";

let tmp = "";
let marker = "";
let app = "";

beforeEach(() => {
  tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "allaboard-core-footer-git-")));
  // The file a planted filter touches when git runs it.
  marker = join(tmp, "filter-ran");
  app = realpathSync(committed(join(tmp, "code", "app")));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Someone else's repository: a clean filter bound to every path, and a file git must read. */
function planted(path: string): string {
  committed(path);
  git(path, "config", "filter.planted.clean", `sh -c 'touch "${marker}"; cat'`);
  mkdirSync(join(path, ".git", "info"), { recursive: true });
  writeFileSync(join(path, ".git", "info", "attributes"), "* filter=planted\n");
  writeFileSync(join(path, "README"), "two\nthree\n");
  return path;
}

function filterRan(): boolean {
  const ran = existsSync(marker);
  rmSync(marker, { force: true });
  return ran;
}

/** What a footer that lets git find the repository runs in `folder`. */
function gitDiffsThere(folder: string): void {
  spawnSync("git", ["-C", folder, "diff-files", "--shortstat"], { env: gitEnv(), stdio: "ignore" });
}

test("the branch and the changes of a plain repository", async () => {
  writeFileSync(join(app, "README"), "one\nmore\n");
  assert.deepEqual(await gitState(app, repositoryAt), ["main", [1, 0]]);
  mkdirSync(join(app, "src"));
  assert.deepEqual(await gitState(join(app, "src"), repositoryAt), ["main", [1, 0]]);
  assert.deepEqual(await gitState(join(tmp, "nowhere"), repositoryAt), [null, null]);
});

test("a nested repository staged as a gitlink is not entered", async () => {
  const nested = planted(join(app, "nested"));
  writeFileSync(join(nested, "README"), "two\n"); // the committed size: only its content tells
  git(app, "add", "nested");
  git(app, "commit", "-q", "-m", "gitlink");
  filterRan();
  // The control: a plain diff asks the nested repository whether it is dirty, under its config.
  gitDiffsThere(app);
  assert.ok(filterRan());
  assert.deepEqual(await gitState(app, repositoryAt), ["main", [0, 0]]);
  assert.ok(!filterRan());
});

test("a submodule counts by its commit alone", async () => {
  git(app, "submodule", "add", "-q", committed(join(tmp, "lib")), "sub");
  git(app, "config", "-f", ".gitmodules", "submodule.sub.ignore", "all");
  git(app, "commit", "-q", "-am", "sub");
  writeFileSync(join(app, "sub", "new"), "untracked\n");
  writeFileSync(join(app, "sub", "README"), "changed\n");
  assert.deepEqual(await gitState(app, repositoryAt), ["main", [0, 0]]);
  git(join(app, "sub"), "commit", "-q", "-am", "moved");
  assert.deepEqual(await gitState(app, repositoryAt), ["main", [1, 1]]);
});

test("a file named head at the root does not change the count", async () => {
  // git runs at the root: `HEAD` there must still be read as the commit, not as that file.
  mkdirSync(join(app, "src"));
  writeFileSync(join(app, "HEAD"), "a file\n".repeat(500));
  git(app, "add", "-A");
  git(app, "commit", "-q", "-m", "a file named HEAD");
  assert.deepEqual(await gitState(join(app, "src"), repositoryAt), ["main", [0, 0]]);
});

test("git is given the repository and never looks for one", async () => {
  // A folder whose `.git` git itself rejects, inside someone else's repository: git left to
  // search from there would walk up into that repository and run its filter.
  const clone = planted(join(dirname(app), "clone"));
  const kept = join(clone, "kept");
  for (const entry of ["objects", "refs"]) {
    mkdirSync(join(kept, ".git", entry), { recursive: true });
  }
  writeFileSync(join(kept, ".git", "HEAD"), "no ref at all\n");
  filterRan();
  gitDiffsThere(kept);
  assert.ok(filterRan()); // the control
  assert.deepEqual(await gitState(kept, repositoryAt), [null, null]);
  assert.ok(!filterRan());
});

// The stub is a shell script found through a `:` separated PATH.
test("every git call shares one time limit", {
  skip: process.platform === "win32" && "the stub git is a shell script",
}, async () => {
  const stub = join(tmp, "bin", "git");
  mkdirSync(dirname(stub));
  writeFileSync(stub, "#!/bin/sh\nsleep 0.5\n");
  chmodSync(stub, 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dirname(stub)}:${path}`;
  try {
    assert.deepEqual(await gitState(app, repositoryAt, 800), [null, null]);
  } finally {
    process.env.PATH = path;
  }
});
