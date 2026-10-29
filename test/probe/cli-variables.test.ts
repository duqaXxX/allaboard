/**
 * The probe's look at the bundled CLI (`probe/surface.ts`): the variables the daemon sets and only
 * Claude Code's own source reads must still be named in the binary the SDK ships.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  bundledCli,
  CLI_CHUNK,
  CLI_VARIABLES,
  cliReport,
  missingFromCli,
} from "../../probe/surface.ts";

test("a CLI that still names each variable misses none, one that does not names it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cli-variables-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, "claude");
  await writeFile(
    cli,
    Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from("..CLAUDE_CODE_EAGER_FLUSH..")]),
  );
  assert.deepEqual(missingFromCli(["CLAUDE_CODE_EAGER_FLUSH"], cli), []);
  assert.deepEqual(missingFromCli(["CLAUDE_CODE_EAGER_FLUSH", "CLAUDE_CODE_GONE"], cli), [
    "CLAUDE_CODE_GONE",
  ]);
  assert.match(cliReport(["CLAUDE_CODE_GONE"]), /BROKEN, no longer names CLAUDE_CODE_GONE/);
  assert.equal(cliReport([], ["CLAUDE_CODE_KEPT"]), "Bundled CLI: still names CLAUDE_CODE_KEPT");
});

test("with no bundled CLI installed the look proves nothing", async (t) => {
  const scope = await mkdtemp(join(tmpdir(), "cli-scope-"));
  t.after(() => rm(scope, { recursive: true, force: true }));
  await mkdir(join(scope, "claude-agent-sdk"));
  assert.equal(bundledCli(scope), null);
  assert.equal(bundledCli(join(scope, "not-installed")), null);
  assert.equal(missingFromCli(CLI_VARIABLES, null), null);
  assert.match(cliReport(null), /UNPROVEN/);
});

test("the bundled CLI is the one of the platform's package, its exact name first", async (t) => {
  const scope = await mkdtemp(join(tmpdir(), "cli-scope-"));
  t.after(() => rm(scope, { recursive: true, force: true }));
  for (const [entry, file] of [
    ["claude-agent-sdk-darwin-arm64", "claude"],
    ["claude-agent-sdk-linux-x64-musl", "claude"],
    ["claude-agent-sdk-linux-x64", "claude"],
    ["claude-agent-sdk-win32-x64", "claude.exe"],
  ] as const) {
    await mkdir(join(scope, entry), { recursive: true });
    await writeFile(join(scope, entry, file), "");
  }
  assert.equal(
    bundledCli(scope, "win32-x64"),
    join(scope, "claude-agent-sdk-win32-x64", "claude.exe"),
  );
  assert.equal(bundledCli(scope, "linux-x64"), join(scope, "claude-agent-sdk-linux-x64", "claude"));
  assert.equal(bundledCli(scope, "linux-arm64"), null);
});

test("a name cut across two chunks of the CLI is still found", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cli-variables-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, "claude");
  const name = "CLAUDE_CODE_EAGER_FLUSH";
  // The name starts 5 bytes before the end of the first chunk.
  const before = Buffer.alloc(CLI_CHUNK - 5, 0x2e);
  await writeFile(cli, Buffer.concat([before, Buffer.from(name), Buffer.from("..")]));
  assert.deepEqual(missingFromCli([name], cli), []);
});

test("a CLI that is there and cannot be read proves nothing, and throws nothing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cli-variables-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A folder where the binary should be: opened, it cannot be read.
  const cli = join(root, "claude");
  await mkdir(cli);
  assert.equal(missingFromCli(CLI_VARIABLES, cli), null);
});
