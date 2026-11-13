/**
 * `!diff`: the files a session's repository has changed since HEAD, as the terminal's `/diff`
 * lists them (its `Current` view), each with a control that shares that file's unified diff into
 * the thread. The core decides what is listed and what a pick does; the chat draws the list and
 * shares the bytes (`ThreadChat.offer`, `ThreadChat.share`).
 *
 * A pick carries the session and the path and nothing else: the patch is read again when the
 * control is used, so a list never holds content and a file committed since is told as such. A
 * diff the chat can draw in the list's own message is shown there; a larger one is shared as a
 * file, which the next pick of that list deletes (a list shows one thing at a time).
 */
import { isAbsolute, posix, resolve, sep } from "node:path";
import type { Repository } from "../../agent/seam.ts";
import {
  ChatError,
  type FileId,
  type ListPick,
  type ThreadList,
  type ThreadRef,
} from "../../chat/seam.ts";
import { monotonicClock } from "../../clock.ts";
import { shellQuote } from "../../text.ts";
import { errorName } from "../../values.ts";
import {
  type DiffStat,
  diffPatch,
  diffStats,
  type EditedFile,
  groupEdits,
  patchOfEdits,
  statOfEdits,
} from "../files/diff.ts";
import { usable } from "../files/listing.ts";
import { relativeTo } from "../files/paths.ts";
import { realpathLoose } from "../files/read.ts";
import type { TurnEdits } from "../sessions/changes.ts";
import { commandShown } from "../sessions/directory.ts";
import * as texts from "../texts.ts";
import { fill, named } from "../texts.ts";
import type { DiffFlow } from "./contract.ts";
import { type FlowDeps, logger, type Talk } from "./talk.ts";

/** The view of the files as they are now, against HEAD. */
export const CURRENT_VIEW = "current";

type Picked = Extract<ListPick, { type: "diff-file" | "diff-view" }>;
type DiffList = Extract<ThreadList, { type: "diff" }>;

/** What a list holds in memory: the file it last shared, and whether its message shows a diff. */
interface Entry {
  file: FileId | null;
  drawn: boolean;
}

/** The repository holding a folder when git may run in it, else the line that says why not. */
type Found = { readonly repository: Repository } | { readonly refusal: string };

