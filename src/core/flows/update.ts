/**
 * `!allaboard` and the update of allaboard from the chat: the word that shows the
 * version that runs and the latest, `update` that offers the latest and `restart`; the click that
 * installs it, from the offer in a channel or from the chat's own page; and the line the owner is
 * told once per version, under his first message after the daemon learned of it.
 *
 * The click installs first and drains after (plan 2026-10-17): while npm replaces the copy no
 * agent process starts (`SessionManager.blockStarts`), sessions already connected go on, and only
 * once the new version is in place does the daemon ask for the stop it makes on a SIGTERM, so a
 * failed install has no drain to cancel. A click that finds a reason to refuse changes nothing.
 */
import type { InboundMessage, ListPick } from "../../chat/seam.ts";
import { isNewer, isVersion } from "../../semver.ts";
import { errorName } from "../../values.ts";
import { parseBang } from "../commands.ts";
import type {
  InstallOutcome,
  NotUpdatable,
  RestartFailure,
  UpdateLockHeld,
} from "../port/updates.ts";
import type { RestartNotice } from "../state.ts";
import * as texts from "../texts.ts";
import { fill, named } from "../texts.ts";
import { type Outside, type Updates, whyUnknown } from "../updates.ts";
import type { AllaboardFlow } from "./contract.ts";
import { type FlowDeps, isCancelled, logger, type Talk } from "./talk.ts";

