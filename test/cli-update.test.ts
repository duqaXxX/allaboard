/**
 * `allaboard update [--check] [--yes]`: the arguments it reads and what it does on a fake machine.
 * npm is faked at `RunAsync` with the shapes measured on npm 11.17.0 (2026-10-17), the service
 * manager at `ServiceManager`; the folders and the update lock are real, under a temporary home.
 * Nothing here runs `npm install`, `launchctl` or the daemon.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { answerUpdate, type Output, parseArguments, type UpdateHost, USAGE } from "../src/cli.ts";
import { updateLock } from "../src/core/lock.ts";
import type { CommandResult, RunAsync } from "../src/host/run.ts";
import type {
  InstanceListing,
  InstanceRow,
  Report,
  ServiceManager,
} from "../src/host/service/seam.ts";
import { setWriter } from "../src/log.ts";

// An install that fails logs npm's words; they are not wanted in the test report.
setWriter(() => {});

const ok = (stdout: string): CommandResult => ({ status: 0, stdout, stderr: "" });

test("update reads --check or --yes, and nothing else", () => {
  const update = (check: boolean, yes: boolean) => ({ kind: "update", check, yes });
  assert.deepEqual(parseArguments(["update"]), update(false, false));
  assert.deepEqual(parseArguments(["update", "--check"]), update(true, false));
  assert.deepEqual(parseArguments(["update", "--yes"]), update(false, true));
});

test("update refuses an argument it does not know, a repeat, and --check with --yes", () => {
  const refused = (args: string[], reason: string) =>
    assert.deepEqual(parseArguments(args), { kind: "invalid", reason });
  refused(["update", "now"], 'unknown argument "now"');
  refused(["update", "--check", "--check"], "--check is given twice");
  refused(["update", "--yes", "--yes"], "--yes is given twice");
  refused(
    ["update", "--check", "--yes"],
    "--check installs nothing, so --yes has no meaning with it",
  );
  refused(["--check"], 'unknown argument "--check"');
  refused(["service", "status", "--yes"], 'unknown argument "--yes"');
  refused(["--version", "--yes"], 'unknown argument "--yes"');
});

test("update takes no instance: it updates the copy all of them run", () => {
  assert.deepEqual(parseArguments(["update", "--instance", "dev"]), {
    kind: "invalid",
    reason: "update takes no instance: it updates the copy that all of them run",
  });
  // The variable is the instance a command is about; this one is about a copy.
  assert.deepEqual(parseArguments(["update"], { ALLABOARD_INSTANCE: "Bad Name" }), {
    kind: "update",
    check: false,
    yes: false,
  });
});

test("the usage names update", () => {
  assert.match(USAGE, /allaboard update \[--check\] \[--yes\]/);
});

// ---- on a fake machine

function captured(): Output & { stdout: string; stderr: string } {
  const output = {
    stdout: "",
    stderr: "",
    out: (text: string) => {
      output.stdout += text;
    },
    err: (text: string) => {
      output.stderr += text;
    },
  };
  return output;
}

const INSTALLED = "0.3.0";
const LATEST = "0.3.1";
const REFUSED: CommandResult = {
  status: 1,
  stdout: "",
  stderr: "npm error code ECONNREFUSED\nnpm error syscall connect\nnpm error errno ECONNREFUSED\n",
};
const UNWRITABLE = (path: string): CommandResult => ({
  status: 243,
  stdout: "",
  stderr: `npm error code EACCES\nnpm error syscall rename\nnpm error path ${path}\nnpm error errno -13\n`,
});

const running = (instance: string | null, copy: string, pid = 100): InstanceRow => ({
  instance,
  loaded: true,
  pid,
  entry: { copy, version: INSTALLED },
});

interface World {
  host: UpdateHost;
  copy: string;
  home: string;
  /** What ran, in order: `npm ...`, `restart <instance>`, `ask <question>`. */
  calls: string[];
  /** The answers `ask` gives, in order. */
  answers: string[];
}

