/**
 * The program a service manager starts: which Node, which file, and the folders a session's
 * commands need on their `PATH`. Read from the command being run, so `allaboard service install`
 * names the copy it was started from.
 */
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

export interface Program {
  /** The Node to start, as found on `PATH`: a link such as Homebrew's survives an upgrade. */
  node: string;
  /** The real path of the entry file, `dist/main.js` of the installed package. */
  main: string;
  /** npm's global `bin` folder when the entry is a global install, else null. */
  npmBin: string | null;
  /** The agents' executables as found on `PATH`, links kept: a native install's survives an update. */
  agentExecutables: readonly string[];
}

/**
 * The first executable file called `name` in the absolute folders of `pathVariable`, or null. A
 * relative folder (`.`) names the caller's working folder, which a service does not share.
 */
export function findOnPath(name: string, pathVariable: string): string | null {
  for (const folder of pathVariable.split(delimiter)) {
    if (!isAbsolute(folder)) continue;
    const candidate = join(folder, name);
    try {
      // A folder passes the access check too.
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

// npm's folders page (read 2026-10-16): "Global installs on Unix systems go to
// `{prefix}/lib/node_modules`" and executables "are linked into `{prefix}/bin` on Unix".
const GLOBAL_ENTRY = /^(.*)\/lib\/node_modules\/allaboard\/dist\/main\.js$/;

/**
 * The program of the running command: `entry` is `process.argv[1]` (npm's link in its `bin`
 * folder, resolved here), `pathVariable` the caller's `PATH`, `execPath` the fallback Node,
 * `executables` the agents' own, each kept only when the caller's `PATH` finds it.
 */
export function programOf(
  entry: string,
  pathVariable: string,
  execPath: string,
  executables: readonly string[] = [],
): Program {
  const main = realpathSync(entry);
  const prefix = GLOBAL_ENTRY.exec(main)?.[1];
  return {
    node: findOnPath("node", pathVariable) ?? execPath,
    main,
    npmBin: prefix === undefined ? null : join(prefix, "bin"),
    agentExecutables: executables.flatMap((name) => findOnPath(name, pathVariable) ?? []),
  };
}

/**
 * The folders of the service's `PATH`: Node's own first, then npm's, then the agents' executables'
 * not among the system's, then the system's in their order.
 */
export function servicePath(program: Program, system: readonly string[]): string {
  const folders = [
    dirname(program.node),
    program.npmBin,
    ...program.agentExecutables
      .map((path) => dirname(path))
      .filter((path) => !system.includes(path)),
    ...system,
  ];
  return [...new Set(folders.filter((folder) => folder !== null))].join(":");
}

/** The package folder of the copy whose entry file is `main`: the folder above `dist/`. */
export function copyOf(main: string): string {
  return dirname(dirname(main));
}
