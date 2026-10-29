/**
 * A word of the daemon's own: what each does, and where it is answered. Typed in the channel (or
 * in a thread that holds no session) it is answered by a normal post in the channel; typed
 * inside a session's thread it is answered for the owner alone under the owner's message, or by
 * a mark on it, so nothing rings a phone; `!stop` is answered by a post that stays in the
 * thread, and `!open` shows its files there.
 */
import { ChatError, type MessageId, type ThreadRef } from "../../chat/seam.ts";
import { errorName } from "../../values.ts";
import { helpText, type Shell, WORD, type Word } from "../commands.ts";
import { guideText } from "../guide.ts";
import { memoryText, skillsText } from "../loaded.ts";
import { oneLine, TITLE_LIMIT } from "../reply/words.ts";
import { BypassUnavailable, PlanUnavailable } from "../sessions/errors.ts";
import type { ThreadSession } from "../sessions/session.ts";
import * as texts from "../texts.ts";
import { fill, named } from "../texts.ts";
import type { ForkFlow, OtherFlows } from "./contract.ts";
import { channelStatus } from "./status.ts";
import { type FlowDeps, logger, type Talk } from "./talk.ts";

/** Where a word was typed. */
export interface WordPlace {
  /** The live session of the thread it was typed in; null in the channel, or in a thread with none. */
  readonly session: ThreadSession | null;
  /**
   * A thread that holds no session: a word typed there reads as being about that thread, so
   * the ones that act on the whole channel (`!stop`, `!resume`, `!bind` with a folder) say where
   * to send them, for the owner alone, and change nothing.
   */
  readonly outside: boolean;
}

/**
 * The answer to a `!stop` that stopped something: with the goal the session still has, which
 * the stop leaves set and the next message resumes, as the terminal's Esc does (measured
 * 2026-10-20, Claude Code 2.1.303).
 */
function stoppedText(goal: string | null, deps: FlowDeps): string {
  if (goal === null) return texts.STOPPED_THREAD;
  // The owner's own words: a mention or a mark in them must not act in the notice.
  const condition = deps.chat.escape(oneLine(goal, TITLE_LIMIT), "notice");
  const clear = deps.agent.words.goalClear;
  const line =
    clear === null
      ? fill(texts.GOAL_STILL_ACTIVE, { condition })
      : fill(texts.GOAL_STILL_ACTIVE_CLEAR, { condition, clear });
  return `${texts.STOPPED_THREAD}\n${line}`;
}

/**
 * What a word does. `message` is the word's own message in the chat. A shell command is no word
 * of this flow: it waits in the thread's order, as a prompt does (`messages`).
 */
export type WordFlow = (
  ref: ThreadRef,
  message: MessageId,
  command: Exclude<Word, Shell>,
  place: WordPlace,
) => Promise<void>;

/**
 * The words this agent and this chat cannot serve: each is refused when typed, and neither
 * `!help` nor a suggestion offers it.
 */
export function unservedWords(deps: FlowDeps, others: OtherFlows): ReadonlySet<string> {
  const { chat, agent } = deps;
  const unserved = new Set<string>();
  if (agent.capabilities.permissionModes.bypass === null) unserved.add(WORD.bypass);
  if (agent.capabilities.permissionModes.plan === null) unserved.add(WORD.plan);
  if (!agent.capabilities.sessionListing) unserved.add(WORD.resume);
  if (!agent.capabilities.loadedContext) {
    unserved.add(WORD.memory);
    unserved.add(WORD.skills);
  }
  if (!agent.capabilities.sessionForks || !chat.capabilities.threadOpen) unserved.add(WORD.fork);
  if (!chat.capabilities.fileUpload) unserved.add(WORD.open);
  // The daemon's git runs only in a repository the agent's record of trust names.
  if (
    !chat.capabilities.fileUpload ||
    !chat.capabilities.threadLists ||
    !agent.capabilities.folderTrust
  ) {
    unserved.add(WORD.diff);
  }
  if (!chat.capabilities.threadTags) {
    unserved.add(WORD.tag);
    unserved.add(WORD.untag);
  }
  if (!chat.capabilities.threadDelete) unserved.add(WORD["delete-thread"]);
  if (!agent.capabilities.shellCommands || !deps.shellCommands) unserved.add(WORD.shell);
  // A daemon built without a way to update itself offers no `!allaboard`.
  if (others.allaboard === undefined) unserved.add(WORD.allaboard);
  return unserved;
}