interface Setup {
  /** What `npm install` leaves in the copy's package.json: a version, or null for no file. */
  installs?: string | null;
  install?: CommandResult;
  latest?: CommandResult;
  /** The rows other instances add to the listing; the default instance runs on the copy. */
  rows?: (copy: string) => InstanceRow[];
  listing?: (copy: string) => InstanceListing;
  interactive?: boolean;
  restart?: (instance: string | null) => Report;
  /** Where the running copy is: in npm's global folder (default), elsewhere, or a link. */
  place?: "global" | "elsewhere" | "link";
  published?: boolean;
  noService?: boolean;
}

function world(t: { after(fn: () => void): void }, setup: Setup = {}): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "allaboard-cli-update-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, "home");
  mkdirSync(home);
  const root = join(base, "global", "lib", "node_modules");
  mkdirSync(root, { recursive: true });
  const copy = join(root, "allaboard");
  const place = setup.place ?? "global";
  const own = place === "global" ? copy : join(base, "checkout", "allaboard");
  mkdirSync(join(own, "dist"), { recursive: true });
  writeFileSync(join(own, "dist", "main.js"), "");
  writeFileSync(join(own, "package.json"), JSON.stringify({ version: INSTALLED }));
  if (place === "link") {
    symlinkSync(own, copy);
  } else if (place === "elsewhere") {
    mkdirSync(copy, { recursive: true });
  }
  const calls: string[] = [];
  const answers: string[] = [];
  const view = (version: string) => `npm view allaboard@${version} version --json`;
  const run: RunAsync = async (command, args) => {
    const line = `${command} ${args.join(" ")}`;
    calls.push(line);
    if (line === "npm root -g") return ok(`${root}\n`);
    if (line === "npm view allaboard version --json") return setup.latest ?? ok(`"${LATEST}"\n`);
    if (line === view(INSTALLED)) {
      return setup.published === false
        ? { status: 1, stdout: "", stderr: "npm error code E404\n" }
        : ok(`"${INSTALLED}"\n`);
    }
    if (line === `npm install -g allaboard@${LATEST}`) {
      const result = setup.install ?? ok("changed 1 package\n");
      const left = setup.installs === undefined ? LATEST : setup.installs;
      if (result.status === 0 && left !== null) {
        writeFileSync(join(copy, "package.json"), JSON.stringify({ version: left }));
      }
      return result;
    }
    throw new Error(`unexpected command: ${line}`);
  };
  const rows = setup.rows?.(copy) ?? [running(null, copy)];
  const service = (instance: string | null): ServiceManager => {
    const fail = (): never => {
      throw new Error("not used by update");
    };
    return {
      install: fail,
      uninstall: fail,
      status: fail,
      list: fail,
      runningPid: fail,
      instances: () => setup.listing?.(copy) ?? { rows, refused: [] },
      restart: () => {
        calls.push(`restart ${instance ?? "default"}`);
        return setup.restart?.(instance) ?? { code: 0, out: ["sent"], err: [] };
      },
    };
  };
  const host: UpdateHost = {
    service: (instance) => (setup.noService === true ? null : service(instance.name)),
    program: () => ({
      node: "/n/node",
      main: join(own, "dist", "main.js"),
      npmBin: null,
      agentExecutables: [],
    }),
    run,
    home,
    version: () => INSTALLED,
    interactive: setup.interactive ?? true,
    ask: async (question) => {
      calls.push(`ask ${question}`);
      return answers.shift() ?? "";
    },
  };
  return { host, copy, home, calls, answers };
}

const CHANGELOG = `https://github.com/duqaXxX/allaboard/blob/v${LATEST}/docs/CHANGELOG.md`;

test("--check prints the installed and the latest version and installs nothing", async (t) => {
  const w = world(t);
  const output = captured();
  assert.equal(await answerUpdate({ kind: "update", check: true, yes: false }, output, w.host), 0);
  assert.equal(output.stdout, `allaboard ${INSTALLED} · latest ${LATEST}\n`);
  assert.equal(output.stderr, "");
  assert.deepEqual(w.calls, ["npm view allaboard version --json"]);
});

test("--check says so when the latest version cannot be had, and answers 1", async (t) => {
  const w = world(t, { latest: REFUSED });
  const output = captured();
  assert.equal(await answerUpdate({ kind: "update", check: true, yes: false }, output, w.host), 1);
  assert.equal(output.stdout, "");
  assert.equal(
    output.stderr,
    "allaboard update: the latest version is unknown: npm could not reach the registry.\n",
  );
});

