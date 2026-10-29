import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { FileChange } from "../../../src/agent/seam.ts";
import {
  diffPatch,
  diffStats,
  groupEdits,
  patchOfEdits,
  statOfEdits,
} from "../../../src/core/files/diff.ts";
import { gitState } from "../../../src/core/footer.ts";
import { FakeClock } from "../../support/fake-clock.ts";
import { commitAll, plainRepository, scratch, write } from "../../support/files.ts";
import { committed, git } from "../../support/git-layouts.ts";
import { repositoryAt } from "../../support/repositories.ts";

const tmp = scratch();
// What a chat takes as one file, as the tests of this file give it.
const LIMIT = 1 << 20;

function app(): string {
  return committed(join(tmp.dir, "app"));
}

test("an edit, a new file, a deletion and a binary file are listed with their counts", async () => {
  const root = app();
  write(root, "gone.txt", "a\nb\n");
  write(root, "bin.dat", "x\0y\n");
  commitAll(root);
  write(root, "README", "one\ntwo\nthree\n");
  rmSync(join(root, "gone.txt"));
  writeFileSync(join(root, "bin.dat"), Buffer.from([0, 1, 2, 3, 0]));
  write(root, "src/new.ts", "a\nb\nc\nd\n");
  write(root, "blob.bin", "p\0q");
  const found = await diffStats(await plainRepository(root), new FakeClock());
  assert.deepEqual(found, [
    { path: "README", added: 2, removed: 0, binary: false },
    { path: "bin.dat", added: 0, removed: 0, binary: true },
    { path: "blob.bin", added: 0, removed: 0, binary: true },
    { path: "gone.txt", added: 0, removed: 2, binary: false },
    { path: "src/new.ts", added: 4, removed: 0, binary: false },
  ]);
});

test("a staged new file counts, and the ignored file is left out", async () => {
  const root = app();
  write(root, ".gitignore", "skip.log\n");
  write(root, "skip.log", "noise\n");
  write(root, "staged.txt", "s\n");
  git(root, "add", "staged.txt");
  const found = await diffStats(await plainRepository(root), new FakeClock());
  assert.deepEqual(
    found?.map((row) => row.path),
    [".gitignore", "staged.txt"],
  );
});

test("a file touched with no change in content is dropped", async () => {
  const root = app();
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(root, "README"), later, later);
  assert.deepEqual(await diffStats(await plainRepository(root), new FakeClock()), []);
});

test("a repository with no commit lists every file as added", async () => {
  const root = join(tmp.dir, "fresh");
  git(tmp.dir, "init", "-q", "-b", "main", root);
  write(root, "a.txt", "1\n2\n");
  git(root, "add", "a.txt");
  write(root, "b.txt", "3\n");
  const found = await diffStats(await plainRepository(root), new FakeClock());
  assert.deepEqual(found, [
    { path: "a.txt", added: 2, removed: 0, binary: false },
    { path: "b.txt", added: 1, removed: 0, binary: false },
  ]);
});

test("the totals equal what the footer reports for the same tree", async () => {
  const root = app();
  write(root, "keep.txt", "1\n2\n3\n");
  commitAll(root);
  write(root, "keep.txt", "1\nx\n3\n4\n");
  write(root, "README", "");
  write(root, "added.txt", "q\nr\n");
  git(root, "add", "added.txt");
  const rows = await diffStats(await plainRepository(root), new FakeClock());
  const added = rows?.reduce((sum, row) => sum + row.added, 0);
  const removed = rows?.reduce((sum, row) => sum + row.removed, 0);
  const [, changes] = await gitState(root, repositoryAt);
  assert.deepEqual([added, removed], changes);
});

test("no index lock is left behind, and the index is not rewritten", async () => {
  const root = app();
  write(root, "README", "two\n");
  write(root, "other.txt", "o\n");
  await diffStats(await plainRepository(root), new FakeClock());
  await diffPatch(await plainRepository(root), "README", LIMIT, new FakeClock());
  assert.equal(existsSync(join(root, ".git", "index.lock")), false);
});

