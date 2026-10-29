/**
 * `!rewind`: go back to an earlier prompt of a session, as the terminal's `/rewind` lets you. The
 * core decides what is listed and what each action does; the chat draws the lists
 * (`ThreadChat.offer`) and folds the messages of the replies that were gone back over
 * (`ThreadChat.fold`).
 *
 * A pick carries the session and the prompt and nothing else: the agent's prompts are read again
 * when it is used, so a list never holds the conversation, and a prompt the session no longer
 * holds is told. Restoring the code goes first and on the live session (the checkpoints are its
 * own); cutting the conversation closes the agent and starts it again with the cut, so nothing may
 * run. The terminal's two Summarize actions are not offered: no agent seam member compacts part of
 * a conversation.
 */
import type { RewindPoint } from "../../agent/seam.ts";
import type { ListPick, ThreadRef } from "../../chat/seam.ts";
import type { ThreadSession } from "../sessions/session.ts";
import * as texts from "../texts.ts";
import { fill, named } from "../texts.ts";
import type { RewindFlow } from "./contract.ts";
import type { FlowDeps, Talk } from "./talk.ts";
import { logger } from "./talk.ts";

type Picked = Extract<ListPick, { type: "rewind-point" | "rewind-action" }>;

/** What restoring the files at a prompt changes, as the list and the line that tells it say it. */
interface FileCounts {
  readonly count: number;
  readonly insertions: number;
  readonly deletions: number;
}

