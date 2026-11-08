/**
 * The same-folder hold: before a message wakes an idle session while a live session of another
 * thread is busy in the same folder, the owner is asked whether to send it anyway.
 */
import type { HoldRequest, ThreadRef } from "../../chat/seam.ts";
import { errorName } from "../../values.ts";
import { oneLine, TITLE_LIMIT } from "../reply/words.ts";
import type { ThreadSession } from "../sessions/session.ts";
import * as texts from "../texts.ts";
import { fill } from "../texts.ts";
import { askOwner } from "./ask-owner.ts";
import type { HoldFlow } from "./contract.ts";
import { type FlowDeps, isCancelled, logger, type Talk } from "./talk.ts";

export function holdFlow(deps: FlowDeps, talk: Talk): HoldFlow {
  /**
   * The title of the session at work, as the agent lists it for its folder; empty when it has
   * none yet, the agent lists none, or the list cannot be read.
   */
  async function titleOf(other: ThreadSession): Promise<string> {
    const id = deps.state.thread(other.channelId, other.threadId)?.sessionId ?? null;
    if (id === null) return "";
    try {
      const listed = await deps.sessions.sessionsIn(other.directory);
      return listed.find((session) => session.id === id)?.title ?? "";
    } catch (error) {
      if (isCancelled(error)) throw error;
      logger.warning(`could not list a folder's sessions for a hold: ${errorName(error)}`);
      return "";
    }
  }

  /**
   * Post `Another session is working in this folder: <link>. Send anyway?` and wait for the
   * owner's answer, cancelled the same way by `!stop` (in this thread or the whole channel) or
   * a drain. True to send the message on; false when it was not, either way telling the owner
   * `Not sent.` already.
   */
  async function beforeSending(
    ref: ThreadRef,
    session: ThreadSession,
    other: ThreadSession,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const otherRef = { channel: other.channelId, thread: other.threadId };
    // Labelled with the busy session's title, as `!status` names it; `Session` while it has none.
    const title = oneLine(await titleOf(other), TITLE_LIMIT);
    const label = deps.chat.escape(title, "notice") || texts.STATUS_CHANNEL_SESSION;
    const link = await talk.noticeLink(otherRef, label);
    const answer = await askOwner(deps, talk, ref, session, {
      kind: "hold",
      title: fill(texts.HOLD_QUESTION, { link }),
      signal,
      request: (requestId): HoldRequest => ({ type: "hold", requestId, other: otherRef, link }),
    });
    return answer === true;
  }

  return { beforeSending };
}
