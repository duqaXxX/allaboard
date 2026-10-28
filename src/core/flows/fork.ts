/**
 * `!fork`: a copy of a thread's session in a new thread of the same channel, as the terminal's
 * `/fork` copies a session into a new one while the original goes on.
 */
import type { ThreadRef } from "../../chat/seam.ts";
import { systemClock } from "../../clock.ts";
import { getLogger } from "../../log.ts";
import { errorName } from "../../values.ts";
import { oneLine, TITLE_LIMIT } from "../reply/words.ts";
import { SessionGone } from "../sessions/errors.ts";
import type { ThreadSession } from "../sessions/session.ts";
import * as texts from "../texts.ts";
import { fill, named } from "../texts.ts";
import type { ForkFlow } from "./contract.ts";
import type { FlowDeps, Talk } from "./talk.ts";

const logger = getLogger("allaboard.core.flows.fork");

// How often a running turn is looked at while a fork waits for its end, as a message waits for a
// terminal's turn (`TERMINAL_POLL_SECONDS`).
export const FORK_POLL_SECONDS = 2.0;

/** Sends `prompt` in the thread `ref` as the owner's, by the path every message of theirs takes. */
export type SendPrompt = (ref: ThreadRef, prompt: string) => Promise<void>;

export function forkFlow(deps: FlowDeps, talk: Talk, send: SendPrompt): ForkFlow {
  const { agent, chat, sessions, state, names } = deps;
  const clock = deps.clock ?? systemClock;

  /** The agent's title for a session, or an empty one when it has none or cannot say. */
  async function titleOf(directory: string, id: string): Promise<string> {
    if (!agent.capabilities.sessionTitles || agent.sessionTitle === undefined) return "";
    try {
      return oneLine((await agent.sessionTitle(directory, id)) ?? "", TITLE_LIMIT);
    } catch (error) {
      logger.warning(`could not read the title of a session: ${errorName(error)}`);
      return "";
    }
  }

  return {
    async word(ref, message, session, prompt) {
      const fork = agent.forkSession;
      const channelChat = chat.channel(ref.channel);
      if (
        !agent.capabilities.sessionForks ||
        fork === undefined ||
        !chat.capabilities.threadOpen ||
        channelChat.open === undefined
      ) {
        await talk.tell(ref, named(texts.FORK_UNAVAILABLE, names));
        return;
      }
      if (state.thread(ref.channel, ref.thread)?.sessionId == null) {
        await talk.tell(ref, texts.FORK_NOT_STARTED);
        return;
      }
      // As the terminal queues a command sent during a reply: the copy is made once the turn has
      // ended, so that it holds the whole conversation and no tool call cut in the middle. The
      // thread's session is looked up on every round: a stop and a new message can replace it.
      const live = (): ThreadSession | null => sessions.get(ref.channel, ref.thread);
      if (session.busy) {
        await talk.acknowledge(ref, message);
        while ((live()?.busy ?? false) && !talk.stopped) {
          await clock.sleep(FORK_POLL_SECONDS, deps.stopped).catch(() => {});
        }
        if (talk.stopped) return;
      }
      // Read again: the wait may have outlasted the thread's entry, or a restart begun.
      const origin = state.thread(ref.channel, ref.thread);
      if (origin?.sessionId == null) throw new SessionGone(names);
      if (sessions.draining) {
        await talk.refuseRestarting(ref);
        return;
      }
      // The copy's thread is opened in the channel's folder, as every new thread is.
      if (state.channel(ref.channel)?.directory !== origin.directory) {
        await talk.tell(ref, texts.FORK_OLD_FOLDER);
        return;
      }
      const line = oneLine(prompt, TITLE_LIMIT);
      const copy = await fork.call(agent, session.directory, origin.sessionId, line || null);
      const back = await talk.referenceLink(
        ref,
        await titleOf(session.directory, origin.sessionId),
      );
      const root =
        prompt === ""
          ? fill(texts.FORK_ROOT, { link: back })
          : fill(texts.FORK_ROOT_PROMPT, {
              link: back,
              prompt: chat.escape(line, "reference"),
            });
      let opened: ThreadRef;
      try {
        opened = await channelChat.open.call(channelChat, root);
      } catch (error) {
        // The copy stays with the agent, which lists it (`!resume` finds it).
        logger.warning(
          `a fork's thread could not be opened, its copy ${copy} kept: ${errorName(error)}`,
        );
        throw error;
      }
      // The copy runs as its origin does: the effort and the bypass the origin's entry holds, and
      // the model its transcript ends on (a resume of a copy runs it, measured 2026-10-28).
      if ((await sessions.resume(opened.channel, opened.thread, copy)) === null) {
        throw new SessionGone(names);
      }
      state.setEffort(opened.channel, opened.thread, origin.effort);
      state.setBypass(opened.channel, opened.thread, origin.bypass);
      const label =
        chat.escape(line || (await titleOf(session.directory, copy)), "notice") ||
        texts.FORK_COPY_LABEL;
      await talk.thread(ref).notice(
        fill(prompt === "" ? texts.FORK_WAITING : texts.FORK_RUNNING, {
          link: await talk.noticeLink(opened, label),
          session: copy,
        }),
      );
      if (prompt !== "") await send(opened, prompt);
    },
  };
}
