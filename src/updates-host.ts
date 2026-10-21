/**
 * The machine as the core's update sees it (`UpdatesHost`): the daemon's adapter from
 * the host layer (npm, the service manager, the update lock) to the questions the core asks. One
 * of the entry files above the layers, since it imports both sides.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { machineHost } from "./cli.ts";
import type { Instance } from "./core/instance.ts";
import { UpdateUnderWay, updateHeld, updateLock } from "./core/lock.ts";
import type { RestartFailure, UpdatableAnswer, UpdatesHost } from "./core/port/updates.ts";
import { installVersion, latestVersion, updatableCopy } from "./host/npm.ts";
import { programOf } from "./host/program.ts";
import { type RunAsync, runAsync } from "./host/run.ts";
import { logPath } from "./host/service/launchd.ts";
import { loadedOn } from "./host/service/listing.ts";
import type { InstanceRow, ServiceManager } from "./host/service/seam.ts";
import { getLogger } from "./log.ts";
import { errorCode, errorName } from "./values.ts";
import { changelogOf, packageVersion } from "./version.ts";

export const logger = getLogger("allaboard.updates-host");

/** What the update asks of the machine, each with the real thing as its default (`realMachine`). */
export interface UpdateMachine {
  /** Runs npm. */
  readonly run: RunAsync;
  /** The real path of the entry file this process runs (`dist/main.js` of its copy). */
  entry(): string;
  /** The service manager of the instance named (null: the default one); null where the system has none. */
  service(instance: string | null): ServiceManager | null;
}

/** The machine allaboard runs on. The entry is read when asked: a test never reaches it. */
export function realMachine(): UpdateMachine {
  return {
    run: runAsync,
    entry: () => programOf(process.argv[1] ?? "", process.env.PATH ?? "", process.execPath).main,
    service: (name) => machineHost.service({ name }),
  };
}

export interface UpdatesHostOptions {
  readonly machine: UpdateMachine;
  /** The instance this daemon is. */
  readonly instance: Instance;
  /** The owner's home: the update lock lives under it, and so does the instance's log. */
  readonly home: string;
  /** The version this process started as (`installedVersion()` read at the start of `run`). */
  readonly installed: string;
  /** Asks this daemon's own drained stop (`StopSignals.request`). */
  readonly restart: () => void;
}

/** `UpdatesHost` over `options.machine`. */
export function updatesHost(options: UpdatesHostOptions): UpdatesHost {
  const { machine, instance, home, installed } = options;
  const manager = machine.service(instance.name);
  let supervisor: boolean | null = null;

  /** The other loaded instances on `copy`. */
  const othersOn = (copy: string): InstanceRow[] => {
    const listing = manager?.instances();
    if (listing === undefined || "failure" in listing) return [];
    return loadedOn(listing.rows, copy).filter((row) => row.instance !== instance.name);
  };

  return {
    installed,
    logFile: logPath(home, instance.name),
    latest: (signal) => latestVersion(machine.run, signal),
    async updatable(signal): Promise<UpdatableAnswer> {
      // While another process's `npm install -g` replaces the folder, the entry file is not
      // there (npm moves the old folder away and fills a new one): that is no answer about the
      // copy, and the host does not guess one.
      let main: string;
      try {
        main = machine.entry();
      } catch (error) {
        if (errorCode(error) === "ENOENT") return { swapping: true };
        throw error;
      }
      if (!existsSync(main)) return { swapping: true };
      return updatableCopy(machine.run, main, installed, signal);
    },
    copyVersion: (copy) => packageVersion(join(copy, "package.json")),
    // A system with no service manager has nothing that starts the daemon again.
    supervised() {
      if (manager === null) return false;
      // Which process started this one cannot change while it lives, so a pid the manager reports
      // settles it for good; the pages ask on every redraw, and the question is a blocking
      // `launchctl list`. No pid is no answer: "not running" and "could not ask" look alike.
      if (supervisor === null) {
        const pid = manager.runningPid();
        if (pid === null) return false;
        supervisor = pid === process.pid;
      }
      return supervisor;
    },
    sharing: (copy) => othersOn(copy).map((row) => row.instance),
    async lock() {
      try {
        return await updateLock(home);
      } catch (error) {
        if (error instanceof UpdateUnderWay) return null;
        throw error;
      }
    },
    async updateHeld() {
      try {
        return await updateHeld(home);
      } catch (error) {
        // Not an update under way: a daemon the system cannot answer for would otherwise start
        // nothing at all.
        logger.warning(`could not tell whether an update is under way: ${errorName(error)}`);
        return false;
      }
    },
    install: (copy, version, signal) => installVersion(machine.run, copy, version, signal),
    async restartOthers(copy) {
      const failed: RestartFailure[] = [];
      for (const row of othersOn(copy).filter((other) => other.pid !== null)) {
        const report = machine.service(row.instance)?.restart();
        if (report === undefined || report.code !== 0) {
          logger.warning(
            `could not restart instance ${row.instance ?? "(default)"}: ${report?.err.join(" ") ?? "no service manager"}`,
          );
          failed.push({ instance: row.instance, status: report?.code ?? null });
        }
      }
      return failed;
    },
    restart: options.restart,
    changelog: changelogOf,
  };
}
