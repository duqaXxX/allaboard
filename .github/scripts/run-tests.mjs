// Runs the suite and fails when it leaves a new `allaboard-*` entry in the temp folder.
// A test that creates a folder removes it (test/support/temp.ts); this is what notices one that
// does not, since a leak is invisible in a single run and adds up to thousands of folders.
// The temp folder itself is left as it is: a longer one pushes the lock tests' socket paths past
// the 107-byte limit of Unix sockets on Linux, and tools the tests start keep folders of their own
// there (Claude Code's `claude-<uid>`), which are not the suite's.
//
//   node .github/scripts/run-tests.mjs [more node --test arguments...]
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";

const PREFIX = "allaboard-";

/** The suite's entries in the temp folder: every test folder is named after the project. */
function entries() {
  return new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(PREFIX)));
}

const before = entries();

// Arguments are added after the suite's files, as `npm test -- <args>` did before this script.
const child = spawn(
  process.execPath,
  ["--test", "--test-timeout=300000", "test/**/*.test.ts", ...process.argv.slice(2)],
  { stdio: "inherit" },
);

// A stop (Ctrl-C, a timeout's SIGTERM) reaches the tests.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(`could not run the tests: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal !== null) process.exit(1);
  const left = [...entries()].filter((name) => !before.has(name));
  if (left.length > 0) {
    console.error(
      `\nThe suite left ${left.length} new entries in ${tmpdir()}; remove them in the test that made them:`,
    );
    for (const name of left.slice(0, 20)) console.error(`  ${name}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