test("update installs after a yes, then restarts every running instance on the copy", async (t) => {
  const w = world(t, {
    rows: (copy) => [
      running(null, copy, 1),
      // The copy of another install, a service not running and one not loaded are left alone.
      running("other", "/elsewhere/allaboard", 2),
      { ...running("idle", copy), pid: null },
      { ...running("off", copy), loaded: false },
      running("work2", copy, 3),
    ],
  });
  w.answers.push("y");
  const output = captured();
  assert.equal(await answerUpdate({ kind: "update", check: false, yes: false }, output, w.host), 0);
  assert.equal(
    output.stdout,
    [
      `Update allaboard ${INSTALLED} → ${LATEST} · What changed: ${CHANGELOG}`,
      "It restarts: the default instance, work2. Running turns finish first.",
      `Installing allaboard ${LATEST}…`,
      `Installed allaboard ${LATEST}. Sent the restart to the default instance and work2: running turns finish first.`,
      "",
    ].join("\n"),
  );
  assert.equal(output.stderr, "");
  assert.deepEqual(w.calls, [
    "npm root -g",
    `npm view allaboard@${INSTALLED} version --json`,
    "npm view allaboard version --json",
    "ask Update? [y/N] ",
    `npm install -g allaboard@${LATEST}`,
    "restart default",
    "restart work2",
  ]);
});

test("the restart is named in a list of three with a comma and an and", async (t) => {
  const w = world(t, {
    rows: (copy) => [running(null, copy), running("a", copy), running("b", copy)],
  });
  const output = captured();
  await answerUpdate({ kind: "update", check: false, yes: true }, output, w.host);
  assert.match(output.stdout, /It restarts: the default instance, a, b\./);
  assert.match(output.stdout, /Sent the restart to the default instance, a and b:/);
});

test("anything but a yes leaves the copy as it is", async (t) => {
  for (const reply of ["", "n", "N", "no", "maybe", "yy"]) {
    const w = world(t);
    w.answers.push(reply);
    const output = captured();
    const code = await answerUpdate({ kind: "update", check: false, yes: false }, output, w.host);
    assert.equal(code, 0, reply);
    assert.match(output.stdout, /Not updated\.\n$/, reply);
    assert.ok(!w.calls.some((call) => call.startsWith("npm install")), reply);
    assert.ok(!w.calls.some((call) => call.startsWith("restart")), reply);
  }
  for (const reply of ["y", "Y", "yes", "YES", " y "]) {
    const w = world(t);
    w.answers.push(reply);
    const code = await answerUpdate(
      { kind: "update", check: false, yes: false },
      captured(),
      w.host,
    );
    assert.equal(code, 0, reply);
    assert.ok(
      w.calls.some((call) => call.startsWith("npm install")),
      reply,
    );
  }
});

test("without a terminal it does not guess: no --yes, no update", async (t) => {
  const w = world(t, { interactive: false });
  const output = captured();
  assert.equal(await answerUpdate({ kind: "update", check: false, yes: false }, output, w.host), 1);
  assert.equal(
    output.stderr,
    "allaboard update: there is no terminal to ask on; --yes updates without asking.\n",
  );
  assert.ok(!w.calls.some((call) => call.startsWith("npm install")));
  assert.ok(!w.calls.some((call) => call.startsWith("ask")));
});

test("--yes updates without asking, with or without a terminal", async (t) => {
  for (const interactive of [true, false]) {
    const w = world(t, { interactive });
    const output = captured();
    assert.equal(
      await answerUpdate({ kind: "update", check: false, yes: true }, output, w.host),
      0,
    );
    assert.ok(!w.calls.some((call) => call.startsWith("ask")));
    assert.ok(w.calls.includes(`npm install -g allaboard@${LATEST}`));
    assert.match(output.stdout, /Installed allaboard 0\.3\.1\./);
  }
});

test("the latest version already installed is nothing to do", async (t) => {
  const w = world(t, { latest: ok(`"${INSTALLED}"\n`) });
  const output = captured();
  assert.equal(await answerUpdate({ kind: "update", check: false, yes: true }, output, w.host), 0);
  assert.equal(output.stdout, `allaboard ${INSTALLED} is already the latest version.\n`);
  assert.ok(!w.calls.some((call) => call.startsWith("npm install")));
});

