/**
 * A message the owner wrote: read as a word of the daemon's, a command of the agent's or a
 * prompt, and sent to its thread's session after the setup and the hold when either is due.
 *
 * Ordering. Prompts, messages with files and commands enter a thread's queue in the order they
 * were sent although files take a while to read. That holds by construction: from the moment a
 * provider hands over a message (`message` is called) to the moment its place in line is taken
 * (`Mutex.acquire` inside `arrival`), nothing is awaited except a call to the chat (the
 * old-folder notice). The stretches are marked `(sync)`; the provider keeps its side of it: it
 * hands the messages of a thread over in the order its listeners were called, whatever its
 * checks take, with nothing awaited between its last check and the call.
 */

import type { CommandInfo } from "../../agent/seam.ts";
import type { InboundMessage, ThreadRef } from "../../chat/seam.ts";
import { strip } from "../../text.ts";
import {
  type Command,
  commandPool,
  hostOnly,
  isBangAlone,
  notOfferedAnswer,
  type Passthrough,
  parseBang,
  rankCandidates,
  refusedInThread,
} from "../commands.ts";
import { SessionClosed, SessionGone } from "../sessions/errors.ts";
import type { ThreadSession } from "../sessions/session.ts";
import { Mutex } from "../sessions/tasks.ts";
import * as texts from "../texts.ts";
import { fill, named } from "../texts.ts";
import type { MessagesFlow, OtherFlows } from "./contract.ts";
import type { FlowDeps, Report, Talk } from "./talk.ts";
import { unservedWords, wordFlow } from "./words.ts";

/** The first word of a passthrough, as typed: the text up to its first space. */
function firstWord(command: Passthrough): string {
  return command.text.split(" ", 1)[0] ?? "";
}

/**
 * Whether a passthrough starts a new session under any of the agent's names (`refusedInThread`,
 * given its `newSession` names and the session's `commands`): refused inside a thread (one thread
 * is one session), left as an ordinary passthrough everywhere else.
 */
export function isClear(
  command: Passthrough,
  commands: readonly CommandInfo[] | null,
  newSession: readonly string[],
  agentCommands = true,
): boolean {
  return refusedInThread(commands, newSession, agentCommands).has(firstWord(command).toLowerCase());
}

