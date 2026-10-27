/**
 * A session open in a terminal on the host. Two processes on one session do not see each
 * other's messages, and the second to write branches the conversation (measured 2026-10-27), so
 * the owner writes from one side at a time. Before his message reaches the session: a terminal
 * that runs a turn is waited out, a terminal left open is named once and he chooses to send here
 * or not, and the turns written there since this thread's last message are shown, one message
 * each, before the reply.
 */
import type { SessionHolder } from "../../agent/seam.ts";
import type { TerminalRequest, ThreadRef } from "../../chat/seam.ts";
import { systemClock } from "../../clock.ts";
import { shellQuote } from "../../text.ts";
import { commandShown } from "../sessions/directory.ts";
import type { ThreadSession } from "../sessions/session.ts";
import * as texts from "../texts.ts";
import { fill, named } from "../texts.ts";
import { askOwner } from "./ask-owner.ts";
import type { TerminalFlow } from "./contract.ts";
import { type FlowDeps, logger, type Talk } from "./talk.ts";

// How often a terminal's running turn is looked at while a message waits for its end: the list
// answers in about 0.1 s (measured 2026-10-27).
export const TERMINAL_POLL_SECONDS = 2.0;

export function terminalFlow(deps: FlowDeps, talk: Talk): TerminalFlow {
  const { agent, chat } = deps;
  const clock = deps.clock ?? systemClock;

  function sessionIdOf(session: ThreadSession): string | null {
    return deps.state.thread(session.channelId, session.threadId)?.sessionId ?? null;
  }

  /**
   * The terminals that hold the session now; empty with none, null when the agent could not
   * tell (logged: the message then goes on, as with an agent that cannot list them).
   */
  async function terminals(session: ThreadSession): Promise<readonly SessionHolder[] | null> {
    const id = sessionIdOf(session);
    if (id === null || !agent.capabilities.sessionHolders || agent.sessionHolders === undefined) {
      return [];
    }
    let found: readonly SessionHolder[] | null;
    try {
      found = await agent.sessionHolders(id);
    } catch {
      found = null;
    }
    if (found === null) {
      logger.warning(
        `could not tell who holds the session of ${session.channelId}/${session.threadId}`,
      );
      return null;
    }
    return found.filter((holder) => !holder.own);
  }

  function request(
    requestId: string,
    state: TerminalRequest["state"],
    command: string | null,
  ): TerminalRequest {
    return { type: "terminal", requestId, state, running: null, command };
  }

  /**
   * Wait for the end of the turn a terminal runs, the question showing it with a Cancel; true
   * once it ended, false when the owner cancelled (or a `!stop`, a drain).
   */
  async function waitForTurn(ref: ThreadRef, session: ThreadSession): Promise<boolean> {
    let holdId: string | null = null;
    // Ends the looking as soon as the wait is over, whichever way: no look outlives it.
    const over = new AbortController();
    const watch = async (): Promise<void> => {
      while (!over.signal.aborted && !deps.stopped.aborted) {
        await clock.sleep(TERMINAL_POLL_SECONDS, over.signal);
        if (holdId === null) continue;
        // A list that could not be read says nothing of the turn: the wait goes on.
        const found = await terminals(session);
        if (found !== null && !found.some((holder) => holder.busy)) {
          deps.holds.resolve(holdId, ref.channel, ref.thread, true);
          return;
        }
      }
    };
    const watching = watch().catch(() => {});
    try {
      const answer = await askOwner(deps, talk, ref, session, {
        kind: "terminal",
        title: texts.TERMINAL_BUSY_TITLE,
        request: (requestId) => {
          holdId = requestId;
          return request(requestId, "busy", null);
        },
        ends: { sent: texts.TERMINAL_TURN_ENDED, cancelled: texts.NOT_SENT },
      });
      return answer !== null;
    } finally {
      over.abort();
      await watching;
    }
  }

  /** The line that opens the session in the terminal, as `!status` gives it, or `template`. */
  function commandLine(session: ThreadSession, template = agent.words.terminal): string {
    return fill(template, {
      directory: shellQuote(session.directory),
      session: sessionIdOf(session) ?? "",
    });
  }

  async function move(ref: ThreadRef, session: ThreadSession): Promise<void> {
    if (sessionIdOf(session) === null) {
      await talk.tell(ref, texts.TERMINAL_NOT_STARTED);
      return;
    }
    const shown = (command: string) => commandShown(command, (text) => chat.escape(text, "notice"));
    const continuing = agent.words.terminalContinue;
    if (session.busy && continuing === null) {
      await talk.tell(ref, fill(texts.TERMINAL_WAIT, { command: shown(commandLine(session)) }), {
        stays: true,
      });
      return;
    }
    const running = session.stillRunning;
    let asked = false;
    if (running !== "") {
      const answer = await askOwner(deps, talk, ref, session, {
        kind: "terminal",
        title: texts.TERMINAL_MOVE_TITLE,
        request: (requestId) => ({
          type: "terminal",
          requestId,
          state: "move",
          running,
          command: null,
        }),
        ends: { sent: texts.TERMINAL_MOVED, cancelled: texts.TERMINAL_NOT_MOVED },
      });
      if (answer === null) return;
      asked = true;
    }
    const how = await session.moveToTerminal();
    // A confirmed move left the waiting mark for a submit that never comes.
    if (asked) await session.reactHoldAbandoned({ error: false });
    const text =
      how === "cut" && continuing !== null
        ? fill(named(texts.TERMINAL_CUT, deps.names), {
            command: shown(commandLine(session, continuing)),
          })
        : fill(texts.TERMINAL_IDLE, { command: shown(commandLine(session)) });
    await talk.tell(ref, text, { stays: true });
  }

  /** One terminal turn as the thread shows it: the owner's prompt, then the final reply. */
  function turnText(prompt: string, reply: string | null): string {
    const shown = { prompt: chat.escape(prompt, "written") };
    if (reply === null) return fill(texts.TERMINAL_TURN_UNANSWERED, shown);
    return fill(texts.TERMINAL_TURN, { ...shown, reply: chat.escape(reply, "written") });
  }

  async function beforeSending(ref: ThreadRef, session: ThreadSession): Promise<boolean> {
    for (;;) {
      if (talk.stopped) return false;
      const found = await terminals(session);
      if (found === null || found.length === 0) break;
      if (found.some((holder) => holder.busy)) {
        if (!(await waitForTurn(ref, session))) return false;
        continue;
      }
      if (found.every((holder) => session.terminalsAllowed.has(holder.id))) break;
      const command = commandLine(session);
      const answer = await askOwner(deps, talk, ref, session, {
        kind: "terminal",
        title: texts.TERMINAL_OPEN_TITLE,
        request: (requestId) => request(requestId, "open", command),
        ends: { sent: texts.TERMINAL_SENT, cancelled: texts.NOT_SENT },
      });
      if (answer === null) return false;
      for (const holder of found) session.terminalsAllowed.add(holder.id);
      break;
    }
    for (const turn of await session.takeForeignTurns()) {
      await talk.say(ref.channel, ref.thread, turnText(turn.prompt, turn.reply));
    }
    return true;
  }

  return { beforeSending, move };
}
