/**
 * `!status` typed in the channel: its folder, then one line per thread of the channel that holds
 * a session, live or not, and what a stop waits for when one is under way. The answer is a
 * notice, small like the rest of the daemon's own lines (the owner, 2026-10-19: the marks read
 * too large at full size).
 */
import type { ListedSession } from "../../agent/seam.ts";
import type { SessionStatus } from "../../chat/seam.ts";
import { errorName } from "../../values.ts";
import { oneLine, TITLE_LIMIT } from "../reply/words.ts";
import type { ThreadSession } from "../sessions/session.ts";
import type { ThreadState } from "../state.ts";
import * as texts from "../texts.ts";
import { fill } from "../texts.ts";
import { type FlowDeps, isCancelled, logger, type Talk } from "./talk.ts";

/**
 * The rows one answer shows, newest first; the older ones are counted. A notice is one line of
 * small text with a limit, and each row carries a link.
 */
export const STATUS_ROWS = 10;

/** How long ago, in one unit, as a channel's `!status` says it of a session at rest. */
export function ago(seconds: number): string {
  const whole = Math.trunc(seconds);
  if (whole < 60) return "just now";
  if (whole < 3600) return `${Math.floor(whole / 60)}m ago`;
  if (whole < 86400) return `${Math.floor(whole / 3600)}h ago`;
  return `${Math.floor(whole / 86400)}d ago`;
}

/** A status that says how a turn ended, or null for any other. */
function outcome(status: SessionStatus | null | undefined): SessionStatus | null {
  return status === "done" || status === "error" ? status : null;
}

/** The answer to `!status` typed in `channel`. */
export type ChannelStatus = (channel: string) => Promise<void>;

/** One thread the answer may show: what is kept of it, and its session when that is live. */
interface Shown {
  readonly thread: string;
  readonly stored: ThreadState;
  readonly live: ThreadSession | null;
  readonly info: ListedSession | undefined;
  /** Seconds since the epoch: the session's last message, else when the thread was opened. */
  readonly when: number;
}

export function channelStatus(deps: FlowDeps, talk: Talk): ChannelStatus {
  const { chat, state, sessions } = deps;

  async function row(channel: string, channelDirectory: string, shown: Shown): Promise<string> {
    const { thread, stored, live, info } = shown;
    const title = info === undefined ? "" : oneLine(info.title, TITLE_LIMIT);
    const label = chat.escape(title, "notice") || texts.STATUS_CHANNEL_SESSION;
    const linked = await talk.noticeLink({ channel, thread }, label);
    let status: SessionStatus;
    let activity: string;
    // How long the session has rested: said of one at rest alone.
    let since = "";
    if (live?.waitingForOwner) {
      status = "waiting";
      activity = texts.STATUS_CHANNEL_WAITING;
    } else if (live?.busy || live?.runningKinds) {
      // A session with only a background task running is not at rest either.
      status = "working";
      activity = texts.STATUS_CHANNEL_BUSY;
    } else {
      // At rest, live or closed, the row says how its last turn ended, as the root's mark does.
      status = outcome(stored.status) ?? outcome(stored.ended) ?? "done";
      if (info?.lastModified) {
        // In milliseconds, and by now the time of the session's last message (dated below).
        since = fill(texts.STATUS_CHANNEL_SINCE, {
          ago: ago(deps.now() - info.lastModified / 1000),
        });
      }
      activity = texts.STATUS_CHANNEL_IDLE + since;
    }
    const mark = chat.capabilities.reactions ? chat.statusMark?.(status) : undefined;
    let line =
      mark === undefined
        ? fill(texts.STATUS_CHANNEL_ROW, { link: linked, activity })
        : fill(texts.STATUS_CHANNEL_MARKED_ROW, { mark, link: linked, since });
    if (live?.runningKinds) {
      line += ` · ${fill(texts.RUNNING, { counts: live.runningKinds })}`;
    }
    if (live === null ? stored.bypass === true : live.bypass) line += texts.STATUS_CHANNEL_BYPASS;
    const directory = live?.directory ?? stored.directory;
    if (directory !== channelDirectory) {
      line += fill(texts.STATUS_CHANNEL_FOLDER, { directory });
    }
    return line;
  }

  /**
   * The title and the time of the last message of each session `threads` hold, by session id.
   * Dated by the session's last message, not by its file: Claude Code writes entries with no
   * timestamp to a transcript when it connects the session again, so a session idle for 16
   * minutes read `just now` (seen 2026-10-07). A folder that cannot be listed is logged and its
   * sessions shown untitled.
   */
  async function listed(
    threads: readonly (readonly [string, ThreadState])[],
  ): Promise<Map<string, ListedSession>> {
    const known = new Map<string, ListedSession>();
    const byDirectory = new Map<string, Set<string>>();
    for (const [, stored] of threads) {
      if (stored.sessionId === null) continue;
      const ids = byDirectory.get(stored.directory) ?? new Set<string>();
      ids.add(stored.sessionId);
      byDirectory.set(stored.directory, ids);
    }
    for (const [directory, ids] of byDirectory) {
      try {
        const found = await sessions.sessionsIn(directory);
        const dated = await sessions.dated(
          directory,
          found.filter((session) => ids.has(session.id)),
        );
        for (const session of dated) known.set(session.id, session);
      } catch (error) {
        if (isCancelled(error)) throw error;
        logger.warning(`could not list a folder's sessions: ${errorName(error)}`);
      }
    }
    return known;
  }

  return async (channel) => {
    const record = state.channel(channel);
    if (record === null) {
      await talk.unbound(channel);
      return;
    }
    const lines = [fill(texts.STATUS_CHANNEL_HEADER, { directory: record.directory })];
    const live = new Map(
      sessions.sessionsOf(channel).map((session) => [session.threadId, session]),
    );
    // Every thread that holds a session, as the session index lists them, and a live one whose
    // session has no id yet (its setup is still open): a restart closes every session, and an
    // answer of live ones alone was empty right after one (the owner, 2026-10-19).
    const threads = state
      .threads()
      .filter(
        ([id, thread, stored]) => id === channel && (stored.sessionId !== null || live.has(thread)),
      )
      .map(([, thread, stored]) => [thread, stored] as const);
    if (threads.length === 0) {
      lines.push(texts.STATUS_CHANNEL_EMPTY);
    } else {
      const known = await listed(threads);
      const all: Shown[] = threads.map(([thread, stored]) => {
        const info = stored.sessionId === null ? undefined : known.get(stored.sessionId);
        const opened = chat.openedAt({ channel, thread }) ?? 0;
        return {
          thread,
          stored,
          live: live.get(thread) ?? null,
          info,
          when: info?.lastModified ? info.lastModified / 1000 : opened,
        };
      });
      all.sort((a, b) => b.when - a.when);
      const shown = all.slice(0, STATUS_ROWS);
      lines.push(...(await Promise.all(shown.map((s) => row(channel, record.directory, s)))));
      if (all.length > shown.length) {
        lines.push(fill(texts.STATUS_CHANNEL_MORE, { count: all.length - shown.length }));
      }
    }
    await talk.inChannel(channel, lines.join("\n"));
    const waits = await talk.restartWaits(channel);
    if (waits) {
      await talk.inChannel(channel, [texts.RESTART_WAITS_HEADER, waits].join("\n"));
    }
  };
}
