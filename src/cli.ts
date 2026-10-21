/**
 * The command line of `allaboard`. With no argument the command runs the daemon, which is what the
 * service starts; the other forms answer and end without reading `.env` or taking the
 * single-instance lock. `--instance <name>`, or `ALLABOARD_INSTANCE` when the flag is absent, picks
 * which of the machine's daemons a command is about (`core/instance.ts`); this file is the only
 * reader of the variable.
 */
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import {
  configDirOf,
  DEFAULT_INSTANCE,
  INSTANCE_VARIABLE,
  type Instance,
  parseInstanceName,
} from "./core/instance.ts";
import { UpdateUnderWay, updateLock } from "./core/lock.ts";
import { answerWizard, type SetupModules } from "./core/wizard.ts";
import {
  type InstallResult,
  installVersion,
  isNewer,
  latestVersion,
  type NpmFailure,
  type Refusal,
  updatableCopy,
} from "./host/npm.ts";
import { type Program, programOf } from "./host/program.ts";
import { askTerminal, chooseTerminal } from "./host/prompter.ts";
import { type RunAsync, runAsync, runCommand } from "./host/run.ts";
import { Launchd } from "./host/service/launchd.ts";
import { loadedOn } from "./host/service/listing.ts";
import { SERVICE_ACTIONS, type ServiceAction, type ServiceManager } from "./host/service/seam.ts";
import { changelogOf, installedVersion } from "./version.ts";

export const USAGE = [
  "usage: allaboard [--instance <name>]                    run the daemon",
  `       allaboard service <${SERVICE_ACTIONS.join("|")}> [--instance <name>]`,
  "       allaboard setup [--instance <name>]",
  "       allaboard update [--check] [--yes]",
  "       allaboard --version | --help",
  "",
  `--instance picks one of the machine's daemons; ${INSTANCE_VARIABLE} does the same when the flag`,
  "is absent. `service list` shows every instance and takes no --instance.",
  "`setup` asks for the tokens and writes the instance's `.env`; it refuses a file that exists.",
  "`update` installs the latest version of the copy that `npm install -g` replaces and restarts",
  "the services that run it, asking first unless --yes; --check only prints the versions.",
].join("\n");

export type Invocation =
  | { kind: "run"; instance: Instance }
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "service"; action: ServiceAction; instance: Instance }
  | { kind: "setup"; instance: Instance }
  | { kind: "update"; check: boolean; yes: boolean }
  | { kind: "invalid"; reason: string };

type Invalid = Extract<Invocation, { kind: "invalid" }>;

function isAction(text: string | undefined): text is ServiceAction {
  return (SERVICE_ACTIONS as readonly (string | undefined)[]).includes(text);
}

const invalid = (reason: string): Invalid => ({ kind: "invalid", reason });

/** The arguments without `--instance <name>`, and the name when it was given. */
function takeInstanceFlag(
  args: readonly string[],
): { rest: string[]; flag: string | undefined } | Invalid {
  const rest: string[] = [];
  let flag: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument !== "--instance") {
      rest.push(argument);
      continue;
    }
    if (flag !== undefined) return invalid("--instance is given twice");
    const value = args[index + 1];
    if (value === undefined) return invalid("--instance needs a name");
    flag = value;
    index += 1;
  }
  return { rest, flag };
}

/** The instance the flag names, else the variable, else the default; the refusal says which. */
function instanceOf(flag: string | undefined, env: Env): Instance | Invalid {
  const variable = env[INSTANCE_VARIABLE];
  const named =
    flag !== undefined
      ? { source: "--instance", text: flag }
      : variable !== undefined && variable !== ""
        ? { source: INSTANCE_VARIABLE, text: variable }
        : null;
  if (named === null) return DEFAULT_INSTANCE;
  const parsed = parseInstanceName(named.text);
  return "refusal" in parsed
    ? invalid(`${named.source}: ${parsed.refusal}`)
    : { name: parsed.name };
}