export function messages(deps: FlowDeps, talk: Talk, others: OtherFlows): MessagesFlow {
  const { chat, agent, sessions, state, names } = deps;
  const word = wordFlow(deps, talk, others);
  const unserved = unservedWords(deps, others);
  // One lock per thread, alive only while someone holds or waits on it (a channel keeps
  // opening new threads for as long as it runs; a lock kept forever would leak).
  const arrivalOrder = new Map<string, Mutex>();
  const arrivalWaiters = new Map<string, number>();

  /** `work` in its turn among the messages of one thread: the turns are taken in call order. */
  async function arrival(ref: ThreadRef, work: () => Promise<void>): Promise<void> {
    const key = `${ref.channel}\n${ref.thread}`;
    // (sync) The place in line is taken inside this call, before its first await.
    arrivalWaiters.set(key, (arrivalWaiters.get(key) ?? 0) + 1);
    let lock = arrivalOrder.get(key);
    if (lock === undefined) {
      lock = new Mutex();
      arrivalOrder.set(key, lock);
    }
    const turn = lock.acquire();
    try {
      const release = await turn;
      try {
        await work();
      } finally {
        release();
      }
    } finally {
      const left = (arrivalWaiters.get(key) ?? 1) - 1;
      if (left === 0) {
        arrivalWaiters.delete(key);
        arrivalOrder.delete(key);
      } else {
        arrivalWaiters.set(key, left);
      }
    }
  }

  /** What the old-folder notice says of this thread, or null when its folder is the channel's. */
  function oldFolderText(channel: string, session: ThreadSession): string | null {
    const record = state.channel(channel);
    if (record === null || session.directory === record.directory) return null;
    return fill(named(texts.OLD_THREAD_FOLDER, names), {
      old: chat.escape(session.directory, "notice"),
      new: chat.escape(record.directory, "notice"),
    });
  }

  /**
   * Whether a message for `session` must be refused now: the daemon is draining, or an install
   * is replacing its copy and the message would start an agent process (a session already
   * connected goes on).
   */
  function refusing(session: ThreadSession): boolean {
    return sessions.draining || (sessions.startsBlocked && !session.connected);
  }

  /**
   * A `!word` typed in a session's thread that the session does not list: when the chat suggests
   * commands, shows the owner the ones it could mean, or says that none looks like it, and sends
   * nothing to the agent. `typed` is what the owner wrote, exactly. The session is connected, so
   * that it lists its commands. False when the chat does not suggest, or when `command` is a name
   * or alias the session lists: the caller then sends it as it always did.
   */
  async function suggest(
    message: InboundMessage,
    session: ThreadSession,
    command: Passthrough,
    typed: string,
  ): Promise<boolean> {
    const { ref } = message;
    if (!chat.capabilities.commandSuggestions || chat.suggestCommands === undefined) return false;
    if (!agent.capabilities.commands) return false;
    const word = firstWord(command);
    const listed = session.commands.some(
      (offered) => offered.name === word || offered.aliases.includes(word),
    );
    if (listed) return false;
    const pool = commandPool(session.commands, strip(command.text.slice(word.length)), names, {
      unserved,
      folderTrust: agent.capabilities.folderTrust,
    });
    const all = word === "";
    const candidates = all ? pool : rankCandidates(word, pool);
    if (candidates.length === 0) {
      await talk.tell(
        ref,
        fill(texts.NO_SUCH_COMMAND, { word: chat.escape(`!${word}`, "notice") }),
      );
      return true;
    }
    await chat.suggestCommands(ref, {
      typed,
      message: message.id,
      all,
      candidates: candidates.map(({ aliases: _aliases, ...shown }) => shown),
    });
    return true;
  }

  /**
   * Send a prompt, a message with files or a command to its thread's session, in the order the
   * thread's messages were sent, after the session's setup and the same-folder hold when either
   * is due.
   */
  async function submitToSession(
    message: InboundMessage,
    opened: ThreadSession,
    command: Passthrough | null,
    options: { readonly inThread: boolean; readonly typed: string },
  ): Promise<void> {
    const { ref } = message;
    const { inThread } = options;
    if (talk.stopped) return;
    if (
      inThread &&
      command !== null &&
      isClear(command, opened.commands, agent.words.newSession, agent.capabilities.commands)
    ) {
      await talk.tell(ref, texts.CLEAR_IN_THREAD);
      return;
    }
    // Prompts and commands for the agent enter the queue in the order they were sent, although
    // files take a while to read. Every reply goes to the thread.
    await arrival(ref, async () => {
      let session = opened;
      let prompt = await message.content();
      if (prompt === null || talk.stopped) return;
      // Checked before the hold too: a drain already cancelled every hold open when it
      // started (`SessionManager.drain`) and will never cancel one opened after, so a message
      // that arrives once draining has begun must never open a new one (it would wait
      // forever).
      if (refusing(session)) {
        await talk.refuseRestarting(ref);
        return;
      }
      // A word the session does not list is suggested for before the setup and the hold ask
      // anything: a typo asks nothing, and they are asked once, for the text sent on Enter. Only
      // where learning the list wakes nothing the hold guards: a session already connected, or
      // one that never ran, which its setup connects before the hold anyway (an unsent Start's
      // choices forgotten first, as the setup does). A session that ran and was closed is asked
      // the hold first, and suggested for once it is connected below.
      const early = inThread && command !== null && (session.connected || session.neverRan);
      if (early) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await session.forgetSetup();
            await session.ensureConnected();
            if (await suggest(message, session, command, options.typed)) return;
            break;
          } catch (error) {
            if (!(error instanceof SessionClosed) || attempt > 0) throw error;
            const fresh = sessions.get(ref.channel, ref.thread);
            if (fresh === null) throw new SessionGone(names);
            session = fresh;
          }
        }
        // The connect may have outlasted a drain or an install.
        if (refusing(session)) {
          await talk.refuseRestarting(ref);
          return;
        }
      }
      // The same-folder hold: this message would wake `session` (busy just queues behind what
      // is already running); ask first when another live session, of any channel, is already
      // busy in the same resolved folder. Later messages of this thread queue behind the wait,
      // since it runs inside the arrival lock. `held` is the object a Continue's mark was left
      // standing on (`holdEnd({ continued: true })` bets on the `submit()` below to replace it
      // with the working one): kept apart from `session`, which a `SessionClosed` retry below
      // can reassign, so a non-submit exit always restores the mark on the object that
      // actually shows it.
      let held: ThreadSession | null = null;
      let askedSetup = false;
      if (!inThread || session.neverRan) {
        // A session's first prompt: its setup comes before anything else, the hold's question
        // included. A reply in a thread whose setup was cancelled, or whose hold was, is a
        // first prompt too: nothing was ever sent in it.
        const ready = await others.setup.beforeSending(ref, session);
        if (ready === null) return;
        session = ready;
        held = ready;
        askedSetup = true;
      }
      if (!session.busy) {
        const other = sessions.workingIn({ besides: session });
        if (other !== null) {
          if (!(await others.hold.beforeSending(ref, session, other))) {
            // the Start that nothing was sent for
            if (askedSetup && !talk.stopped) await session.forgetSetup();
            return;
          }
          held = session;
        }
      }
      // Retried once against a freshly looked-up session: the one this call was handed can
      // still close under it (most likely the idle close, though `touch()` at the lookup
      // already guards the common case) during the read above or the steps below.
      let submitted = false;
      let failed = false;
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            if (command !== null) {
              await session.ensureConnected();
              if (inThread && !early && (await suggest(message, session, command, options.typed)))
                return;
              const known = new Set(session.commands.map((offered) => offered.name));
              prompt = known.has(firstWord(command)) ? `/${command.text}` : message.text;
            }
            // (sync) Checked last, with no await before the submit: a stop can start while the
            // files are read. The daemon's words still work meanwhile (`!stop` shortens the
            // wait); a new turn would not finish, and the chat does not send this message
            // again. A stop that ended meanwhile (the daemon is gone) sends nothing and says
            // nothing.
            if (talk.stopped) return;
            if (refusing(session)) {
              await talk.refuseRestarting(ref);
              return;
            }
            await session.submit(prompt);
            submitted = true;
            return;
          } catch (error) {
            if (!(error instanceof SessionClosed) || attempt > 0) throw error;
            const fresh = sessions.get(ref.channel, ref.thread);
            // Not just closed: its thread's own entry is gone too (a `SessionGone` close), so
            // a retry would find nothing here again either.
            if (fresh === null) throw new SessionGone(names);
            session = fresh;
          }
        }
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        // `submitted` alone, not a fixed set of error types: `ensureConnected` can also reject
        // with the agent's own failure (a logged-out CLI, most likely) or anything a stray bug
        // throws; none of them may ever leave a Continue's mark standing forever. A failure
        // gets the mark a turn that reached the queue and then failed gets; a plain return (the
        // drain notice posted fine) restores a Cancel's own mark instead.
        if (held !== null && !submitted) await held.reactHoldAbandoned({ error: failed });
      }
    });
  }

  /**
   * Where a word's failure is told: in the channel for a word that acts top-level, under the
   * owner's message for one typed inside a session's thread.
   */
  function wordReport(ref: ThreadRef, session: ThreadSession | null): Report {
    return async (told) => {
      if (session === null) await talk.inChannel(ref.channel, told);
      else await talk.tell(ref, told);
    };
  }

  /**
   * One message that passed its provider's checks, routed by where it was written: a known
   * session's thread, a thread that holds none, or the channel.
   */
  async function route(message: InboundMessage): Promise<void> {
    const { ref, topLevel } = message;
    const { channel, thread } = ref;
    // (sync) From here to the turn `submitToSession` takes, unless a call to the chat is due or
    // the message opens a thread: that one first asks whether another process updates allaboard
    // (a read of the lock file), so the thread exists a few milliseconds later than the message
    // was routed. An event of that thread cannot arrive sooner: it is written under a message
    // that is already shown. A stop that closes the sessions meanwhile makes `open` throw
    // `SessionClosed`, which `replyOnFailure` tells.
    // A message with files is a prompt: no daemon word or command takes a file. A word is a
    // word however it is formatted: the typed text carries the chat's marks (a backtick before
    // the `!` of a message in inline code), which `plain` has removed. Nor is a message that
    // was spoken: what the chat heard never turns bypass on, stops a session or becomes a
    // command, whatever its first character. Both are `literal`.
    // A known session's thread routes a word to it; anywhere else (truly top-level, or a
    // thread that is not a session) a word acts exactly as a top-level one would.
    const session = topLevel ? null : sessions.get(channel, thread);
    let command: Command | null = null;
    // The text that read as a word: what a suggestion shows back to the owner.
    let written = message.text;
    if (!message.literal) {
      command = parseBang(message.text);
      if (command === null) {
        command = parseBang(message.plain);
        written = message.plain;
      }
      // `!` alone is a prompt unless the chat suggests and a session's thread is where it was
      // typed: then it asks for every command. Suggestions are made nowhere else.
      if (command === null && session !== null && chat.capabilities.commandSuggestions) {
        if (isBangAlone(message.text) || isBangAlone(message.plain)) {
          command = { kind: "passthrough", text: "" };
        }
      }
    }
    if (command !== null && command.kind !== "passthrough") {
      const typed = command;
      await talk.replyOnFailure(
        ref,
        () => word(ref, message.id, typed, { session, outside: !topLevel && session === null }),
        wordReport(ref, session),
      );
      return;
    }
    if (command !== null) {
      const answer =
        hostOnly(command, names, agent.capabilities.commands) ??
        // A session not connected yet lists nothing: the agent's own list is known once it is.
        notOfferedAnswer(
          command,
          session?.commands ?? [],
          agent.words.notOffered,
          names,
          agent.capabilities.commands,
        );
      if (answer !== null) {
        // Answered where a word is: under the owner's message in a session's thread, for the
        // owner alone, and as a post in the channel anywhere else. No session starts.
        if (session !== null) await talk.tell(ref, answer);
        else await talk.inChannel(channel, answer);
        return;
      }
    }
    if (session !== null) {
      // A prompt sent in a thread whose folder differs from the channel's current one is told
      // so, on every prompt: a line for the owner alone can vanish on reload, so a once-only
      // notice could mean never. `tell` never rejects, so a failed notice cannot drop the
      // prompt that follows it.
      const moved = oldFolderText(channel, session);
      if (moved !== null) await talk.tell(ref, moved);
      await submitToSession(message, session, command, { inThread: true, typed: written });
      return;
    }
    if (!topLevel) {
      // Anything but a daemon word, in a thread that holds no session: nowhere to send it.
      await talk.tell(ref, texts.NOT_A_SESSION);
      return;
    }
    // Before the thread's entry is written: an install under way starts no process, and a message
    // that would only start one changes nothing.
    if (state.channel(channel) !== null && (await sessions.refusesStarts())) {
      await talk.refuseRestarting(ref);
      return;
    }
    const opened = sessions.open(channel, thread);
    if (opened === null) {
      await talk.unbound(channel);
      return;
    }
    await submitToSession(message, opened, command, { inThread: false, typed: written });
  }

  return {
    // A failure of a prompt itself (or of the session it starts) lands in that session's
    // thread: it is the turn's one push. A word answers where it was typed instead.
    message: (message) => talk.replyOnFailure(message.ref, () => route(message)),
  };
}
