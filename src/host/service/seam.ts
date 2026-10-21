/**
 * What `allaboard service` asks of the machine's service manager. One implementation per system
 * (launchd on macOS today); a system with none has no `service` command.
 */
import type { Program } from "../program.ts";

export const SERVICE_ACTIONS = ["install", "uninstall", "status", "restart", "list"] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

/** What one action printed and its exit status: `out` for stdout, `err` for stderr. */
export interface Report {
  code: number;
  out: string[];
  err: string[];
}

/** One instance's service as `list` reads it: what the machine knows of it, not how it is printed. */
export interface InstanceRow {
  /** The instance's name, null for the default instance. */
  instance: string | null;
  loaded: boolean;
  /** The pid the loaded service runs, null while it does not run. */
  pid: number | null;
  /**
   * The copy the service starts: its package folder and the version in its `package.json` (null
   * when unreadable); `plist-gone` for a loaded service whose definition was removed,
   * `unreadable` for a definition with no entry file.
   */
  entry: "plist-gone" | "unreadable" | { copy: string; version: string | null };
}

/**
 * Every instance's service on the machine, with the definitions that are no instance's (`refused`,
 * one sentence each), or the sentence that says why the machine could not be read.
 */
export type InstanceListing = { rows: InstanceRow[]; refused: string[] } | { failure: string };

export interface ServiceManager {
  /**
   * Writes the service's definition for `program` and loads it, so the daemon starts now and at
   * login. The report names the copy of the package the definition starts.
   */
  install(program: Program): Report;
  /** Unloads the service and removes its definition; leaves the configuration and the logs. */
  uninstall(): Report;
  /** Whether the service is installed, loaded and running. Status 0 when it runs, 3 otherwise. */
  status(): Report;
  /** Sends the daemon `SIGTERM`, the stop that lets running turns finish; the manager starts it again. */
  restart(): Report;
  /** Every instance's service on the machine, loaded or not, with the copy each one runs, printed. */
  list(): Report;
  /** The data `list` prints: the default instance first, then the others by name. */
  instances(): InstanceListing;
  /**
   * The pid the service of this instance runs, null when it is not loaded, not running, or the
   * manager cannot say. A daemon is supervised when this is its own pid: the manager then starts
   * it again after any exit.
   */
  runningPid(): number | null;
}

/** How a manager runs a system command: its exit status (null when killed) and its output. */
export type Run = (
  command: string,
  args: readonly string[],
) => { status: number | null; stdout: string; stderr: string };