export function diffFlow(deps: FlowDeps, talk: Talk): DiffFlow {
  const { agent, chat, sessions, state, names } = deps;
  const clock = deps.clock ?? monotonicClock;
  // Per list (channel and list message): the picks in the order they came, and what it holds. Memory only: after a restart an earlier file stays (invariant 3).
  const chains = new Map<string, Promise<void>>();
  const entries = new Map<string, Entry>();
  const keyOf = (ref: ThreadRef, list: string): string => JSON.stringify([ref.channel, list]);

  async function repositoryOf(directory: string): Promise<Found> {
    const trusted = usable(await sessions.repository(directory));
    if (trusted !== null) return { repository: trusted };
    const waiting = usable((await agent.untrustedRepository?.(directory)) ?? null);
    const template = agent.words.trust;
    if (waiting === null || template === null) return { refusal: texts.DIFF_NOT_A_REPOSITORY };
    const command = commandShown(fill(template, { directory: shellQuote(waiting.key) }), (text) =>
      chat.escape(text, "notice"),
    );
    return { refusal: fill(named(texts.DIFF_UNTRUSTED, names), { command }) };
  }

  /** The session's thread, with the two members `!diff` needs, or null when the chat lacks them. */
  function chatOf(ref: ThreadRef) {
    const thread = talk.thread(ref);
    const { offer, share, fitsList, unshare } = thread;
    if (offer === undefined || share === undefined || chat.fileLimit === undefined) return null;
    return {
      offer: offer.bind(thread),
      share: share.bind(thread),
      fitsList: fitsList?.bind(thread),
      unshare: unshare?.bind(thread),
      rewrite: thread.rewrite.bind(thread),
    };
  }

  const shown = (path: string): string => chat.escape(path, "notice");

  /**
   * What the turns of `ref`'s live session edited, as files of `repository`: one entry per turn
   * that edited any, oldest first. None for a thread whose process holds no turns (after a restart
   * or an idle close).
   */
  async function turnsOf(
    ref: ThreadRef,
    repository: Repository,
  ): Promise<{ id: string; label: string; files: EditedFile[] }[]> {
    const live = sessions.get(ref.channel, ref.thread);
    if (live === null) return [];
    const root = await realpathLoose(repository.root);
    const known = new Map<string, string | null>();
    const turns: { id: string; label: string; files: EditedFile[] }[] = [];
    for (const turn of live.editsByTurn()) {
      for (const change of turn.changes) {
        if (known.has(change.path)) continue;
        const absolute = isAbsolute(change.path)
          ? change.path
          : resolve(live.directory, change.path);
        const inside = relativeTo(root, await realpathLoose(absolute));
        known.set(change.path, inside === null ? null : inside.split(sep).join("/"));
      }
      const files = groupEdits(turn.changes, (path) => known.get(path) ?? null);
      if (files.length > 0) turns.push({ ...labelled(turn), files });
    }
    return turns;
  }

  function labelled(turn: TurnEdits): { id: string; label: string } {
    return { id: turn.id, label: fill(texts.DIFF_VIEW_TURN, { turn: turn.number }) };
  }

  /**
   * The list for `view`, or null when it says why there is none (or, with `replacing`, rewrites
   * the message it redraws into the line that says the tree is clean).
   */
  async function build(
    ref: ThreadRef,
    repository: Repository,
    sessionId: string,
    view: string,
    replacing?: string,
  ): Promise<DiffList | null> {
    const thread = chatOf(ref);
    if (thread === null) {
      await talk.tell(ref, named(texts.DIFF_UNAVAILABLE, names));
      return null;
    }
    const turns = await turnsOf(ref, repository);
    let files: readonly DiffStat[] | null;
    if (view === CURRENT_VIEW) {
      files = await diffStats(repository, chat.fileLimit ?? 0, clock);
    } else {
      const turn = turns.find((candidate) => candidate.id === view);
      if (turn === undefined) {
        await talk.tell(ref, texts.DIFF_VIEW_GONE);
        return null;
      }
      files = turn.files.map(statOfEdits);
    }
    if (files === null) {
      await talk.tell(ref, texts.DIFF_FAILED);
      return null;
    }
    if (files.length === 0 && turns.length === 0) {
      if (replacing === undefined) await talk.tell(ref, texts.DIFF_CLEAN);
      else await thread.rewrite(replacing, texts.DIFF_CLEAN);
      return null;
    }
    return assemble(view, turns, files, sessionId);
  }

  /** The list of `view` from what was read of the tree and the turns. */
  function assemble(
    view: string,
    turns: readonly { id: string; label: string }[],
    files: readonly DiffStat[],
    sessionId: string,
  ): DiffList {
    return {
      type: "diff",
      view,
      views: [
        { id: CURRENT_VIEW, label: texts.DIFF_VIEW_CURRENT },
        ...turns.map(({ id, label }) => ({ id, label })),
      ],
      files,
      session: sessionId,
    };
  }

  /** Draws the list for `view`; `replacing` is the message of the list it redraws. */
  async function draw(
    ref: ThreadRef,
    repository: Repository,
    sessionId: string,
    view: string,
    replacing?: string,
    entry?: Entry,
  ): Promise<void> {
    const list = await build(ref, repository, sessionId, view, replacing);
    if (list === null) return;
    await chatOf(ref)?.offer(list, texts.DIFF_TITLE, replacing);
    if (entry !== undefined) entry.drawn = false;
  }

  const tooLarge = (path: string, limit: number): string =>
    fill(named(texts.DIFF_FILE_TOO_LARGE, names), { path, limit });

  /**
   * The diff of one file with the files and turns it was read beside, or null when it says why
   * there is none to show. "gone" is a view that no longer exists, which the caller tells once.
   */
  async function read(
    ref: ThreadRef,
    repository: Repository,
    pick: Extract<Picked, { type: "diff-file" }>,
  ): Promise<
    | {
        text: string;
        files: readonly DiffStat[];
        turns: { id: string; label: string }[];
      }
    | "gone"
    | null
  > {
    const path = shown(pick.path);
    const limit = chat.fileLimit ?? 0;
    const turns = await turnsOf(ref, repository);
    let text: string;
    let files: readonly DiffStat[];
    if (pick.view === CURRENT_VIEW) {
      // The path comes back from the chat: only a file the tree lists now is read, so that a
      // directory or a pattern the list never held shares nothing.
      const stats = await diffStats(repository, limit, clock);
      if (stats === null) {
        await talk.tell(ref, fill(texts.DIFF_FILE_FAILED, { path }));
        return null;
      }
      files = stats;
      if (!files.some((file) => file.path === pick.path)) {
        await talk.tell(ref, fill(texts.DIFF_FILE_GONE, { path }));
        return null;
      }
      const patch = await diffPatch(repository, pick.path, limit, clock);
      if (patch === null) {
        await talk.tell(ref, fill(texts.DIFF_FILE_FAILED, { path }));
        return null;
      }
      if (patch.binary) {
        await talk.tell(ref, fill(texts.DIFF_FILE_BINARY, { path }));
        return null;
      }
      if (patch.large) {
        await talk.tell(ref, tooLarge(path, limit));
        return null;
      }
      text = patch.text;
    } else {
      const turn = turns.find((candidate) => candidate.id === pick.view);
      if (turn === undefined) return "gone";
      files = turn.files.map(statOfEdits);
      const file = turn.files.find((candidate) => candidate.path === pick.path);
      text = file === undefined ? "" : patchOfEdits(file);
      if (Buffer.byteLength(text) > limit) {
        await talk.tell(ref, tooLarge(path, limit));
        return null;
      }
    }
    if (text === "") {
      await talk.tell(ref, fill(texts.DIFF_FILE_GONE, { path }));
      return null;
    }
    return { text, files, turns: turns.map(({ id, label }) => ({ id, label })) };
  }

  /**
   * A pick of a file: its diff goes into the list's own message when the chat can draw it there,
   * else it is shared as a file, whose id is kept for the list's next pick to delete. A pick
   * that ends in a refusal still takes a diff of another file off the list.
   */
  async function show(
    ref: ThreadRef,
    repository: Repository,
    pick: Extract<Picked, { type: "diff-file" }>,
    entry: Entry,
  ): Promise<void> {
    const thread = chatOf(ref);
    if (thread === null) {
      await talk.tell(ref, named(texts.DIFF_UNAVAILABLE, names));
      return;
    }
    const got = await read(ref, repository, pick);
    if (got === "gone" && !entry.drawn) await talk.tell(ref, texts.DIFF_VIEW_GONE);
    if (got === "gone" || got === null) {
      if (entry.drawn) await draw(ref, repository, pick.session, pick.view, pick.list, entry);
      return;
    }
    const list = assemble(pick.view, got.turns, got.files, pick.session);
    const inList: DiffList = { ...list, shown: { path: pick.path, text: got.text } };
    if (thread.fitsList?.(inList, texts.DIFF_TITLE) === true) {
      try {
        await thread.offer(inList, texts.DIFF_TITLE, pick.list);
        entry.drawn = true;
        return;
      } catch (error) {
        // The chat refused the list with the diff in it: the diff goes as a file instead.
        if (!(error instanceof ChatError)) throw error;
        logger.warning(`could not draw a diff in ${ref.channel}: ${error.name}`);
      }
    }
    try {
      entry.file =
        (await thread.share({
          name: `${posix.basename(pick.path)}.diff`,
          title: `${pick.path}.diff`,
          content: Buffer.from(got.text),
        })) ?? null;
    } catch (error) {
      if (!(error instanceof ChatError)) throw error;
      await talk.tell(
        ref,
        fill(named(texts.DIFF_FILE_REFUSED, names), {
          path: shown(pick.path),
          error: error.name,
        }),
      );
      if (entry.drawn) await redraw(ref, thread, list, pick.list, entry);
      return;
    }
    // The chat clears a thread's status line when the app shares into it.
    sessions.wrote(ref.channel, ref.thread);
    // A diff the list drew before is gone from it; with none drawn there is nothing to redraw.
    if (entry.drawn) await redraw(ref, thread, list, pick.list, entry);
  }

  /** Draws `list` with no diff in it again; a refusal is logged, the file already shared stays. */
  async function redraw(
    ref: ThreadRef,
    thread: NonNullable<ReturnType<typeof chatOf>>,
    list: DiffList,
    message: string,
    entry: Entry,
  ): Promise<void> {
    try {
      await thread.offer(list, texts.DIFF_TITLE, message);
      entry.drawn = false;
    } catch (error) {
      if (!(error instanceof ChatError)) throw error;
      logger.warning(`could not redraw a list in ${ref.channel}: ${error.name}`);
    }
  }

  /** Deletes the file the list last shared, if any; a refusal is logged and ignored. */
  async function release(ref: ThreadRef, entry: Entry): Promise<void> {
    const id = entry.file;
    if (id === null) return;
    entry.file = null;
    try {
      await chatOf(ref)?.unshare?.(id);
    } catch (error) {
      logger.warning(`could not delete a shared diff in ${ref.channel}: ${errorName(error)}`);
    }
  }

  /** One pick, after the picks of its list before it. */
  async function pickOne(pick: Picked): Promise<void> {
    const { ref } = pick;
    const key = keyOf(ref, pick.list);
    // A list this process has not seen may show a diff drawn before a restart: unknown counts as drawn.
    const entry = entries.get(key) ?? { file: null, drawn: true };
    entries.set(key, entry);
    const stored = state.thread(ref.channel, ref.thread);
    // A list made for a session the thread no longer holds (a `!stop` and a new start can
    // replace it) is refused: its rows name files of another conversation's turns.
    if (stored === null || stored.sessionId !== pick.session) {
      await release(ref, entry);
      entries.delete(key);
      await talk.tell(ref, texts.DIFF_STALE);
      return;
    }
    await talk.replyOnFailure(ref, async () => {
      await release(ref, entry);
      const found = await repositoryOf(stored.directory);
      if ("refusal" in found) {
        await talk.tell(ref, found.refusal);
      } else if (pick.type === "diff-file") {
        await show(ref, found.repository, pick, entry);
      } else {
        await draw(ref, found.repository, pick.session, pick.view, pick.list, entry);
      }
    });
  }

  return {
    async word(ref, session) {
      // The daemon's git runs only where the agent's record of trust names a repository.
      if (!agent.capabilities.folderTrust || chatOf(ref) === null) {
        await talk.tell(ref, named(texts.DIFF_UNAVAILABLE, names));
        return;
      }
      const sessionId = state.thread(ref.channel, ref.thread)?.sessionId;
      if (sessionId === null || sessionId === undefined) {
        await talk.tell(ref, texts.DIFF_NOT_STARTED);
        return;
      }
      const found = await repositoryOf(session.directory);
      if ("refusal" in found) {
        await talk.tell(ref, found.refusal);
        return;
      }
      await draw(ref, found.repository, sessionId, CURRENT_VIEW);
    },

    async picked(pick) {
      // One pick at a time per list, the last click's the last applied: each link runs once the
      // one before settles, whichever way, and an entry is deleted only if it is still this run's
      // own, so a pick that arrived meanwhile is not dropped from the chain.
      const key = keyOf(pick.ref, pick.list);
      const run = () => pickOne(pick);
      const next = (chains.get(key) ?? Promise.resolve()).then(run, run);
      chains.set(key, next);
      try {
        await next;
      } finally {
        if (chains.get(key) === next) chains.delete(key);
      }
    },
  };
}