test("a copy that runs a version newer than the latest is not downgraded", async (t) => {
  const w = world(t, { latest: ok('"0.2.0"\n') });
  const output = captured();
  assert.equal(await answerUpdate({ kind: "update", check: false, yes: true }, output, w.host), 0);
  assert.equal(output.stdout, `allaboard ${INSTALLED} is already the latest version.\n`);
  assert.ok(!w.calls.some((call) => call.startsWith("npm install")));
});

test("with no service on the copy it only installs, and says so", async (t) => {
  for (const setup of [{ rows: () => [] }, { noService: true }]) {
    const w = world(t, setup);
    const output = captured();
    assert.equal(
      await answerUpdate({ kind: "update", check: false, yes: true }, output, w.host),
      0,
    );
    assert.equal(
      output.stdout,
      [
        `Update allaboard ${INSTALLED} → ${LATEST} · What changed: ${CHANGELOG}`,
        "No service runs this copy: it is installed and nothing restarts.",
        `Installing allaboard ${LATEST}…`,
        `Installed allaboard ${LATEST}. No service runs this copy, so nothing was restarted.`,
        "",
      ].join("\n"),
    );
    assert.ok(!w.calls.some((call) => call.startsWith("restart")));
  }
});

test("a copy that is not the one npm install -g replaces is refused before anything is asked of the registry", async (t) => {
  const elsewhere = world(t, { place: "elsewhere" });
  const output = captured();
  assert.equal(
    await answerUpdate({ kind: "update", check: false, yes: true }, output, elsewhere.host),
    1,
  );
  assert.match(
    output.stderr,
    /^allaboard update: this copy is not updated by this command: it is not the copy `npm install -g` replaces \(.*checkout.allaboard\)\.\n$/,
  );
  assert.deepEqual(elsewhere.calls, ["npm root -g"]);

  const linked = world(t, { place: "link" });
  const linkOutput = captured();
  assert.equal(
    await answerUpdate({ kind: "update", check: false, yes: true }, linkOutput, linked.host),
    1,
  );
  assert.equal(
    linkOutput.stderr,
    "allaboard update: this copy is not updated by this command: it is a link, not an install.\n",
  );

  const unpublished = world(t, { published: false });
  const unpublishedOutput = captured();
  assert.equal(
    await answerUpdate(
      { kind: "update", check: false, yes: true },
      unpublishedOutput,
      unpublished.host,
    ),
    1,
  );
  assert.equal(
    unpublishedOutput.stderr,
    `allaboard update: this copy is not updated by this command: its version ${INSTALLED} is not published on npm.\n`,
  );
});

test("an npm that cannot say whether the copy updates, or what is latest, is told as such", async (t) => {
  const offline = world(t, { latest: REFUSED });
  const output = captured();
  assert.equal(
    await answerUpdate({ kind: "update", check: false, yes: true }, output, offline.host),
    1,
  );
  assert.equal(
    output.stderr,
    "allaboard update: the latest version is unknown: npm could not reach the registry.\n",
  );
  const status = world(t, { latest: { status: 7, stdout: "", stderr: "" } });
  const statusOutput = captured();
  await answerUpdate({ kind: "update", check: false, yes: true }, statusOutput, status.host);
  assert.equal(
    statusOutput.stderr,
    "allaboard update: the latest version is unknown: npm ended with status 7.\n",
  );
});

test("a failed install restarts nothing and says why", async (t) => {
  const cases: Array<[Setup, string]> = [
    [
      { install: UNWRITABLE("/opt/prefix/lib/node_modules/allaboard") },
      "the update failed: npm may not write to /opt/prefix/lib/node_modules/allaboard. Nothing was restarted.",
    ],
    [
      { install: { status: 243, stdout: "", stderr: "npm error code EACCES\n" } },
      "the update failed: npm may not write where it installs. Nothing was restarted.",
    ],
    [
      { install: REFUSED },
      "the update failed: npm could not reach the registry. Nothing was restarted.",
    ],
    [
      { install: { status: 137, stdout: "", stderr: "" } },
      "the update failed: npm ended with status 137. Nothing was restarted.",
    ],
    [
      { install: { status: null, stdout: "", stderr: "spawn npm ENOENT" } },
      "the update failed: npm could not be run. Nothing was restarted.",
    ],
  ];
  for (const [setup, sentence] of cases) {
    const w = world(t, setup);
    const output = captured();
    assert.equal(
      await answerUpdate({ kind: "update", check: false, yes: true }, output, w.host),
      1,
    );
    assert.equal(output.stderr, `allaboard update: ${sentence}\n`);
    assert.ok(!output.stdout.includes("Installed"));
    assert.ok(!w.calls.some((call) => call.startsWith("restart")));
  }
});

