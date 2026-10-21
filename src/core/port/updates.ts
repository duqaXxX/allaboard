/**
 * The port of the update, in both directions. `UpdatesHost` is what the core asks of
 * the machine allaboard is installed on: the daemon implements it over the host layer (`src/host/`),
 * which the core never imports. `UpdatesPage` is what a chat provider reads to draw the update
 * line of its own page.
 */
import type { Updates } from "../updates.ts";

/**
 * Why an npm command failed, from its own words (`NpmFailure` of the host layer, which this is
 * structurally): `network` when it could not reach the registry, `permission` when it may not
 * write a folder (`path`, the one npm names, or null), `other` with its exit status otherwise
 * (null when it could not start or was killed).
 */
export type UpdateFailure =
  | { readonly kind: "network" }
  | { readonly kind: "permission"; readonly path: string | null }
  | { readonly kind: "other"; readonly status: number | null };

/** Why the running copy is not one an update replaces (`Refusal` of the host layer). */
export type NotUpdatable =
  /** It is not the copy `npm install -g` replaces; `folder` is the package folder it runs from. */
  | { readonly kind: "not-global"; readonly folder: string }
  /** `npm link` made the global folder a link to a checkout. */
  | { readonly kind: "link" }
  /** Its version is not published on npm. */
  | { readonly kind: "unpublished"; readonly version: string }
  /** npm could not say. */
  | { readonly kind: "npm"; readonly failure: UpdateFailure };

/** What `UpdatesHost.updatable` answers. */
export type UpdatableAnswer =
  | { readonly copy: string }
  | { readonly refusal: NotUpdatable }
  | { readonly swapping: true };

/** How an install ended (`InstallResult` of the host layer). */
export type InstallOutcome =
  /** npm ended well and the copy holds `version`. */
  | { readonly kind: "installed"; readonly version: string }
  /** npm ended well and the copy holds another version (`found`), or none that can be read (null). */
  | { readonly kind: "mismatch"; readonly found: string | null }
  | { readonly kind: "failed"; readonly failure: UpdateFailure };

/** An instance the restart did not reach: `status` is the service manager's, null when it has none. */
export interface RestartFailure {
  /** The instance's name; null for the default instance. */
  readonly instance: string | null;
  readonly status: number | null;
}

/** The machine's update lock, held: one update at a time on the machine, whichever instance. */
export interface UpdateLockHeld {
  release(): Promise<void>;
}

/**
 * What the core asks of the machine. Members that ask npm are slow (seconds, and `install` up to
 * a minute) and never reject for npm's own failures: those come back as values.
 */
export interface UpdatesHost {
  /** The version this process started as: read once, before an install replaces the copy. */
  readonly installed: string;
  /**
   * The newest published version, or why it is not known. `signal` ends the question when it
   * aborts (the shutdown): the answer is then a failure.
   */
  latest(
    signal: AbortSignal,
  ): Promise<{ readonly version: string } | { readonly failure: UpdateFailure }>;
  /**
   * Whether the running copy is the one an install replaces: its package folder (`copy`, opaque to
   * the core, handed back to `install` and `copyVersion`), else the refusal; or `swapping` when
   * the running copy's entry file is not there, which is another process's `npm install -g`
   * replacing the folder (it is back in seconds): no answer to keep, ask again soon.
   */
  updatable(signal: AbortSignal): Promise<UpdatableAnswer>;
  /** The version in `copy`'s `package.json` now; null when it cannot be read. */
  copyVersion(copy: string): string | null;
  /**
   * Whether a service of the machine's own runs this very process and starts it again after any
   * exit: only then may the daemon stop to update or restart.
   */
  supervised(): boolean;
  /** The other loaded instances on `copy`: their names, null for the default instance. */
  sharing(copy: string): readonly (string | null)[];
  /** Takes the machine's update lock; null while another process holds it. */
  lock(): Promise<UpdateLockHeld | null>;
  /**
   * Whether the machine's update lock is held now, by another instance's click, by `allaboard
   * update` in a terminal, or by this daemon's own: asking never makes a take fail. Never rejects
   * (what it cannot tell is "no").
   */
  updateHeld(): Promise<boolean>;
  /**
   * Installs exactly `version` over `copy` and reads the copy again. When `signal` aborts the
   * install is sent SIGTERM, which npm answers by putting the old folder back: the outcome is a
   * failure and the call returns once npm has ended.
   */
  install(copy: string, version: string, signal: AbortSignal): Promise<InstallOutcome>;
  /**
   * Sends the restart to the other instances on the copy the install replaced; the ones it did
   * not reach.
   */
  restartOthers(copy: string): Promise<readonly RestartFailure[]>;
  /** Asks this daemon's own drained stop (`StopSignals.request`); the service starts it again. */
  restart(): void;
  /** Where the log is, for a sentence that sends the owner to npm's own words. */
  readonly logFile: string;
  /** The address of what `version` changed. */
  changelog(version: string): string;
}

/** What a chat provider reads of the update: the line of its own page. */
export type UpdatesPage = Pick<Updates, "line">;
