/**
 * The core's file index and changed-file list over a repository an agent handed it. The agent
 * here is any one that trusts a plain repository (`test/support/repositories.ts`); the layouts a
 * real agent's trust record has to tell apart (worktrees, gitfiles, bare layouts) are tested with
 * the Claude module (`test/agent/claude/files/`).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { changedSince } from "../../../src/core/files/changed.ts";
import { projectFiles } from "../../../src/core/files/listing.ts";
import { git, gitInit } from "../../support/git-layouts.ts";
import { repositoryAt } from "../../support/repositories.ts";

let root = "";

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "allaboard-files-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(folder: string, name: string): void {
  const path = join(folder, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "x\n");
}

function commitAll(folder: string): void {
  git(folder, "add", "-A");
  git(folder, "commit", "-q", "-m", "x");
}

test("the index is the tracked files and the untracked ones not ignored", async () => {
  const folder = gitInit(join(root, "app"));
  write(folder, ".gitignore");
  writeFileSync(join(folder, ".gitignore"), "*.log\nbuild/\n");
  write(folder, "src/tracked.py");
  commitAll(folder);
  write(folder, "src/new.py");
  write(folder, "debug.log");
  write(folder, "build/out.js");
  const repository = await repositoryAt(folder);
  assert.notEqual(repository, null);
  const found = (await projectFiles(repository as NonNullable<typeof repository>, folder)) ?? [];
  assert.deepEqual(found.toSorted(), [".gitignore", "src/new.py", "src/tracked.py"]);
});

test("without a start only what is not committed is changed", async () => {
  const folder = gitInit(join(root, "app"));
  write(folder, "kept.py");
  commitAll(folder);
  write(folder, "kept.py");
  writeFileSync(join(folder, "kept.py"), "changed\n");
  write(folder, "new.py");
  const repository = await repositoryAt(folder);
  const found = await changedSince(repository as NonNullable<typeof repository>, folder, null);
  assert.deepEqual(found?.toSorted(), ["kept.py", "new.py"]);
});