export function rewindFlow(deps: FlowDeps, talk: Talk): RewindFlow {
  const { agent, chat, sessions, state, names } = deps;
  const capabilities = agent.capabilities;

  /** The thread's members `!rewind` needs, or null when the chat lacks the lists. */
  function chatOf(ref: ThreadRef) {
    const thread = talk.thread(ref);
    const { offer } = thread;
    if (offer === undefined) return null;
    return { offer: offer.bind(thread), rewrite: thread.rewrite.bind(thread), thread };
  }

  /** The session's prompts, oldest first. */
  async function promptsOf(directory: string, sessionId: string): Promise<readonly RewindPoint[]> {
    if (agent.prompts === undefined) return [];
    return agent.prompts(directory, sessionId);
  }

  /** What restoring the files at `promptId` changes; null when nothing would change or cannot. */
  async function previewOf(session: ThreadSession, promptId: string): Promise<FileCounts | null> {
    if (!capabilities.fileRestore) return null;
    try {
      const preview = await session.restoreFiles(promptId, true);
      if (!preview.possible || preview.files.length === 0) return null;
      return {
        count: preview.files.length,
        insertions: preview.insertions,
        deletions: preview.deletions,
      };
    } catch (error) {
      // No code action is offered where the agent could not say; the conversation still is.
      logger.warning(`could not preview a restore of the files: ${(error as Error).name}`);
      return null;
    }
  }

  /** Draws the actions at `point`, in place of the list of prompts `replacing`. */
  async function drawActions(
    ref: ThreadRef,
    session: ThreadSession,
    sessionId: string,
    point: RewindPoint,
    replacing: string,
  ): Promise<void> {
    const thread = chatOf(ref);
    if (thread === null) return;
    const files = await previewOf(session, point.id);
    const conversation = capabilities.conversationRewind && point.conversation;
    if (files === null && !conversation) {
      await thread.rewrite(replacing, texts.REWIND_NOTHING);
      return;
    }
    await thread.offer(
      {
        type: "rewind-actions",
        session: sessionId,
        point: { id: point.id, text: point.text },
        files,
        conversation,
      },
      texts.REWIND_ACTIONS_TITLE,
      replacing,
    );
  }

  const filesWord = (count: number): string =>
    count === 1 ? texts.REWIND_FILE : texts.REWIND_FILES;

  /** Restores the files at `point`; the line that tells it, or null when it failed (told). */
  async function restoreCode(
    ref: ThreadRef,
    session: ThreadSession,
    point: RewindPoint,
  ): Promise<boolean> {
    const preview = await session.restoreFiles(point.id, true);
    if (!preview.possible) {
      const reason = preview.reason ?? "";
      await talk.tell(ref, fill(named(texts.REWIND_CODE_FAILED, names), { reason }));
      return false;
    }
    // A turn may have started while the preview ran: restoring files under it would change what
    // it works on.
    if (session.inUse) {
      await talk.tell(ref, texts.REWIND_BUSY);
      return false;
    }
    const real = await session.restoreFiles(point.id, false);
    if (!real.possible) {
      const reason = real.reason ?? "";
      await talk.tell(ref, fill(named(texts.REWIND_CODE_FAILED, names), { reason }));
      return false;
    }
    const count = preview.files.length;
    let line = fill(texts.REWIND_CODE_DONE, {
      count,
      files: filesWord(count),
      insertions: preview.insertions,
      deletions: preview.deletions,
    });
    if (real.skipped > 0) {
      line += fill(texts.REWIND_CODE_SKIPPED, {
        skipped: real.skipped,
        files: filesWord(real.skipped),
      });
    }
    await talk.tell(ref, line, { stays: true });
    return true;
  }

  /** Cuts the conversation at `point`, folds the replies after it and posts the prompt again. */
  async function cutConversation(
    ref: ThreadRef,
    session: ThreadSession,
    point: RewindPoint,
    dropped: readonly string[],
    restored: boolean,
  ): Promise<boolean> {
    const result = await session.rewindConversation(point.id, dropped);
    if (result.outcome === "busy") {
      await talk.tell(ref, restored ? texts.REWIND_BUSY_AFTER_CODE : texts.REWIND_BUSY);
      return false;
    }
    if (result.outcome === "refused") {
      const text = restored ? texts.REWIND_REFUSED_AFTER_CODE : texts.REWIND_REFUSED;
      await talk.tell(ref, named(text, names));
      return false;
    }
    const chatThread = talk.thread(ref);
    if (chatThread.fold === undefined) {
      await talk.tell(ref, named(texts.REWIND_NO_FOLD, names), { stays: true });
    } else if (result.replies.length > 0) {
      let failed = 0;
      for (const message of result.replies) {
        // Each in turn: a fold is one read and one rewrite against the chat's budget.
        if (!(await chatThread.fold(message, texts.REWOUND_TITLE))) failed += 1;
      }
      if (failed > 0) {
        const line = fill(named(texts.REWIND_NOT_MARKED, names), { count: failed });
        await talk.tell(ref, line, { stays: true });
      }
    } else if (!result.known) {
      await talk.tell(ref, texts.REWIND_UNKNOWN_REPLIES, { stays: true });
    }
    // The composer cannot be filled for the owner: the prompt is posted for him to copy.
    await talk.say(ref.channel, ref.thread, chat.escape(point.text, "words"));
    await talk.tell(ref, named(texts.REWIND_CONVERSATION_DONE, names), { stays: true });
    return true;
  }

  /** The prompts a `!rewind` may go back to: those before a cut that waits for a prompt. */
  function reachable(
    points: readonly RewindPoint[],
    session: ThreadSession,
  ): readonly RewindPoint[] {
    // The file holds the dropped prompts until a prompt is written after the cut, and the agent
    // would take them back into the conversation if listed here.
    const cut = points.findIndex((point) => point.id === session.pendingCut);
    return cut === -1 ? points : points.slice(0, cut);
  }

  // The threads an action runs in, and the lists whose action ran: a second click on the same
  // control, or on a list already used, does not run it again.
  const running = new Set<string>();
  const finished = new Set<string>();
  const FINISHED_KEPT = 50;

  async function picked(pick: Picked): Promise<void> {
    const { ref } = pick;
    const stored = state.thread(ref.channel, ref.thread);
    // A list made for a session the thread no longer holds (a `!stop` and a new start can replace
    // it) names prompts of another conversation.
    if (stored === null || stored.sessionId !== pick.session) {
      await talk.tell(ref, texts.REWIND_STALE);
      return;
    }
    const thread = chatOf(ref);
    const session = sessions.get(ref.channel, ref.thread);
    if (thread === null || session === null) {
      await talk.tell(ref, named(texts.REWIND_UNAVAILABLE, names));
      return;
    }
    if (pick.type === "rewind-action" && pick.action === "cancel") {
      await thread.rewrite(pick.list, texts.REWIND_CANCELLED);
      return;
    }
    const key = `${ref.channel}\n${ref.thread}`;
    const acting = pick.type === "rewind-action";
    if (acting) {
      // (sync) Before the first await: the second click of a double click comes in here.
      if (finished.has(pick.list)) {
        await talk.tell(ref, texts.REWIND_ALREADY);
        return;
      }
      if (running.has(key)) {
        await talk.tell(ref, texts.REWIND_UNDER_WAY);
        return;
      }
      running.add(key);
    }
    try {
      await act(pick, stored.directory, thread, session);
    } finally {
      if (acting) running.delete(key);
    }
  }

  async function act(
    pick: Picked,
    directory: string,
    thread: NonNullable<ReturnType<typeof chatOf>>,
    session: ThreadSession,
  ): Promise<void> {
    const { ref } = pick;
    if (session.inUse) {
      await talk.tell(ref, texts.REWIND_BUSY);
      return;
    }
    await talk.replyOnFailure(ref, async () => {
      // The id comes back from the chat: only a prompt the agent lists now is acted on.
      const all = await promptsOf(directory, pick.session);
      const points = reachable(all, session);
      const point = points.find((candidate) => candidate.id === pick.promptId);
      if (point === undefined) {
        await talk.tell(ref, texts.REWIND_POINT_GONE);
        return;
      }
      if (pick.type === "rewind-point") {
        await drawActions(ref, session, pick.session, point, pick.list);
        return;
      }
      const { action } = pick;
      let restored = false;
      if (action === "code" || action === "both") {
        if (!capabilities.fileRestore) return;
        if (!(await restoreCode(ref, session, point))) {
          await thread.rewrite(pick.list, texts.REWIND_DONE);
          return;
        }
        restored = true;
      }
      if (action === "conversation" || action === "both") {
        if (!capabilities.conversationRewind || !point.conversation) {
          await talk.tell(ref, texts.REWIND_NOTHING);
        } else if (
          !(await cutConversation(
            ref,
            session,
            point,
            all.slice(all.indexOf(point)).map((dropped) => dropped.id),
            restored,
          )) &&
          !restored
        ) {
          // Nothing was done: the list stays, to be used when nothing runs.
          return;
        }
      }
      await thread.rewrite(pick.list, texts.REWIND_DONE);
      finished.add(pick.list);
      if (finished.size > FINISHED_KEPT) {
        for (const old of finished) {
          finished.delete(old);
          break;
        }
      }
    });
  }

  return {
    async word(ref, session) {
      if (chatOf(ref) === null || agent.prompts === undefined) {
        await talk.tell(ref, named(texts.REWIND_UNAVAILABLE, names));
        return;
      }
      const sessionId = state.thread(ref.channel, ref.thread)?.sessionId;
      if (sessionId === null || sessionId === undefined) {
        await talk.tell(ref, texts.REWIND_NOT_STARTED);
        return;
      }
      if (session.inUse) {
        await talk.tell(ref, texts.REWIND_BUSY);
        return;
      }
      await talk.replyOnFailure(ref, async () => {
        const points = reachable(await promptsOf(session.directory, sessionId), session);
        if (points.length === 0) {
          await talk.tell(ref, texts.REWIND_NONE);
          return;
        }
        // Newest first, as the terminal lists them.
        const rows = points.map(({ id, text }) => ({ id, text })).reverse();
        await chatOf(ref)?.offer(
          { type: "rewind-points", session: sessionId, points: rows },
          texts.REWIND_TITLE,
        );
      });
    },

    picked,
  };
}
