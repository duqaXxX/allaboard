/**
 * A host for the tests of the update (`UpdatesHost`): every answer is a field a test sets, every
 * call is recorded, and `install` can be held until the test lets it end. No npm runs and no
 * service is signalled.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  InstallOutcome,
  NotUpdatable,
  RestartFailure,
  UpdateFailure,
  UpdateLockHeld,
  UpdatesHost,
} from "../../src/core/port/updates.ts";
import type { CommandResult, RunAsync } from "../../src/host/run.ts";
import type {
  InstanceListing,
  InstanceRow,
  Report,
  ServiceManager,
} from "../../src/host/service/seam.ts";
import type { UpdateMachine } from "../../src/updates-host.ts";
import { packageVersion } from "../../src/version.ts";

export const COPY = "/fake/lib/node_modules/allaboard";

export class FakeUpdatesHost implements UpdatesHost {
  installed = "0.3.0";
  logFile = "/fake/logs/allaboard.log";
  /** `latest()` answers this. */
  newest: { version: string } | { failure: UpdateFailure } = { version: "0.3.1" };
  /** `updatable()` answers this. */
  copy: { copy: string } | { refusal: NotUpdatable } | { swapping: true } = { copy: COPY };
  /** `copyVersion()` answers this. */
  held: string | null = "0.3.0";
  service = true;
  others: (string | null)[] = [];
  /** `lock()` answers null while this is set: another process holds it. */
  lockTaken = false;
  /** `updateHeld()` answers this: another process, or the terminal, is updating now. */
  updating = false;
  /** What `restartOthers` reports: the instances that did not restart. */
  restartFailures: RestartFailure[] = [];
  /** What `install` ends with; a function to decide per call. */
  outcome: InstallOutcome | ((version: string) => InstallOutcome) = {
    kind: "installed",
    version: "0.3.1",
  };
  /** While set, `install` waits for it: the test holds an install under way. */
  hold: Promise<void> | null = null;
  /** Every call in order: `latest`, `updatable`, `lock`, `install 0.3.1`, `restartOthers`, `restart`... */
  readonly calls: string[] = [];
  /** Locks taken and not yet released. */
  heldLocks = 0;
  /** What `install` was told, in order. */
  readonly installs: Array<{ copy: string; version: string }> = [];
  /** The signal each question and each install was given, in order. */
  readonly signals: Array<{ call: string; signal: AbortSignal }> = [];

  async latest(signal: AbortSignal): Promise<{ version: string } | { failure: UpdateFailure }> {
    this.calls.push("latest");
    this.signals.push({ call: "latest", signal });
    return this.newest;
  }

  async updatable(
    signal: AbortSignal,
  ): Promise<{ copy: string } | { refusal: NotUpdatable } | { swapping: true }> {
    this.calls.push("updatable");
    this.signals.push({ call: "updatable", signal });
    return this.copy;
  }

  copyVersion(): string | null {
    this.calls.push("copyVersion");
    return this.held;
  }

  supervised(): boolean {
    this.calls.push("supervised");
    return this.service;
  }

  sharing(): readonly (string | null)[] {
    return this.others;
  }

  async lock(): Promise<UpdateLockHeld | null> {
    this.calls.push("lock");
    if (this.lockTaken) return null;
    this.heldLocks += 1;
    return {
      release: async () => {
        this.calls.push("unlock");
        this.heldLocks -= 1;
      },
    };
  }

  async install(copy: string, version: string, signal: AbortSignal): Promise<InstallOutcome> {
    this.calls.push(`install ${version}`);
    this.installs.push({ copy, version });
    this.signals.push({ call: "install", signal });
    if (this.hold !== null) await this.hold;
    return typeof this.outcome === "function" ? this.outcome(version) : this.outcome;
  }

  async updateHeld(): Promise<boolean> {
    this.calls.push("updateHeld");
    return this.updating;
  }

  async restartOthers(): Promise<readonly RestartFailure[]> {
    this.calls.push("restartOthers");
    return this.restartFailures;
  }

  restart(): void {
    this.calls.push("restart");
  }

  changelog(version: string): string {
    return `https://example.test/changelog/v${version}`;
  }
}

// ---- the machine of the daemon's wiring (`UpdateMachine`)

/** One command npm was run with, as the daemon's host layer sends it. */
export type NpmCall = readonly string[];

