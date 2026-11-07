// Runs the suite with a temp folder of its own and fails when a test leaves something in it.
// A test that creates a folder removes it (test/support/temp.ts); this is what notices one that
// does not, since a leak is invisible in a single run and adds up to thousands of folders.
//
//   node .github/scripts/run-tests.mjs [more node --test arguments...]
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Node's own compile cache lives in the temp folder; it is not a test's.
const IGNORED = new Set(["node-compile-cache"]);

const scratch = mkdtempSync(join(tmpdir(), "allaboard-suite-"));

/** Removes the suite's folder; a failure (a file still held on Windows) is reported, not thrown. */
function removeScratch() {
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  } catch (error) {
    console.error(`could not remove ${scratch}: ${error instanceof Error ? error.message : error}`);
  }
}

// Arguments are added after the suite's files, as `npm test -- <args>` did before this script.
const child = spawn(
  process.execPath,
  ["--test", "--test-timeout=300000", "test/**/*.test.ts", ...process.argv.slice(2)],
  { stdio: "inherit", env: { ...process.env, TMPDIR: scratch, TEMP: scratch, TMP: scratch } },
);

// A stop (Ctrl-C, a timeout's SIGTERM) reaches the tests, and the folder is still removed after.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(`could not run the tests: ${error.message}`);
  removeScratch();
  process.exit(1);
});

child.on("exit", (code, signal) => {
  const left = readdirSync(scratch).filter((name) => !IGNORED.has(name));
  removeScratch();
  if (signal !== null) process.exit(1);
  if (left.length > 0) {
    console.error(
      `\nThe suite left ${left.length} entries in its temp folder; remove them in the test that made them:`,
    );
    for (const name of left.slice(0, 20)) console.error(`  ${name}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