export function wordFlow(deps: FlowDeps, talk: Talk, others: OtherFlows, fork: ForkFlow): WordFlow {
  const { chat, agent, sessions, state, names } = deps;
  const status = channelStatus(deps, talk);
  const unserved = unservedWords(deps, others);
  const allaboard = others.allaboard;

  /**
   * The agent's own tag for the session, once the chat shows the change. A thread whose session
   * has no id yet has nothing to tag, and an agent that declares no `sessionTags` keeps none; a
   * failure leaves the chat's change standing and is told to the owner alone.
   */
  async function mirrorTag(ref: ThreadRef, session: ThreadSession, tag: string | null) {
    if (!agent.capabilities.sessionTags || agent.tagSession === undefined) return;
    const id = state.thread(ref.channel, ref.thread)?.sessionId;
    if (id === null || id === undefined) return;
    try {
      await agent.tagSession(session.directory, id, tag);
    } catch (error) {
      logger.warning(
        `could not tag the agent's session of ${ref.channel}/${ref.thread}: ${errorName(error)}`,
      );
      await talk.tell(ref, named(texts.TAG_AGENT_FAILED, names));
    }
  }

  return async (ref, message, command, { session, outside }) => {
    const { channel, thread } = ref;
    const where = session === null ? null : thread;
    const quiet = session !== null;
    const showHelp = async (query: string): Promise<void> => {
      if (session !== null) await session.ensureConnected();
      const commands = session === null ? null : session.commands;
      await talk.say(
        channel,
        where,
        helpText(
          commands,
          query,
          (text) => chat.escape(text, "reference"),
          names,
          agent.capabilities.commands,
          unserved,
          agent.capabilities.folderTrust,
        ),
        { ownerOnly: quiet },
      );
    };
    switch (command.kind) {
      case "help":
        await showHelp(command.query);
        return;
      case "invalid":
        // A mistyped word gets the full list, which shows how each word is written.
        await showHelp("");
        return;
      case "guide": {
        const have = agent.capabilities;
        const offered = {
          folderTrust: have.folderTrust,
          models: have.models,
          efforts: have.effortLevels.length > 0,
          bypass: have.permissionModes.bypass !== null,
          plan: have.permissionModes.plan !== null,
          commands: have.commands,
          questions: have.questions,
          backgroundTasks: have.backgroundTasks,
          sessionListing: have.sessionListing,
          loadedContext: have.loadedContext,
          forks: !unserved.has(WORD.fork),
          fileUpload: chat.capabilities.fileUpload,
          diff: !unserved.has(WORD.diff),
          threadTags: chat.capabilities.threadTags,
          threadDelete: chat.capabilities.threadDelete,
          shell: have.shellCommands && deps.shellCommands,
          updates: allaboard !== undefined,
        };
        await talk.say(channel, where, guideText(names, offered), { ownerOnly: quiet });
        return;
      }
      case "bind":
        if (session !== null || (outside && command.path)) {
          await talk.tell(ref, fill(texts.WORD_IN_THREAD, { word: WORD.bind }));
        } else if (command.path) {
          await others.bind.to(channel, command.path);
        } else {
          await others.bind.list(channel);
        }
        return;
      case "bypass": {
        if (session === null) {
          await talk.inChannel(channel, texts.BYPASS_TOP_LEVEL);
          return;
        }
        let switched: boolean;
        try {
          switched = await session.switchBypass(command.on);
        } catch (error) {
          if (!(error instanceof BypassUnavailable)) throw error;
          await talk.tell(ref, named(texts.BYPASS_UNAVAILABLE, names));
          return;
        }
        if (!switched) {
          // Start writes the setup's box over the switch (`applySetup`): one flipped before
          // it would not hold, so the word changed nothing.
          await talk.tell(ref, texts.BYPASS_BEFORE_START);
        } else {
          // Both: the line says what changed and is gone on reload, the mark stays.
          await talk.acknowledge(ref, message);
          await talk.tell(
            ref,
            command.on ? texts.BYPASS_ON_THREAD : named(texts.BYPASS_OFF_THREAD, names),
          );
        }
        return;
      }
      case "plan": {
        if (command.on === null) {
          if (session === null) await talk.inChannel(channel, texts.PLAN_TAKES_NO_TEXT);
          else await talk.tell(ref, texts.PLAN_TAKES_NO_TEXT);
          return;
        }
        if (session === null) {
          await talk.inChannel(channel, texts.PLAN_TOP_LEVEL);
          return;
        }
        let switched: boolean;
        try {
          switched = await session.switchPlan(command.on);
        } catch (error) {
          if (!(error instanceof PlanUnavailable)) throw error;
          await talk.tell(ref, named(texts.PLAN_UNAVAILABLE, names));
          return;
        }
        if (!switched) {
          await talk.tell(ref, texts.PLAN_BEFORE_START);
        } else {
          await talk.acknowledge(ref, message);
          await talk.tell(
            ref,
            command.on ? named(texts.PLAN_ON_THREAD, names) : texts.PLAN_OFF_THREAD,
          );
        }
        return;
      }
      case "status":
        if (session === null) await status(channel);
        else await talk.say(channel, thread, await session.status(), { ownerOnly: true });
        return;
      case "stop":
        if (outside) {
          await talk.tell(ref, texts.STOP_OUTSIDE_SESSION);
        } else if (session === null) {
          const stopped = await sessions.stopChannel(channel);
          // null: only a hold was cancelled somewhere in the channel (`Not sent.`, from its
          // own waiter); no second notice, since nothing the agent was doing stopped.
          if (stopped !== null) {
            await talk.inChannel(channel, stopped ? texts.STOPPED_CHANNEL : texts.NOTHING_TO_STOP);
          }
        } else {
          // Either answer is a post that stays in the thread: a line for the owner alone is
          // gone on reload, and the root's mark alone does not say a stop was received. null:
          // only a hold was cancelled, which already said `Not sent.` from its own waiter.
          const stopped = await session.stop();
          if (stopped) {
            // The answer goes under the ending and the footer of the reply the stop cut
            // short, which may be a message of its own.
            await session.stopLanded();
          }
          if (stopped !== null) {
            await talk.tell(
              ref,
              stopped ? stoppedText(session.goal, deps) : texts.NOTHING_TO_STOP_THREAD,
              {
                stays: true,
              },
            );
          }
        }
        return;
      case "memory":
      case "skills":
        if (session === null) {
          await talk.inChannel(channel, texts.LOADED_TOP_LEVEL);
        } else if (!agent.capabilities.loadedContext) {
          await talk.tell(ref, named(texts.LOADED_UNAVAILABLE, names));
        } else {
          const loaded = await session.loaded();
          const shown = (text: string) => chat.escape(text, "reference");
          const text =
            command.kind === "memory"
              ? memoryText(loaded, session.directory, shown)
              : skillsText(loaded, session.commands, shown);
          await talk.say(channel, thread, text, { ownerOnly: true });
        }
        return;
      case "fork":
        if (session === null) {
          await talk.inChannel(channel, texts.FORK_TOP_LEVEL);
        } else {
          await fork.word(ref, message, session, command.prompt);
        }
        return;
      case "diff":
        if (session === null) {
          await talk.inChannel(channel, texts.DIFF_TOP_LEVEL);
        } else {
          await others.diff.word(ref, session);
        }
        return;
      case "terminal":
        if (session === null) {
          await talk.inChannel(channel, texts.TERMINAL_TOP_LEVEL);
        } else {
          await others.terminal.move(ref, session);
        }
        return;
      case "open":
        if (session === null) {
          await talk.inChannel(channel, texts.OPEN_TOP_LEVEL);
        } else if (!chat.capabilities.fileUpload || chat.openFile === undefined) {
          await talk.tell(ref, named(texts.OPEN_UNAVAILABLE, names));
        } else {
          await chat.openFile(ref, session.directory, command.target);
        }
        return;
      case "tag":
      case "untag": {
        if (session === null) {
          await talk.inChannel(channel, texts.TAG_TOP_LEVEL);
          return;
        }
        if (!chat.capabilities.threadTags || chat.tagThread === undefined) {
          await talk.tell(ref, named(texts.TAG_UNAVAILABLE, names));
          return;
        }
        const tag = command.kind === "tag" ? command.name : null;
        // The chat first, since it is what the owner sees. Its refusal is the chat's, not the
        // agent's, which the reply to any other failure of a word would name.
        try {
          await chat.tagThread(ref, tag);
        } catch (error) {
          if (!(error instanceof ChatError)) throw error;
          await talk.tell(ref, fill(named(texts.TAG_FAILED, names), { error: error.name }));
          return;
        }
        await mirrorTag(ref, session, tag);
        await talk.acknowledge(ref, message);
        return;
      }
      case "delete-thread":
        if (session === null) {
          await talk.inChannel(channel, texts.DELETE_THREAD_TOP_LEVEL);
        } else if (!chat.capabilities.threadDelete || chat.deleteThread === undefined) {
          await talk.tell(ref, named(texts.DELETE_THREAD_UNAVAILABLE, names));
        } else if (session.inUse) {
          // Refused before the owner is asked; the delete checks again on their yes, since the
          // thread may have started working meanwhile.
          await talk.tell(ref, texts.DELETE_THREAD_BUSY);
        } else {
          await chat.deleteThread(ref);
        }
        return;
      case "allaboard":
        if (allaboard === undefined) {
          await showHelp("");
        } else if (command.action === "show") {
          await talk.say(channel, where, await allaboard.show(), { ownerOnly: quiet });
        } else if (session !== null || outside) {
          // The offer lives in the channel, so a word that makes one is refused in a thread.
          const word = `${WORD.allaboard} ${command.action}`;
          await talk.tell(ref, fill(texts.WORD_IN_THREAD, { word }));
        } else if (command.action === "update") {
          await allaboard.update(channel);
        } else {
          await allaboard.restart(channel);
        }
        return;
      case "resume":
        if (session !== null || outside) {
          await talk.tell(ref, fill(texts.WORD_IN_THREAD, { word: WORD.resume }));
        } else {
          await others.resume.word(ref, command.target);
        }
        return;
    }
  };
}