/** A service manager that signals nothing: its pid, its rows and its restarts are fields. */
export class FakeService implements ServiceManager {
  /** `runningPid()` answers this. */
  pid: number | null = null;
  rows: InstanceRow[] = [];
  /** `restart()` was called this many times. */
  restarts = 0;
  /** What `restart()` reports. */
  code = 0;

  install(): Report {
    throw new Error("a test never installs a service");
  }

  uninstall(): Report {
    throw new Error("a test never removes a service");
  }

  status(): Report {
    return { code: 0, out: [], err: [] };
  }

  restart(): Report {
    this.restarts += 1;
    return { code: this.code, out: [], err: this.code === 0 ? [] : ["restart refused"] };
  }

  list(): Report {
    return { code: 0, out: [], err: [] };
  }

  instances(): InstanceListing {
    return { rows: this.rows, refused: [] };
  }

  runningPid(): number | null {
    return this.pid;
  }
}

/**
 * The machine the daemon runs on, in a folder of the test's: npm answers from fields (the newest
 * version, which versions are published, how an install ends) and an install writes the version
 * into the copy's `package.json` as npm does, so the daemon's own read of it finds it. No npm
 * runs and no service is signalled. By default npm cannot reach the registry and no service
 * manager exists: the daemon then offers nothing, as on a machine with no network.
 */
export class FakeMachine implements UpdateMachine {
  /** `<npm root -g>`; the copy is `<root>/allaboard`. */
  readonly root: string;
  readonly copy: string;
  /** The newest version npm finds; null: the registry is unreachable. */
  newest: string | null = null;
  /** The versions `npm view allaboard@<version>` finds, besides `newest`. */
  readonly published = new Set<string>();
  /** The version an install leaves in the copy; `null`: the one asked. */
  leaves: string | null = null;
  /** The status an install ends with. */
  installStatus = 0;
  /** Every npm command run, in order. */
  readonly npm: NpmCall[] = [];
  /** The signal each npm command was given, in the same order (undefined: none). */
  readonly npmSignals: Array<AbortSignal | undefined> = [];
  /** Per instance name (`""` for the default instance): its service manager; absent: none. */
  readonly services = new Map<string, FakeService>();

  constructor(base: string, version: string) {
    this.root = join(base, "global", "lib", "node_modules");
    this.copy = join(this.root, "allaboard");
    mkdirSync(join(this.copy, "dist"), { recursive: true });
    writeFileSync(join(this.copy, "dist", "main.js"), "");
    this.#write(version);
    this.published.add(version);
  }

  #write(version: string): void {
    writeFileSync(join(this.copy, "package.json"), JSON.stringify({ name: "allaboard", version }));
  }

  /** The version the copy's `package.json` holds now. */
  get held(): string | null {
    return packageVersion(join(this.copy, "package.json"));
  }

  run: RunAsync = async (command, args, signal) => {
    assert.equal(command, "npm", "the update runs npm and nothing else");
    this.npm.push(args);
    this.npmSignals.push(signal);
    const [verb, ...rest] = args;
    const ok = (stdout: string): CommandResult => ({ status: 0, stdout, stderr: "" });
    const refused = (code: string): CommandResult => ({
      status: 1,
      stdout: "",
      stderr: `npm error code ${code}\n`,
    });
    if (verb === "root") return ok(`${this.root}\n`);
    if (verb === "view") {
      const spec = rest[0] ?? "";
      if (spec === "allaboard") {
        return this.newest === null ? refused("ECONNREFUSED") : ok(JSON.stringify(this.newest));
      }
      const version = spec.replace(/^allaboard@/, "");
      return this.published.has(version) || version === this.newest
        ? ok(JSON.stringify(version))
        : refused("E404");
    }
    if (verb === "install") {
      const version = (rest[1] ?? "").replace(/^allaboard@/, "");
      if (this.installStatus === 0) this.#write(this.leaves ?? version);
      return { status: this.installStatus, stdout: "", stderr: "" };
    }
    throw new Error(`an npm command the test did not expect: ${args.join(" ")}`);
  };

  entry(): string {
    return join(this.copy, "dist", "main.js");
  }

  service(instance: string | null): ServiceManager | null {
    return this.services.get(instance ?? "") ?? null;
  }
}
