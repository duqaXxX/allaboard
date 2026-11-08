/**
 * `!fork`: a copy of a thread's session in a new thread of the same channel, as the terminal's
 * `/fork` copies a session into a new one while the original goes on.
 */
import type { ThreadRef } from "../../chat/seam.ts";
import { systemClock } from "../../clock.ts";
import { getLogger } from "../../log.ts";
import { errorName } from "../../values.ts";
import { oneLine, quoted, spaced, TITLE_LIMIT } from "../reply/words.ts";
import { SessionGone } from "../sessions/errors.ts";
import type { ThreadSession } from "../sessions/session.ts";
import * as texts from "../texts.ts";
import { fill, named } from "../texts.ts";
import type { ForkFlow } from "./contract.ts";
import type { InFlight, Ticket } from "./in-flight.ts";
import type { FlowDeps, Talk } from "./talk.ts";

const logger = getLogger("allaboard.core.flows.fork");

// How often a running turn is looked at while a fork waits for its end, as a message waits for a
// terminal's turn (`TERMINAL_POLL_SECONDS`).
export const FORK_POLL_SECONDS = 2.0;

// How much of the original's last turn a copy's thread shows, prompt and reply each, in
// characters: the product's own cut, enough to recognise where the conversation stood.
export const FORK_LAST_TURN_LIMIT = 300;

/** Sends `prompt` in the thread `ref` as the owner's, by the path every message of theirs takes. */
export type SendPrompt = (ref: ThreadRef, prompt: string, ticket: Ticket) => Promise<void>;

export function forkFlow(
  deps: FlowDeps,
  talk: Talk,
  send: SendPrompt,
  inFlight: InFlight,
): ForkFlow {
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

  /**
   * The original's last turn, read from the copy and first in its thread, cut short; nothing when
   * the agent cannot read it or there is no turn. Never fails the fork.
   */
  async function showLastTurn(opened: ThreadRef, directory: string, id: string): Promise<void> {
    if (!agent.capabilities.foreignTurns || agent.lastTurn === undefined) return;
    try {
      const turn = await agent.lastTurn(directory, id);
      if (turn === null) return;
      const parts: string[] = [];
      if (turn.prompt !== null) {
        // The owner's words as a quote, every line of it.
        parts.push(quoted(chat.escape(oneLine(turn.prompt, FORK_LAST_TURN_LIMIT), "written")));
      }
      if (turn.reply !== null) {
        const more = Array.from(spaced(turn.reply)).length > FORK_LAST_TURN_LIMIT;
        const reply =
          oneLine(turn.reply, FORK_LAST_TURN_LIMIT) + (more ? texts.FORK_LAST_TURN_MORE : "");
        parts.push(chat.escape(reply, "written"));
      }
      if (turn.interrupted) parts.push(texts.FORK_LAST_TURN_STOPPED);
      if (parts.length === 0) return;
      await talk.say(
        opened.channel,
        opened.thread,
        fill(texts.FORK_LAST_TURN, { turn: parts.join("\n\n") }),
      );
    } catch (error) {
      logger.warning(`could not show the last turn of a fork's original: ${errorName(error)}`);
    }
  }

  return {
    async word(ref, message, session, prompt, ticket) {
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
        // A stop of this thread ends the wait as a daemon stop does.
        const ends = AbortSignal.any([deps.stopped, ticket.signal]);
        while ((live()?.busy ?? false) && !talk.stopped && !ends.aborted) {
          await clock.sleep(FORK_POLL_SECONDS, ends).catch(() => {});
        }
        if (talk.stopped) return;
      }
      if (ticket.signal.aborted) {
        await talk.tell(ref, texts.NOT_SENT);
        return;
      }
      // Past this point the copy is made, and a stop of the original thread no longer counts it.
      // A stop of the channel still does, until the prompt is sent: the bridge (only when there is
      // a prompt) is taken before the original's ticket is given up, and the copy's ticket, once
      // its thread exists, follows it. Whatever ends the fork releases both.
      const bridge = prompt === "" ? null : inFlight.take(ref, { channelOnly: true });
      ticket.release();
      let copyTicket: Ticket | null = null;
      let sending = false;
      try {
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
        const at = new Date(deps.now() * 1000).toISOString();
        const copy = await fork.call(agent, session.directory, origin.sessionId, line || null);
        const back = await talk.referenceLink(
          ref,
          (await titleOf(session.directory, origin.sessionId)) || texts.FORK_ORIGINAL_LABEL,
        );
        // What a later title keeps in front of itself on the root (`ChannelChat.open`).
        const lead = fill(texts.FORK_ROOT, { link: back });
        const root =
          prompt === ""
            ? lead
            : fill(texts.FORK_ROOT_PROMPT, {
                link: back,
                prompt: chat.escape(line, "reference"),
              });
        let opened: ThreadRef;
        try {
          opened = await channelChat.open.call(channelChat, root, { lead, words: line });
        } catch (error) {
          // The copy stays with the agent, which lists it (`!resume` finds it).
          logger.warning(
            `a fork's thread could not be opened, its copy ${copy} kept: ${errorName(error)}`,
          );
          throw error;
        }
        // The copy is read, not the original: it holds exactly what was copied, while the original
        // may have moved on since.
        await showLastTurn(opened, session.directory, copy);
        if (bridge !== null) copyTicket = inFlight.take(opened, { link: bridge.signal });
        // The copy runs as its origin does: the effort and the bypass the origin's entry holds, and
        // the model its transcript ends on (a resume of a copy runs it, measured 2026-10-28).
        const copied = await sessions.resume(opened.channel, opened.thread, copy);
        if (copied === null) throw new SessionGone(names);
        state.setEffort(opened.channel, opened.thread, origin.effort);
        state.setBypass(opened.channel, opened.thread, origin.bypass);
        // What it is a copy of, for every start of it: the agent then takes no background work of
        // the original's for its own.
        // A bare copy runs no process until its first message: the first prompt with text names it
        // (`ThreadSession`'s worker), and its root shows no status before a turn.
        state.setForkOf(
          opened.channel,
          opened.thread,
          { session: origin.sessionId, at },
          prompt === "",
        );
        const label =
          chat.escape(line || (await titleOf(session.directory, copy)), "notice") ||
          texts.FORK_COPY_LABEL;
        // A line that stays in the thread, in a notice's markup: a notice of the session's own is
        // plain text, which would show the link's markup as written.
        const said =
          prompt === "" || copyTicket?.signal.aborted ? texts.FORK_WAITING : texts.FORK_RUNNING;
        const link = await talk.noticeLink(opened, label);
        await talk.tell(ref, fill(said, { link, session: copy }), { stays: true });
        // With a prompt the copy starts at once, once the line above is there: a start that fails
        // is told with the link to the copy's thread already given. A bare copy starts with its
        // first message, as a thread does after a restart, so that its name can be set first.
        if (copyTicket !== null) {
          sending = true;
          await send(opened, prompt, copyTicket);
        }
      } finally {
        copyTicket?.release();
        const stopped = (copyTicket ?? bridge)?.signal.aborted === true;
        bridge?.release();
        // A prompt a stop dropped before it was sent is told here; once sent, the copy's thread
        // tells it. A failed post never replaces the error that ended the fork.
        if (stopped && !sending && !talk.stopped) {
          try {
            await talk.tell(ref, texts.NOT_SENT);
          } catch (error) {
            logger.warning(`could not tell a dropped fork prompt: ${errorName(error)}`);
          }
        }
      }
    },
  };
}
