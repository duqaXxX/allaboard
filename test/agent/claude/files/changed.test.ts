/**
 * The start of a thread in a linked worktree: the layout the Claude module's trust record keys on
 * its main checkout. The rest of the changed-file logic is `test/core/files/changed.test.ts`.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { changedSince, startCommit } from "../../../../src/core/files/changed.ts";
import { commitAt, gitAt, gitInit } from "../../../support/git-layouts.ts";
import { repository, scratch, started, T0 } from "./support.ts";

const tmp = scratch();

test("a linked worktree has its own start", async () => {
  const main = gitInit(join(tmp.dir, "main"));
  commitAt(main, "a.py", T0 + 100);
  const second = commitAt(main, "b.py", T0 + 200);
  const wt = join(tmp.dir, "wt");
  gitAt(main, T0 + 250, "worktree", "add", "-q", wt, "-b", "feature");
  const third = commitAt(wt, "c.py", T0 + 400);
  const found = await repository(wt);
  assert.equal(found.key, main);
  assert.notEqual(found.gitDir, join(main, ".git"));
  assert.equal(await startCommit(found, started(T0 + 300)), second);
  assert.equal(await startCommit(found, started(T0 + 450)), third);
  // The main checkout's own log is another one: it never saw the worktree's commit.
  assert.equal(await startCommit(await repository(main), started(T0 + 450)), second);
  assert.deepEqual(await changedSince(found, wt, second), ["c.py"]);
});
