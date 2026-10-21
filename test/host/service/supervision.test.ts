/**
 * The rule the update from Slack rests on: a daemon may stop itself to update only because its
 * service starts it again. `supervised = manager.runningPid() === process.pid` is correct only if
 * every backend's `install` writes a definition that restarts the daemon after ANY exit, a clean
 * one included (the update ends the daemon with status 0). A backend added later joins the table
 * below, with how it states the rule.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Program } from "../../../src/host/program.ts";
import { Launchd, plistPath } from "../../../src/host/service/launchd.ts";
import type { Run, ServiceManager } from "../../../src/host/service/seam.ts";

const PROGRAM: Program = {
  node: "/opt/homebrew/bin/node",
  main: "/Us" + "ers/alice/.local/lib/node_modules/allaboard/dist/main.js",
  npmBin: "/Us" + "ers/alice/.local/bin",
  agentExecutables: [],
};

interface Backend {
  name: string;
  /** Installs the service for `instance` under a temporary home; returns the definition written. */
  install(home: string, instance: string | null): string;
  /** Whether `definition` starts the daemon again whatever way it exits. */
  restartsOnAnyExit(definition: string): boolean;
}

/** `launchctl list` shows nothing loaded; every other command succeeds. */
const quiet: Run = (_command, args) => ({
  status: 0,
  stdout: args[0] === "list" ? "PID\tStatus\tLabel\n" : "",
  stderr: "",
});

const BACKENDS: Backend[] = [
  {
    name: "launchd",
    install: (home, instance) => {
      const manager: ServiceManager = new Launchd({
        home,
        uid: 501,
        instance,
        configDir: join(home, ".config", "allaboard"),
        run: quiet,
      });
      const report = manager.install(PROGRAM);
      assert.equal(report.code, 0, report.err.join("\n"));
      return readFileSync(plistPath(home, instance), "utf8");
    },
    // `man launchd.plist`: KeepAlive true keeps the job alive "unconditionally"; a dictionary of
    // conditions (SuccessfulExit, Crashed...) would leave a clean exit down.
    restartsOnAnyExit: (definition) => /<key>KeepAlive<\/key>\s*<true\/>/.test(definition),
  },
];

for (const backend of BACKENDS) {
  for (const instance of [null, "dev"]) {
    test(`${backend.name} install writes a definition that restarts the daemon on any exit (${instance ?? "default instance"})`, (t) => {
      const home = mkdtempSync(join(tmpdir(), "allaboard-supervision-"));
      t.after(() => rmSync(home, { recursive: true, force: true }));
      assert.equal(backend.restartsOnAnyExit(backend.install(home, instance)), true);
    });
  }
}

test("the check refuses a definition that restarts only after a failure", () => {
  const launchd = BACKENDS[0] as Backend;
  const onFailureOnly =
    "<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>";
  assert.equal(launchd.restartsOnAnyExit(onFailureOnly), false);
  assert.equal(launchd.restartsOnAnyExit("<key>KeepAlive</key>\n  <false/>"), false);
  assert.equal(launchd.restartsOnAnyExit("<key>RunAtLoad</key>\n  <true/>"), false);
});