/** `update`'s own flags: `--check` and `--yes`, once each and not together. */
function parseUpdate(
  args: ReadonlyArray<string | undefined>,
  flag: string | undefined,
): Invocation {
  if (flag !== undefined) {
    return invalid("update takes no instance: it updates the copy that all of them run");
  }
  const given = { "--check": false, "--yes": false };
  for (const argument of args) {
    if (argument === undefined) continue;
    if (argument !== "--check" && argument !== "--yes") {
      return invalid(`unknown argument ${JSON.stringify(argument)}`);
    }
    if (given[argument]) return invalid(`${argument} is given twice`);
    given[argument] = true;
  }
  if (given["--check"] && given["--yes"]) {
    return invalid("--check installs nothing, so --yes has no meaning with it");
  }
  return { kind: "update", check: given["--check"], yes: given["--yes"] };
}

/** The variables the command line reads; `process.env` in the entry. */
export type Env = Readonly<Record<string, string | undefined>>;

/** What the arguments after the command ask for; anything else is `invalid`, with the reason. */
export function parseArguments(args: readonly string[], env: Env = {}): Invocation {
  const taken = takeInstanceFlag(args);
  if ("kind" in taken) return taken;
  const { rest: positional, flag } = taken;
  const [first, second, ...rest] = positional;
  if (first === "update") return parseUpdate([second, ...rest], flag);
  if (first === "setup") {
    if (second !== undefined) return invalid(`unknown argument ${JSON.stringify(second)}`);
    const instance = instanceOf(flag, env);
    return "kind" in instance ? instance : { kind: "setup", instance };
  }
  if (first === undefined) {
    const instance = instanceOf(flag, env);
    return "kind" in instance ? instance : { kind: "run", instance };
  }
  if (first === "service") {
    if (!isAction(second)) {
      return invalid(`service needs one of: ${SERVICE_ACTIONS.join(", ")}`);
    }
    if (rest.length > 0) return invalid(`unknown argument ${JSON.stringify(rest[0])}`);
    if (second === "list") {
      return flag === undefined
        ? { kind: "service", action: second, instance: DEFAULT_INSTANCE }
        : invalid("service list takes no instance: it lists them all");
    }
    const instance = instanceOf(flag, env);
    return "kind" in instance ? instance : { kind: "service", action: second, instance };
  }
  if (second !== undefined) return invalid(`unknown argument ${JSON.stringify(second)}`);
  if (first === "--version" || first === "--help") {
    if (flag !== undefined) return invalid(`${first} takes no instance`);
    return { kind: first === "--version" ? "version" : "help" };
  }
  return invalid(`unknown argument ${JSON.stringify(first)}`);
}

export interface Output {
  out(text: string): void;
  err(text: string): void;
}

/** What `answer` needs of the machine; `machineHost` is the real one. */
export interface Host {
  /** The service manager of this system for `instance`, or null where allaboard has none. */
  service(instance: Instance): ServiceManager | null;
  /**
   * The program the service is to start: this command's Node and entry, and of `agentExecutables`
   * those this command's `PATH` finds.
   */
  program(agentExecutables: readonly string[]): Program;
}

/** The commands the agents in `agents` declare. */
function executablesOf(agents: SetupModules["agents"]): string[] {
  return Object.values(agents).flatMap((agent) => agent.executable ?? []);
}

export const machineHost: Host = {
  service: (instance) =>
    process.platform === "darwin"
      ? new Launchd({
          home: homedir(),
          uid: process.getuid?.() ?? 0,
          instance: instance.name,
          configDir: configDirOf(instance, homedir()),
          run: runCommand,
        })
      : null,
  program: (agentExecutables) =>
    programOf(process.argv[1] ?? "", process.env.PATH ?? "", process.execPath, agentExecutables),
};

/**
 * Answers an invocation that does not run the daemon, and returns the exit status: 0, 2 for
 * arguments it does not know (with the usage on stderr), or the service action's own status.
 * `agents` are the registry's, whose commands the service's `PATH` finds.
 */
export function answer(
  invocation: Exclude<Invocation, { kind: "run" | "update" | "setup" }>,
  output: Output,
  agents: SetupModules["agents"],
  host: Host = machineHost,
): number {
  switch (invocation.kind) {
    case "version":
      output.out(`${installedVersion()}\n`);
      return 0;
    case "help":
      output.out(`${USAGE}\n`);
      return 0;
    case "invalid":
      output.err(`allaboard: ${invocation.reason}\n${USAGE}\n`);
      return 2;
    case "service": {
      const manager = host.service(invocation.instance);
      if (manager === null) {
        output.err("allaboard service: allaboard runs as a service on macOS only, for now.\n");
        return 1;
      }
      const report =
        invocation.action === "install"
          ? manager.install(host.program(executablesOf(agents)))
          : manager[invocation.action]();
      for (const line of report.out) output.out(`${line}\n`);
      for (const line of report.err) output.err(`${line}\n`);
      return report.code;
    }
  }
}

