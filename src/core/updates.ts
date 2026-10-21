/**
 * The update of allaboard as the core knows it: what the last check learned of the
 * newest version and of the copy, the phase of an update under way, and what the chat's own page
 * is given to draw. The host (`UpdatesHost`) does every slow thing; this file keeps its answers
 * in memory and tells whoever draws that they changed.
 */
import type { Clock } from "../clock.ts";
import { getLogger } from "../log.ts";
import { isNewer } from "../semver.ts";
import { errorName } from "../values.ts";
import type { NotUpdatable, UpdatableAnswer, UpdateFailure, UpdatesHost } from "./port/updates.ts";
import * as texts from "./texts.ts";
import { fill } from "./texts.ts";

export const logger = getLogger("allaboard.core.updates");

/** A copy that updates outside the chat, and why (a `NotUpdatable` that npm's failure is not). */
export type Outside = Exclude<NotUpdatable, { readonly kind: "npm" }>;

/** The registry is asked at start and every 6 hours. */
export const UPDATE_CHECK_SECONDS = 6 * 60 * 60;

/** A check that could not finish (the copy was being replaced) is asked again after this. */
export const UPDATE_RETRY_SECONDS = 30;

/**
 * How many checks in a row may find the entry file missing before the short retries end: a swap
 * by another process lasts seconds, and a file that is gone for good (`npm uninstall -g` under a
 * live daemon) must not be asked about every 30 seconds for as long as the daemon runs.
 */
export const UPDATE_RETRY_LIMIT = 10;

/** Where an update is: nothing under way, installing, installed and waiting to restart, or failed. */
export type UpdatePhase =
  | { readonly kind: "idle" }
  | { readonly kind: "installing"; readonly version: string }
  /** `note` is the sentence of the instances that did not restart, or null. */
  | { readonly kind: "restarting"; readonly version: string; readonly note: string | null }
  /** `text` is the sentence of the failure, written for a notice. */
  | { readonly kind: "failed"; readonly version: string; readonly text: string };

/** What the chat's own page draws of the update; none for a copy that does not update. */
export interface UpdateLine {
  readonly installed: string;
  /** The version the line offers, or the update under way installs. */
  readonly latest: string;
  readonly changelog: string;
  readonly phase: "available" | "installing" | "restarting" | "failed";
  /** The sentence of a failed update, written for a notice; null in any other phase. */
  readonly failure: string | null;
  /** What follows "Installed": the instances that did not restart, one sentence a line; or null. */
  readonly note: string | null;
}

export class Updates {
  readonly host: UpdatesHost;
  /**
   * Called after a change a page may show: a check, a phase. The daemon sets it to the chat's
   * index refresh. A throw is logged here.
   */
  onChange: (() => void) | null = null;
  readonly #now: () => number;
  #latest: string | null = null;
  #checkedAt: number | null = null;
  #failure: UpdateFailure | null = null;
  #updatable: { copy: string } | { refusal: NotUpdatable } | null = null;
  #phase: UpdatePhase = { kind: "idle" };
  #checking: Promise<boolean> | null = null;
  // Checks in a row that found the copy being replaced (`UPDATE_RETRY_LIMIT`).
  #swaps = 0;
  // Ended at the start of the shutdown: a registry question has no use then.
  readonly #checkEnd = new AbortController();
  // Ended when a drain begins: a click that has not reached `npm install` stops asking.
  readonly #drainStart = new AbortController();
  // Ended when the stop will not wait for an install any more: npm gets SIGTERM and rolls back.
  readonly #installEnd = new AbortController();
  // The clicks under way (`track`): the drain waits for them.
  readonly #clicks = new Set<Promise<void>>();

  constructor(host: UpdatesHost, options: { readonly now: () => number }) {
    this.host = host;
    this.#now = options.now;
  }

  /** The version this process runs. */
  get installed(): string {
    return this.host.installed;
  }

  /** The newest version the last successful check found; null before one. */
  get latest(): string | null {
    return this.#latest;
  }

  /** Wall-clock seconds of the last check, successful or not; null before one. */
  get checkedAt(): number | null {
    return this.#checkedAt;
  }

  /** Why the last check could not say; null when it could. */
  get checkFailure(): UpdateFailure | null {
    return this.#failure;
  }

  /** Why the copy is not one an update replaces; null when it is, when unknown, or when npm could not say. */
  get refusal(): Outside | null {
    const found = this.#updatable;
    if (found === null || !("refusal" in found) || found.refusal.kind === "npm") return null;
    return found.refusal;
  }

  /** The package folder of the copy the last check found to be one an update replaces. */
  get copy(): string | null {
    return this.#updatable !== null && "copy" in this.#updatable ? this.#updatable.copy : null;
  }

  /** Whether the last check found the copy to be one an update replaces. */
  get canUpdate(): boolean {
    return this.copy !== null;
  }

