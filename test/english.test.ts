/**
 * Everything the repository holds in prose is English. Markdown is checked in `docs.test.ts`;
 * this file checks the comments of the tracked sources, with the detector of
 * `support/english.ts`. It is its own file because it reads source comments, which neither the
 * docs test (markdown) nor the vocabulary test (identifiers and strings, comments exempt) does.
 * Only comments are read, so a test that holds Italian strings as data needs no exemption.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { commentBlocks, excerpt, isNotEnglish } from "./support/english.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SOURCES = execFileSync("git", ["ls-files", "src", "test", "probe"], {
  cwd: ROOT,
  encoding: "utf8",
})
  .split("\n")
  .filter((path) => /\.(ts|mjs|js)$/.test(path));

test("the comments of the tracked sources are English", () => {
  assert.ok(SOURCES.length > 100, "git ls-files found no sources");
  const found = SOURCES.flatMap((path) =>
    commentBlocks(readFileSync(join(ROOT, path), "utf8"))
      .filter(isNotEnglish)
      .map((block) => `${path}: ${excerpt(block)}`),
  );
  assert.deepEqual(found, []);
});