/** What `setup` needs of the machine beyond the service: the home and a terminal to ask on. */
export interface SetupHost extends Host {
  home: string;
  /** Whether there is a terminal to ask on. */
  interactive: boolean;
  /** The line the owner types after `message`, or null when they end the wizard. */
  ask(message: string, secret: boolean): Promise<string | null>;
  /** The name the owner picks from `names`, `preselected` first, or null when they end the wizard. */
  choose(message: string, names: readonly string[], preselected: string): Promise<string | null>;
}

export const machineSetupHost: SetupHost = {
  ...machineHost,
  home: homedir(),
  // A getter, as in `machineUpdateHost`.
  get interactive() {
    return process.stdin.isTTY === true && process.stdout.isTTY === true;
  },
  ask: askTerminal,
  choose: chooseTerminal,
};

/**
 * Answers `allaboard setup` with `modules`, the chats and agents the registry holds, which the
 * owner picks from. Returns the wizard's exit status.
 */
export function answerSetup(
  invocation: Extract<Invocation, { kind: "setup" }>,
  modules: SetupModules,
  output: Output,
  host: SetupHost = machineSetupHost,
): Promise<number> {
  const manager = host.service(invocation.instance);
  return answerWizard(invocation.instance, modules, output, {
    home: host.home,
    interactive: host.interactive,
    prompter: { ask: host.ask, choose: host.choose },
    installService:
      manager === null ? null : () => manager.install(host.program(executablesOf(modules.agents))),
  });
}

/** What `update` needs of the machine beyond the service: npm, the home, a terminal. */
export interface UpdateHost extends Host {
  /** Runs npm. */
  run: RunAsync;
  /** The owner's home, where the update lock lives. */
  home: string;
  /** The version of this process, read from its own `package.json` at its start. */
  version(): string;
  /** Whether there is a terminal to ask on. */
  interactive: boolean;
  /** Prints `question` and returns the line the owner types. */
  ask(question: string): Promise<string>;
}

export const machineUpdateHost: UpdateHost = {
  ...machineHost,
  run: runAsync,
  home: homedir(),
  version: installedVersion,
  // A getter: reading `process.stdin` at import would open it in the daemon too.
  get interactive() {
    return process.stdin.isTTY === true && process.stdout.isTTY === true;
  },
  ask: async (question) => {
    const lines = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await lines.question(question);
    } finally {
      lines.close();
    }
  },
};

const failure = (output: Output, sentence: string): number => {
  output.err(`allaboard update: ${sentence}\n`);
  return 1;
};

/** Why the latest version is unknown, from what npm failed with. */
function unknownLatest(why: NpmFailure): string {
  const reason =
    why.kind === "network"
      ? "npm could not reach the registry"
      : why.kind === "permission"
        ? "npm may not read what it needs"
        : why.status === null
          ? "npm could not be run"
          : `npm ended with status ${why.status}`;
  return `the latest version is unknown: ${reason}.`;
}

/** Why the copy is not one `update` replaces. */
function notUpdated(refusal: Refusal): string {
  switch (refusal.kind) {
    case "not-global":
      return `this copy is not updated by this command: it is not the copy \`npm install -g\` replaces (${refusal.folder}).`;
    case "link":
      return "this copy is not updated by this command: it is a link, not an install.";
    case "unpublished":
      return `this copy is not updated by this command: its version ${refusal.version} is not published on npm.`;
    case "npm":
      return unknownLatest(refusal.failure);
  }
}

/** The sentence for an install that did not leave the version asked, or null when it did. */
function installFailed(result: InstallResult, running: string, latest: string): string | null {
  switch (result.kind) {
    case "installed":
      return null;
    case "mismatch":
      return result.found === null
        ? `npm ended, but the copy's version cannot be read, so nothing was restarted; the services keep running ${running}. \`npm install -g allaboard@${running}\` repairs it.`
        : `npm ended, but the copy now holds ${result.found} instead of ${latest}, so nothing was restarted; the services keep running ${running}. \`npm install -g allaboard@${running}\` puts back the version that runs.`;
    case "failed": {
      const why = result.failure;
      const reason =
        why.kind === "network"
          ? "npm could not reach the registry"
          : why.kind === "permission"
            ? why.path === null
              ? "npm may not write where it installs"
              : `npm may not write to ${why.path}`
            : why.status === null
              ? "npm could not be run"
              : `npm ended with status ${why.status}`;
      return `the update failed: ${reason}. Nothing was restarted.`;
    }
  }
}