  get phase(): UpdatePhase {
    return this.#phase;
  }

  /** The latest version when it is newer than the one that runs. */
  get newer(): string | null {
    return this.#latest !== null && isNewer(this.#latest, this.installed) ? this.#latest : null;
  }

  /** The signal that cancels the install of the click (`cancelInstall`). */
  get installing(): AbortSignal {
    return this.#installEnd.signal;
  }

  /** Whether a click is at work (an install, or what follows it). */
  get working(): boolean {
    return this.#clicks.size > 0;
  }

  /**
   * Runs the work of a click so that a stop can wait for it (`settled`, `cancelInstall`). `work`
   * starts at once, so its first lines run before this returns.
   */
  track(work: () => Promise<void>): Promise<void> {
    const running: Promise<void> = work().finally(() => this.#clicks.delete(running));
    this.#clicks.add(running);
    return running;
  }

  /**
   * The drain's wait for the update: resolves once no click is at work, or when `cutShort`
   * aborts. A click inside `validate` (still asking npm whether the copy updates) is ended at the
   * start of the wait, since a question that hangs would hold the drain for its whole limit; any
   * other click, an install under way included, is waited for.
   */
  async settled(cutShort: AbortSignal): Promise<void> {
    this.#drainStart.abort();
    const cut = new Promise<void>((resolve) => {
      if (cutShort.aborted) resolve();
      else cutShort.addEventListener("abort", () => resolve(), { once: true });
    });
    while (this.working && !cutShort.aborted) {
      await Promise.race([Promise.allSettled([...this.#clicks]), cut]);
    }
  }

  /**
   * The stop will not wait for the install: npm under way is sent SIGTERM (it finishes its step,
   * puts the old folder back and ends), and no other install starts. Resolves once every click
   * has ended; never rejects.
   */
  async cancelInstall(): Promise<void> {
    this.#installEnd.abort();
    await Promise.allSettled([...this.#clicks]);
  }

  /** The shutdown began: a question to the registry under way is ended. */
  endChecks(): void {
    this.#checkEnd.abort();
  }

  /**
   * Asks the host for the newest version and for the copy; one at a time, never rejects. Resolves
   * false when the answer is not complete (the copy was being replaced by another process: the
   * previous answer about the copy stands and the caller asks again soon, up to
   * `UPDATE_RETRY_LIMIT` times in a row), true otherwise.
   */
  check(): Promise<boolean> {
    this.#checking ??= this.#check().finally(() => {
      this.#checking = null;
    });
    return this.#checking;
  }

  async #check(): Promise<boolean> {
    let complete = true;
    try {
      const signal = this.#checkEnd.signal;
      const [latest, updatable] = await Promise.all([
        this.host.latest(signal),
        this.host.updatable(signal),
      ]);
      if ("swapping" in updatable) {
        this.#swaps += 1;
        if (this.#swaps < UPDATE_RETRY_LIMIT) complete = false;
        // The file is not coming back soon: the answer about the copy is not kept, so that
        // nothing offers an update of a copy that is gone, and the long wait begins.
        else this.#updatable = null;
      } else {
        this.#swaps = 0;
        this.#updatable = updatable;
      }
      if ("version" in latest) {
        this.#latest = latest.version;
        this.#failure = null;
        // A version newer than the one that failed is a new offer, not the old failure.
        if (this.#phase.kind === "failed" && isNewer(latest.version, this.#phase.version)) {
          this.#phase = { kind: "idle" };
        }
      } else {
        this.#failure = latest.failure;
      }
      // npm that could not say what the copy is leaves the update unproven, as an unknown latest does.
      if (this.#failure === null && "refusal" in updatable && updatable.refusal.kind === "npm") {
        this.#failure = updatable.refusal.failure;
      }
    } catch (error) {
      logger.warning(`the update check failed: ${errorName(error)}`);
      this.#failure = { kind: "other", status: null };
    }
    this.#checkedAt = this.#now();
    this.#changed();
    return complete;
  }

  /** The state of a check, made once if none has run yet. */
  async current(): Promise<void> {
    if (this.#checkedAt === null || this.#checking !== null) await this.check();
  }

  /**
   * Asks the host again whether the copy updates, and keeps the answer; `swapping` (the copy is
   * being replaced by another process) keeps the previous one and the count of swaps; any other
   * answer restarts that count (`UPDATE_RETRY_LIMIT`). Null when a drain or the shutdown
   * ended the question: what npm answered to its SIGTERM is no answer about the copy.
   */
  async validate(): Promise<UpdatableAnswer | null> {
    const signal = AbortSignal.any([this.#checkEnd.signal, this.#drainStart.signal]);
    const found = await this.host.updatable(signal);
    if (signal.aborted) return null;
    if (!("swapping" in found)) {
      this.#updatable = found;
      this.#swaps = 0;
    }
    this.#changed();
    return found;
  }

  /**
   * Claims the update of `version`: false while another is installing or waiting to restart, and
   * once the stop cancelled the install.
   */
  begin(version: string): boolean {
    if (this.#installEnd.signal.aborted) return false;
    if (this.#phase.kind === "installing" || this.#phase.kind === "restarting") return false;
    this.#phase = { kind: "installing", version };
    this.#changed();
    return true;
  }

  /** The claim ended with nothing installed and nothing to say: back to what a check found. */
  abandon(): void {
    this.#phase = { kind: "idle" };
    this.#changed();
  }

  /**
   * `version` is installed: the daemon waits for running turns to finish, then restarts. `note`
   * tells the instances that did not restart.
   */
  restarting(version: string, note: string | null = null): void {
    this.#phase = { kind: "restarting", version, note };
    this.#changed();
  }

  /** The update of `version` did not happen; `text` says why, for a notice. */
  fail(version: string, text: string): void {
    this.#phase = { kind: "failed", version, text };
    this.#changed();
  }

  /**
   * The version the owner has not been told of yet, once per version (`told` is the last one he
   * was told); null when up to date, for a copy that does not update, while an update is under
   * way, for a daemon no service runs, and before a check.
   */
  noticeDue(told: string | null): string | null {
    const latest = this.newer;
    if (latest === null || !this.canUpdate || latest === told) return null;
    if (this.#phase.kind === "installing" || this.#phase.kind === "restarting") return null;
    // Asked last: it runs the service manager. A daemon no service runs cannot update, as a copy
    // that updates outside the chat cannot (`!allaboard` says why).
    return this.host.supervised() ? latest : null;
  }

  /**
   * The line of the chat's own page; null when there is nothing to offer, the copy does not
   * update, or no service runs this daemon.
   */
  line(): UpdateLine | null {
    if (!this.canUpdate) return null;
    const phase = this.#phase;
    const latest = phase.kind === "idle" ? this.newer : phase.version;
    if (latest === null || !this.host.supervised()) return null;
    return {
      installed: this.installed,
      latest,
      changelog: this.host.changelog(latest),
      phase: phase.kind === "idle" ? "available" : phase.kind,
      failure: phase.kind === "failed" ? phase.text : null,
      note: phase.kind === "restarting" ? phase.note : null,
    };
  }

  #changed(): void {
    try {
      this.onChange?.();
    } catch (error) {
      logger.warning(`the page was not told of an update change: ${errorName(error)}`);
    }
  }
}

/**
 * The scheduled check: one at start, then one every `seconds`, none once a stop has begun (the
 * daemon is leaving, and the next start checks anyway). A check that could not finish (`check`
 * resolved false) is asked again after `retrySeconds`. Ends when `signal` aborts; a check in
 * flight ends with the shutdown (`Updates.endChecks`).
 */
export async function checkEvery(options: {
  readonly seconds: number;
  /** The wait after a check that could not finish (`check` resolved false); `seconds` when absent. */
  readonly retrySeconds?: number;
  readonly check: () => Promise<boolean>;
  readonly sessions: { readonly draining: boolean };
  readonly clock: Clock;
  readonly signal: AbortSignal;
}): Promise<void> {
  for (;;) {
    if (options.signal.aborted || options.sessions.draining) return;
    const complete = await options.check();
    try {
      await options.clock.sleep(
        complete ? options.seconds : (options.retrySeconds ?? options.seconds),
        options.signal,
      );
    } catch {
      return; // the stop: the only thing that ends a sleep
    }
  }
}

/** Why npm could not say what it was asked, as a clause after a colon. */
export function whyUnknown(failure: UpdateFailure): string {
  switch (failure.kind) {
    case "network":
      return texts.UPDATE_WHY_NETWORK;
    case "permission":
      return texts.UPDATE_WHY_PERMISSION;
    case "other":
      return fill(texts.UPDATE_WHY_STATUS, { status: failure.status ?? "unknown" });
  }
}

/**
 * The sentence that says which instances restart with this one, or null when none does: the
 * other loaded instances on the copy (`UpdatesHost.sharing`), null being the default instance.
 */
export function sharedCopyLine(sharing: readonly (string | null)[]): string | null {
  const [only, second] = sharing;
  if (only === undefined) return null;
  if (second === undefined) {
    return only === null
      ? texts.UPDATE_SHARED_DEFAULT
      : fill(texts.UPDATE_SHARED_ONE, { name: only });
  }
  const names = sharing.map((name) =>
    name === null ? texts.UPDATE_DEFAULT_INSTANCE : `\`${name}\``,
  );
  const joined = `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return fill(texts.UPDATE_SHARED_MANY, { names: joined });
}