test("the patch of a tracked file is a unified diff", async () => {
  const root = app();
  write(root, "README", "one\ntwo\n");
  const found = await diffPatch(await plainRepository(root), "README", LIMIT, new FakeClock());
  assert.equal(found?.binary, false);
  assert.match(found?.text ?? "", /^diff --git a\/README b\/README\n/);
  assert.match(found?.text ?? "", /\n\+two\n/);
});

test("the patch of an untracked file is a new-file patch", async () => {
  const root = app();
  write(root, "dir/new.txt", "a\nb");
  const found = await diffPatch(await plainRepository(root), "dir/new.txt", LIMIT, new FakeClock());
  assert.equal(
    found?.text,
    [
      "diff --git a/dir/new.txt b/dir/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/dir/new.txt",
      "@@ -0,0 +1,2 @@",
      "+a",
      "+b",
      "\\ No newline at end of file",
      "",
    ].join("\n"),
  );
});

test("a binary file has no text patch, and a file no longer changed has an empty one", async () => {
  const root = app();
  write(root, "blob.bin", "p\0q");
  const repository = await plainRepository(root);
  assert.deepEqual(await diffPatch(repository, "blob.bin", LIMIT, new FakeClock()), {
    binary: true,
    text: "",
    large: false,
  });
  assert.deepEqual(await diffPatch(repository, "README", LIMIT, new FakeClock()), {
    binary: false,
    text: "",
    large: false,
  });
  assert.deepEqual(await diffPatch(repository, "nothing.txt", LIMIT, new FakeClock()), {
    binary: false,
    text: "",
    large: false,
  });
});

test("a path is a literal name, never an option or a pattern", async () => {
  const root = app();
  write(root, "*.txt", "star\n");
  write(root, "a.txt", "a\n");
  const found = await diffPatch(await plainRepository(root), "*.txt", LIMIT, new FakeClock());
  assert.match(found?.text ?? "", /\+star/);
  assert.doesNotMatch(found?.text ?? "", /\+a\n/);
  assert.deepEqual(await diffPatch(await plainRepository(root), "--stat", LIMIT, new FakeClock()), {
    binary: false,
    text: "",
    large: false,
  });
});

// --- the edits a turn reported

const edit = (path: string, lines: string[], oldStart = 1): FileChange => ({
  path,
  kind: "edited",
  hunks: [{ oldStart, newStart: oldStart, lines }],
  content: null,
});

test("a turn's edits are grouped by file under the repository, and the others are left out", () => {
  const inside = (path: string): string | null =>
    path.startsWith("/repo/") ? path.slice("/repo/".length) : null;
  const first = edit("/repo/b.ts", [" keep", "-old", "+new"]);
  const second = edit("/repo/b.ts", ["-gone"], 9);
  const made: FileChange = {
    path: "/repo/a.ts",
    kind: "created",
    hunks: [],
    content: "x\ny\n",
  };
  const outside = edit("/elsewhere/c.ts", ["+z"]);
  assert.deepEqual(groupEdits([first, outside, made, second], inside), [
    { path: "a.ts", changes: [made] },
    { path: "b.ts", changes: [first, second] },
  ]);
});

test("a file's counts add up its hunks, and a created file counts its content", () => {
  const made: FileChange = { path: "a", kind: "created", hunks: [], content: "x\ny\n" };
  assert.deepEqual(statOfEdits({ path: "a", changes: [made] }), {
    path: "a",
    added: 2,
    removed: 0,
    binary: false,
  });
  const twice = [edit("b", [" k", "-o", "+n", "+m"]), edit("b", ["-q"], 8)];
  assert.deepEqual(statOfEdits({ path: "b", changes: twice }), {
    path: "b",
    added: 2,
    removed: 2,
    binary: false,
  });
});

test("an edited file's patch writes each hunk with the counts its lines make", () => {
  const twice = [edit("b.ts", [" k", "-o", "+n", "+m"], 3), edit("b.ts", ["-q"], 8)];
  assert.equal(
    patchOfEdits({ path: "b.ts", changes: twice }),
    [
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -3,2 +3,3 @@",
      " k",
      "-o",
      "+n",
      "+m",
      "@@ -8,1 +8,0 @@",
      "-q",
      "",
    ].join("\n"),
  );
});