const instanceName = (instance: string | null): string => instance ?? "the default instance";

/**
 * Answers `allaboard update`: `--check` prints the installed and the latest version; otherwise
 * checks that this copy is the one `npm install -g` replaces, asks (unless `--yes`), takes the
 * machine's update lock, installs the latest version, checks the copy now holds it, and sends the
 * restart to every service running this copy. Returns the exit status: 0 when it updated or had
 * nothing to do, 1 when it failed.
 */
export async function answerUpdate(
  invocation: Extract<Invocation, { kind: "update" }>,
  output: Output,
  host: UpdateHost = machineUpdateHost,
): Promise<number> {
  // Before anything is awaited: the install replaces the `package.json` this reads.
  const running = host.version();
  if (invocation.check) {
    const latest = await latestVersion(host.run);
    if ("failure" in latest) return failure(output, unknownLatest(latest.failure));
    output.out(`allaboard ${running} · latest ${latest.version}\n`);
    return 0;
  }
  // Only the entry is read: an update installs no service.
  const updatable = await updatableCopy(host.run, host.program([]).main, running);
  if ("refusal" in updatable) return failure(output, notUpdated(updatable.refusal));
  const latest = await latestVersion(host.run);
  if ("failure" in latest) return failure(output, unknownLatest(latest.failure));
  if (!isNewer(latest.version, running)) {
    output.out(`allaboard ${running} is already the latest version.\n`);
    return 0;
  }
  const listing = host.service(DEFAULT_INSTANCE)?.instances() ?? { rows: [], refused: [] };
  if ("failure" in listing) return failure(output, listing.failure);
  const restarts = loadedOn(listing.rows, updatable.copy).filter((row) => row.pid !== null);
  output.out(
    `Update allaboard ${running} → ${latest.version} · What changed: ${changelogOf(latest.version)}\n`,
  );
  output.out(
    restarts.length === 0
      ? "No service runs this copy: it is installed and nothing restarts.\n"
      : `It restarts: ${restarts.map((row) => instanceName(row.instance)).join(", ")}. Running turns finish first.\n`,
  );
  if (!invocation.yes) {
    if (!host.interactive) {
      return failure(output, "there is no terminal to ask on; --yes updates without asking.");
    }
    if (!/^y(es)?$/i.test((await host.ask("Update? [y/N] ")).trim())) {
      output.out("Not updated.\n");
      return 0;
    }
  }
  let lock: Awaited<ReturnType<typeof updateLock>>;
  try {
    lock = await updateLock(host.home);
  } catch (error) {
    if (error instanceof UpdateUnderWay) {
      return failure(output, "an update of allaboard is already under way on this machine.");
    }
    throw error;
  }
  try {
    output.out(`Installing allaboard ${latest.version}…\n`);
    const installed = await installVersion(host.run, updatable.copy, latest.version);
    const refusal = installFailed(installed, running, latest.version);
    if (refusal !== null) return failure(output, refusal);
  } finally {
    await lock.release();
  }
  const sent: string[] = [];
  let code = 0;
  for (const row of restarts) {
    const report = host.service({ name: row.instance })?.restart();
    if (report === undefined || report.code !== 0) {
      code = 1;
      for (const line of report?.err ?? []) output.err(`${line}\n`);
    } else {
      sent.push(instanceName(row.instance));
    }
  }
  const named =
    sent.length < 2 ? sent.join("") : `${sent.slice(0, -1).join(", ")} and ${sent.at(-1)}`;
  output.out(
    restarts.length === 0
      ? `Installed allaboard ${latest.version}. No service runs this copy, so nothing was restarted.\n`
      : sent.length === 0
        ? `Installed allaboard ${latest.version}.\n`
        : `Installed allaboard ${latest.version}. Sent the restart to ${named}: running turns finish first.\n`,
  );
  return code;
}