/** Wall-clock seconds as `HH:MM` on the daemon's clock, for "checked 14:05". */
export function clockTime(seconds: number): string {
  const at = new Date(seconds * 1000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function updating(deps: FlowDeps, updates: Updates, talk: Talk): AllaboardFlow {
  const { chat, sessions, state, names } = deps;
  const { host } = updates;

  /** Why the copy updates outside the chat, as a sentence, for a markup. */
  const outside = (refusal: Outside, markup: "notice" | "reference"): string => {
    const reason =
      refusal.kind === "not-global"
        ? fill(texts.UPDATE_REASON_NOT_GLOBAL, { path: chat.escape(refusal.folder, markup) })
        : refusal.kind === "link"
          ? texts.UPDATE_REASON_LINK
          : fill(texts.UPDATE_REASON_UNPUBLISHED, { version: refusal.version });
    return fill(named(texts.UPDATE_OUTSIDE, names), { reason });
  };

  const notAService = (): string => named(texts.UPDATE_NOT_A_SERVICE, names);

  /** The sentence of an install that left the version it was asked for, or did not end well. */
  const notInstalled = (
    outcome: Exclude<InstallOutcome, { kind: "installed" }>,
    version: string,
  ): string => {
    const installed = updates.installed;
    if (outcome.kind === "mismatch") {
      return outcome.found === null
        ? fill(texts.UPDATE_UNREADABLE, { installed })
        : fill(texts.UPDATE_MISMATCH, { found: outcome.found, latest: version, installed });
    }
    const { failure } = outcome;
    if (failure.kind === "network") return fill(texts.UPDATE_FAILED_NETWORK, { installed });
    const log = chat.escape(host.logFile, "notice");
    if (failure.kind === "permission") {
      const folder = failure.path === null ? "the folder it installs into" : failure.path;
      return fill(texts.UPDATE_FAILED_PERMISSION, {
        folder: chat.escape(folder, "notice"),
        installed,
        log,
      });
    }
    return fill(texts.UPDATE_FAILED_OTHER, { status: failure.status ?? "unknown", installed, log });
  };

  /** The sentences of the instances an install's restart did not reach, one a line; null when none. */
  const notRestarted = (failures: readonly RestartFailure[]): string | null => {
    if (failures.length === 0) return null;
    return failures
      .map(({ instance, status }) => {
        const reason =
          status === null
            ? texts.UPDATE_OTHER_NO_MANAGER
            : fill(texts.UPDATE_OTHER_STATUS, { status });
        return instance === null
          ? fill(texts.UPDATE_OTHER_FAILED_DEFAULT, { reason })
          : fill(texts.UPDATE_OTHER_FAILED, { name: instance, reason });
      })
      .join("\n");
  };

  /** What `NotUpdatable` says to the owner when a click could not prove the copy. */
  const unproven = (refusal: NotUpdatable): { text: string; failed: boolean } =>
    refusal.kind === "npm"
      ? { text: fill(texts.UPDATE_UNKNOWN, { reason: whyUnknown(refusal.failure) }), failed: true }
      : { text: outside(refusal, "notice"), failed: false };

  /** The offer rewritten into `text`; a chat that refuses is logged, the update goes on. */
  const rewrite = async (channel: string, list: string, text: string): Promise<void> => {
    if (talk.stopped) return;
    try {
      await chat.channel(channel).rewrite(list, text);
    } catch (error) {
      if (isCancelled(error)) throw error;
      logger.warning(`could not rewrite the update offer in ${channel}: ${errorName(error)}`);
    }
  };

  /**
   * Records the message the next start rewrites, before the stop that ends this process is asked
   * (a missing note is no reason to keep the daemon from restarting).
   */
  const remember = (notice: RestartNotice): void => {
    try {
      state.setRestartNotice(notice);
    } catch (error) {
      logger.warning(`could not record the restart notice: ${errorName(error)}`);
    }
  };

  /** A `!allaboard restart` is being answered or has asked the stop. */
  let restartAsked = false;

  /** `install` that never throws: a host that fails to run npm at all is an install that failed. */
  const install = async (copy: string, version: string): Promise<InstallOutcome> => {
    try {
      return await host.install(copy, version, updates.installing);
    } catch (error) {
      logger.error(`the install could not run: ${errorName(error)}`);
      return { kind: "failed", failure: { kind: "other", status: null } };
    }
  };

  async function click(pick: Extract<ListPick, { type: "update" }>): Promise<void> {
    const { channel, list, version } = pick;
    // The value of a control the chat drew from a version; anything else is not ours to install.
    if (!isVersion(version)) {
      logger.warning("ignored an update click that carries no version");
      return;
    }
    const offer = channel !== null && list !== null ? { channel, list } : null;
    // For the owner alone, leaving the offer as it is: another click is already at work on it. A
    // click on the chat's own page has no message to answer on; that page shows the state.
    const aside = async (text: string): Promise<void> => {
      if (offer !== null && !talk.stopped) await chat.channel(offer.channel).tell(text);
    };
    const running = updates.phase;
    if (running.kind === "installing" || running.kind === "restarting") {
      await aside(fill(texts.UPDATE_UNDER_WAY, { version: running.version }));
      return;
    }
    if (sessions.draining) {
      await aside(texts.UPDATE_DRAINING);
      return;
    }
    // (sync) Claimed with the checks above, before the first await: a second click finds it. A
    // stop that already cancelled the install refuses the claim.
    if (!updates.begin(version)) {
      await aside(texts.UPDATE_DRAINING);
      return;
    }
    let settled = false;
    let lock: UpdateLockHeld | null = null;
    let unblock: (() => void) | null = null;
    let restarting = false;
    /** The click ended with `text`: on the offer, and on the page when it `failed`. */
    const settle = async (text: string, failed: boolean): Promise<void> => {
      settled = true;
      if (failed) updates.fail(version, text);
      else updates.abandon();
      if (offer !== null) await rewrite(offer.channel, offer.list, text);
    };
    try {
      lock = await host.lock();
      if (lock === null) {
        settled = true;
        updates.abandon();
        await aside(texts.UPDATE_ELSEWHERE);
        return;
      }
      if (sessions.draining) {
        settled = true;
        updates.abandon();
        await aside(texts.UPDATE_DRAINING);
        return;
      }
      const installed = updates.installed;
      if (!isNewer(version, installed)) {
        await settle(fill(texts.UPDATE_ALREADY_RUNS, { latest: installed }), false);
        return;
      }
      const found = await updates.validate();
      // A stop came while npm was asked (a drain, or one with none that cancelled the install):
      // nothing is installed, and no sentence about npm is made of its answer to the stop.
      if (found === null || updates.installing.aborted) {
        settled = true;
        updates.abandon();
        await aside(texts.UPDATE_DRAINING);
        return;
      }
      if ("swapping" in found) {
        // Another process (a terminal's `npm install -g`) is replacing the copy this very moment.
        settled = true;
        updates.abandon();
        await aside(texts.UPDATE_ELSEWHERE);
        return;
      }
      if ("refusal" in found) {
        const { text, failed } = unproven(found.refusal);
        await settle(text, failed);
        return;
      }
      if (!host.supervised()) {
        await settle(notAService(), true);
        return;
      }
      if (host.copyVersion(found.copy) === version) {
        await settle(fill(texts.UPDATE_COPY_HOLDS, { latest: version, installed }), true);
        return;
      }
      unblock = sessions.blockStarts();
      const newer = updates.newer;
      const underWay =
        newer !== null && isNewer(newer, version)
          ? fill(texts.UPDATE_NEWER_SINCE, { latest: version, newer })
          : fill(texts.UPDATE_INSTALLING, { latest: version });
      if (offer !== null) await rewrite(offer.channel, offer.list, underWay);
      const outcome = await install(found.copy, version);
      if (outcome.kind !== "installed") {
        await settle(notInstalled(outcome, version), true);
        return;
      }
      let failures: readonly RestartFailure[] = [];
      try {
        failures = await host.restartOthers(found.copy);
      } catch (error) {
        logger.error(`could not restart the other instances: ${errorName(error)}`);
      }
      // The block stays up until the process ends: no agent starts between the swap and the exit.
      restarting = true;
      settled = true;
      const note = notRestarted(failures);
      updates.restarting(version, note);
      if (offer !== null) {
        const installedText = fill(texts.UPDATE_INSTALLED, { latest: version });
        await rewrite(
          offer.channel,
          offer.list,
          note === null ? installedText : `${installedText}\n${note}`,
        );
        // An offer that names an instance still to restart by hand keeps that line: the next
        // start's rewrite would replace it with `Updated to…`.
        if (note === null) remember({ channel: offer.channel, message: offer.list, version });
      }
      host.restart();
    } finally {
      if (!settled) updates.abandon();
      if (!restarting) unblock?.();
      await lock?.release();
    }
  }

  return {
    async show() {
      await updates.current();
      const installed = updates.installed;
      const time = clockTime(updates.checkedAt ?? deps.now());
      const failure = updates.checkFailure;
      const newer = updates.newer;
      const lines = [
        failure !== null
          ? fill(texts.UPDATE_STATUS_UNKNOWN, { installed, reason: whyUnknown(failure), time })
          : newer !== null
            ? fill(texts.UPDATE_STATUS_NEWER, { installed, latest: newer, time })
            : fill(texts.UPDATE_STATUS_CURRENT, { installed, time }),
      ];
      const refusal = updates.refusal;
      if (refusal !== null) lines.push(outside(refusal, "reference"));
      else if (updates.canUpdate && !host.supervised()) lines.push(notAService());
      return lines.join("\n");
    },

    async update(channel) {
      const running = updates.phase;
      if (running.kind === "installing" || running.kind === "restarting") {
        await talk.inChannel(channel, fill(texts.UPDATE_UNDER_WAY, { version: running.version }));
        return;
      }
      if (sessions.draining) {
        await talk.inChannel(channel, texts.UPDATE_DRAINING);
        return;
      }
      await updates.check();
      const refusal = updates.refusal;
      const failure = updates.checkFailure;
      const copy = updates.copy;
      const newer = updates.newer;
      if (refusal !== null) {
        await talk.inChannel(channel, outside(refusal, "notice"));
      } else if (failure !== null) {
        await talk.inChannel(channel, fill(texts.UPDATE_UNKNOWN, { reason: whyUnknown(failure) }));
      } else if (newer !== null && copy === null) {
        // A newer version, and no answer yet about the copy: it is being replaced right now.
        await talk.inChannel(channel, texts.UPDATE_ELSEWHERE);
      } else if (newer === null || copy === null) {
        await talk.inChannel(channel, fill(texts.UPDATE_LATEST, { installed: updates.installed }));
      } else if (!host.supervised()) {
        await talk.inChannel(channel, notAService());
      } else {
        await chat.channel(channel).offer(
          {
            type: "update",
            from: updates.installed,
            to: newer,
            changelog: host.changelog(newer),
            sharing: host.sharing(copy),
          },
          fill(texts.UPDATE_OFFER, { installed: updates.installed, latest: newer }),
        );
      }
    },

    async restart(channel) {
      const running = updates.phase;
      if (running.kind === "installing" || running.kind === "restarting") {
        await talk.inChannel(channel, fill(texts.UPDATE_UNDER_WAY, { version: running.version }));
        return;
      }
      if (sessions.draining || restartAsked) {
        await talk.inChannel(channel, texts.RESTARTING);
        return;
      }
      // (sync) Claimed before the first await: a second `!allaboard restart` (a double send, an
      // event delivered twice) finds it, so the stop is asked and recorded once.
      restartAsked = true;
      let asked = false;
      try {
        if (await host.updateHeld()) {
          // Another process is replacing the copy: a restart now would start from half of it.
          await talk.inChannel(channel, texts.UPDATE_ELSEWHERE);
        } else if (!host.supervised()) {
          await talk.inChannel(channel, notAService());
        } else {
          const message = await talk.postInChannel(channel, texts.UPDATE_RESTART);
          if (message !== null) remember({ channel, message, version: null });
          host.restart();
          asked = true;
        }
      } finally {
        // A restart that was refused leaves the next one free; one that asked the stop is the last.
        if (!asked) restartAsked = false;
      }
    },

    // The drain waits for a click, and a stop with no drain ends its install (`Updates.track`).
    picked: (pick) => updates.track(() => click(pick)),

    async notice(message: InboundMessage) {
      // (sync) Decided and recorded before anything is awaited: the caller starts the message's
      // own handling right after, and it must take its place in line first (`messages.ts`).
      const version = updates.noticeDue(state.updateNotice);
      if (version === null) return;
      try {
        state.setUpdateNotice(version);
      } catch (error) {
        logger.warning(`could not record the update told of: ${errorName(error)}`);
        return;
      }
      // Asking about allaboard is being told; the line would repeat the answer.
      const typed = message.literal ? null : (parseBang(message.text) ?? parseBang(message.plain));
      if (typed?.kind === "allaboard") return;
      const text = fill(texts.UPDATE_NOTICE, { latest: version, installed: updates.installed });
      // A message of the channel opens a thread that has no reply yet, and a chat may show a
      // line for the owner alone in a thread only once it is active: the line goes to the
      // channel. A chat that refuses the line does not hold the message back.
      try {
        if (message.topLevel) await chat.channel(message.ref.channel).tell(text);
        else await talk.tell(message.ref, text);
      } catch (error) {
        logger.warning(`could not tell the owner of ${version}: ${errorName(error)}`);
      }
    },
  };
}