test("a created file's patch is a new-file patch of its content", () => {
  const made: FileChange = { path: "a.ts", kind: "created", hunks: [], content: "x\ny" };
  assert.equal(
    patchOfEdits({ path: "a.ts", changes: [made] }),
    [
      "diff --git a/a.ts b/a.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/a.ts",
      "@@ -0,0 +1,2 @@",
      "+x",
      "+y",
      "\\ No newline at end of file",
      "",
    ].join("\n"),
  );
});

// --- the review's fixes

test("a dirty submodule runs none of its filters and adds no row", async () => {
  const root = app();
  const sub = committed(join(tmp.dir, "sub"));
  write(sub, "f.txt", "one\n");
  commitAll(sub);
  git(root, "submodule", "add", "-q", sub, "vendor");
  git(root, "commit", "-q", "-m", "add the submodule");
  const inside = join(root, "vendor");
  const marker = join(tmp.dir, "filter-ran");
  // The submodule's own config names a clean filter, bound to every path.
  git(inside, "config", "filter.planted.clean", `sh -c 'touch "${marker}"; cat'`);
  mkdirSync(join(root, ".git", "modules", "vendor", "info"), { recursive: true });
  writeFileSync(
    join(root, ".git", "modules", "vendor", "info", "attributes"),
    "* filter=planted\n",
  );
  write(inside, "f.txt", "changed\n");
  const repository = await plainRepository(root);
  assert.deepEqual(await diffStats(repository, new FakeClock()), []);
  assert.deepEqual(await diffPatch(repository, "vendor", LIMIT, new FakeClock()), {
    binary: false,
    text: "",
    large: false,
  });
  assert.equal(existsSync(marker), false, "no filter of the submodule ran");
});

test("a file written and then edited in one turn shares both, and its counts are the patch's", () => {
  const made: FileChange = { path: "a.ts", kind: "created", hunks: [], content: "a\nb\n" };
  const fixed = edit("a.ts", ["-a", "+A"]);
  const file = { path: "a.ts", changes: [made, fixed] };
  assert.deepEqual(statOfEdits(file), { path: "a.ts", added: 3, removed: 1, binary: false });
  assert.equal(
    patchOfEdits(file),
    [
      "diff --git a/a.ts b/a.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/a.ts",
      "@@ -0,0 +1,2 @@",
      "+a",
      "+b",
      "@@ -1,1 +1,1 @@",
      "-a",
      "+A",
      "",
    ].join("\n"),
  );
});

test("a file edited and then written again shares both, and its counts are the patch's", () => {
  const made: FileChange = { path: "a.ts", kind: "created", hunks: [], content: "z\n" };
  const file = { path: "a.ts", changes: [edit("a.ts", ["-o", "+n"]), made] };
  assert.deepEqual(statOfEdits(file), { path: "a.ts", added: 2, removed: 1, binary: false });
  const patch = patchOfEdits(file);
  assert.match(
    patch,
    /^diff --git a\/a.ts b\/a.ts\n--- a\/a.ts\n\+\+\+ b\/a.ts\n@@ -1,1 \+1,1 @@\n-o\n\+n\n@@ -0,0 \+1,1 @@\n\+z\n$/,
  );
});

test("a patch over the limit is not collected, and says so", async () => {
  const root = app();
  write(root, "README", `${"line of text\n".repeat(50_000)}`);
  const repository = await plainRepository(root);
  assert.deepEqual(await diffPatch(repository, "README", 1000, new FakeClock()), {
    binary: false,
    text: "",
    large: true,
  });
  write(root, "fresh.txt", "x\n".repeat(2000));
  assert.deepEqual(await diffPatch(repository, "fresh.txt", 1000, new FakeClock()), {
    binary: false,
    text: "",
    large: true,
  });
  const small = await diffPatch(repository, "README", LIMIT, new FakeClock());
  assert.equal(small?.large, false);
});