test("an install that leaves another version, or none, restarts nothing", async (t) => {
  const other = world(t, { installs: INSTALLED });
  const otherOutput = captured();
  assert.equal(
    await answerUpdate({ kind: "update", check: false, yes: true }, otherOutput, other.host),
    1,
  );
  assert.equal(
    otherOutput.stderr,
    `allaboard update: npm ended, but the copy now holds ${INSTALLED} instead of ${LATEST}, so nothing was restarted; the services keep running ${INSTALLED}. \`npm install -g allaboard@${INSTALLED}\` puts back the version that runs.\n`,
  );
  const none = world(t, { installs: null });
  // A killed npm leaves no package.json at all.
  rmSync(join(none.copy, "package.json"));
  const noneOutput = captured();
  assert.equal(
    await answerUpdate({ kind: "update", check: false, yes: true }, noneOutput, none.host),
    1,
  );
  assert.equal(
    noneOutput.stderr,
    `allaboard update: npm ended, but the copy's version cannot be read, so nothing was restarted; the services keep running ${INSTALLED}. \`npm install -g allaboard@${INSTALLED}\` repairs it.\n`,
  );
  assert.ok(!other.calls.some((call) => call.startsWith("restart")));
  assert.ok(!none.calls.some((call) => call.startsWith("restart")));
});

test("an update under way anywhere on the machine stops this one before it installs", async (t) => {
  const w = world(t);
  const held = await updateLock(w.home);
  try {
    const output = captured();
    assert.equal(
      await answerUpdate({ kind: "update", check: false, yes: true }, output, w.host),
      1,
    );
    assert.equal(
      output.stderr,
      "allaboard update: an update of allaboard is already under way on this machine.\n",
    );
    assert.ok(!w.calls.some((call) => call.startsWith("npm install")));
  } finally {
    await held.release();
  }
});

test("the update lock is held while npm installs and released after, a failed install included", async (t) => {
  for (const install of [undefined, REFUSED]) {
    const w = world(t, install === undefined ? {} : { install });
    let heldDuring = false;
    const inner = w.host.run;
    w.host.run = async (command, args) => {
      if (args[0] === "install") {
        heldDuring = await updateLock(w.home).then(
          async (lock) => {
            await lock.release();
            return false;
          },
          () => true,
        );
      }
      return inner(command, args);
    };
    await answerUpdate({ kind: "update", check: false, yes: true }, captured(), w.host);
    assert.equal(heldDuring, true);
    await (await updateLock(w.home)).release();
  }
});

test("a listing of the services that fails stops the update before it installs", async (t) => {
  const w = world(t, { listing: () => ({ failure: "launchctl list failed: Could not connect" }) });
  const output = captured();
  assert.equal(await answerUpdate({ kind: "update", check: false, yes: true }, output, w.host), 1);
  assert.equal(output.stderr, "allaboard update: launchctl list failed: Could not connect\n");
  assert.ok(!w.calls.some((call) => call.startsWith("npm install")));
});

test("a restart that fails is reported, and the others are still sent", async (t) => {
  const w = world(t, {
    rows: (copy) => [running(null, copy), running("work2", copy)],
    restart: (instance) =>
      instance === null
        ? { code: 1, out: [], err: ["local.allaboard is not running"] }
        : { code: 0, out: [], err: [] },
  });
  const output = captured();
  assert.equal(await answerUpdate({ kind: "update", check: false, yes: true }, output, w.host), 1);
  assert.ok(w.calls.includes("restart work2"));
  assert.match(output.stdout, /Installed allaboard 0\.3\.1\./);
  assert.equal(output.stderr, "local.allaboard is not running\n");
});
