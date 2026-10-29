/**
 * `!diff`: the files a session's repository has changed since HEAD, as the terminal's `/diff`
 * lists them (its `Current` view), each with a control that shares that file's unified diff into
 * the thread. The core decides what is listed and what a pick does; the chat draws the list and
 * shares the bytes (`ThreadChat.offer`, `ThreadChat.share`).
 *
 * A pick carries the session and the path and nothing else: the patch is read again when the
 * control is used, so a list never holds content and a file committed since is told as such.
 */
import { isAbsolute, posix, resolve, sep } from "node:path";
import type { Repository } from "../../agent/seam.ts";
import { ChatError, type ListPick, type ThreadRef } from "../../chat/seam.ts";
import { monotonicClock } from "../../clock.ts";
import { shellQuote } from "../../text.ts";
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
import type { FlowDeps, Talk } from "./talk.ts";

/** The view of the files as they are now, against HEAD. */
export const CURRENT_VIEW = "current";

type Picked = Extract<ListPick, { type: "diff-file" | "diff-view" }>;

/** The repository holding a folder when git may run in it, else the line that says why not. */
type Found = { readonly repository: Repository } | { readonly refusal: string };

export function diffFlow(deps: FlowDeps, talk: Talk): DiffFlow {
  const { agent, chat, sessions, state, names } = deps;
  const clock = deps.clock ?? monotonicClock;

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
    const { offer, share } = thread;
    if (offer === undefined || share === undefined || chat.fileLimit === undefined) return null;
    return {
      offer: offer.bind(thread),
      share: share.bind(thread),
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

  /** Draws the list for `view`; `replacing` is the message of the list it redraws. */
  async function draw(
    ref: ThreadRef,
    repository: Repository,
    sessionId: string,
    view: string,
    replacing?: string,
  ): Promise<void> {
    const thread = chatOf(ref);
    if (thread === null) {
      await talk.tell(ref, named(texts.DIFF_UNAVAILABLE, names));
      return;
    }
    const turns = await turnsOf(ref, repository);
    let files: readonly DiffStat[] | null;
    if (view === CURRENT_VIEW) {
      files = await diffStats(repository, clock);
    } else {
      const turn = turns.find((candidate) => candidate.id === view);
      if (turn === undefined) {
        await talk.tell(ref, texts.DIFF_VIEW_GONE);
        return;
      }
      files = turn.files.map(statOfEdits);
    }
    if (files === null) {
      await talk.tell(ref, texts.DIFF_FAILED);
      return;
    }
    if (files.length === 0 && turns.length === 0) {
      if (replacing === undefined) await talk.tell(ref, texts.DIFF_CLEAN);
      else await thread.rewrite(replacing, texts.DIFF_CLEAN);
      return;
    }
    await thread.offer(
      {
        type: "diff",
        view,
        views: [
          { id: CURRENT_VIEW, label: texts.DIFF_VIEW_CURRENT },
          ...turns.map(({ id, label }) => ({ id, label })),
        ],
        files,
        session: sessionId,
      },
      texts.DIFF_TITLE,
      replacing,
    );
  }

  const tooLarge = (path: string, limit: number): string =>
    fill(named(texts.DIFF_FILE_TOO_LARGE, names), { path, limit });

  /** Shares the diff of one file, told as a line when there is none to share. */
  async function share(
    ref: ThreadRef,
    repository: Repository,
    pick: Extract<Picked, { type: "diff-file" }>,
  ): Promise<void> {
    const thread = chatOf(ref);
    if (thread === null) {
      await talk.tell(ref, named(texts.DIFF_UNAVAILABLE, names));
      return;
    }
    const path = shown(pick.path);
    const limit = chat.fileLimit ?? 0;
    let text: string;
    if (pick.view === CURRENT_VIEW) {
      // The path comes back from the chat: only a file the tree lists now is read, so that a
      // directory or a pattern the list never held shares nothing.
      const files = await diffStats(repository, clock);
      if (files === null) {
        await talk.tell(ref, fill(texts.DIFF_FILE_FAILED, { path }));
        return;
      }
      if (!files.some((file) => file.path === pick.path)) {
        await talk.tell(ref, fill(texts.DIFF_FILE_GONE, { path }));
        return;
      }
      const patch = await diffPatch(repository, pick.path, limit, clock);
      if (patch === null) {
        await talk.tell(ref, fill(texts.DIFF_FILE_FAILED, { path }));
        return;
      }
      if (patch.binary) {
        await talk.tell(ref, fill(texts.DIFF_FILE_BINARY, { path }));
        return;
      }
      if (patch.large) {
        await talk.tell(ref, tooLarge(path, limit));
        return;
      }
      text = patch.text;
    } else {
      const turn = (await turnsOf(ref, repository)).find((candidate) => candidate.id === pick.view);
      if (turn === undefined) {
        await talk.tell(ref, texts.DIFF_VIEW_GONE);
        return;
      }
      const file = turn.files.find((candidate) => candidate.path === pick.path);
      text = file === undefined ? "" : patchOfEdits(file);
      if (Buffer.byteLength(text) > limit) {
        await talk.tell(ref, tooLarge(path, limit));
        return;
      }
    }
    if (text === "") {
      await talk.tell(ref, fill(texts.DIFF_FILE_GONE, { path }));
      return;
    }
    try {
      await thread.share({
        name: `${posix.basename(pick.path)}.diff`,
        title: `${pick.path}.diff`,
        content: Buffer.from(text),
      });
    } catch (error) {
      if (!(error instanceof ChatError)) throw error;
      await talk.tell(
        ref,
        fill(named(texts.DIFF_FILE_REFUSED, names), { path, error: error.name }),
      );
      return;
    }
    // The chat clears a thread's status line when the app shares into it.
    sessions.wrote(ref.channel, ref.thread);
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
      const { ref } = pick;
      const stored = state.thread(ref.channel, ref.thread);
      // A list made for a session the thread no longer holds (a `!stop` and a new start can
      // replace it) is refused: its rows name files of another conversation's turns.
      if (stored === null || stored.sessionId !== pick.session) {
        await talk.tell(ref, texts.DIFF_STALE);
        return;
      }
      await talk.replyOnFailure(ref, async () => {
        const found = await repositoryOf(stored.directory);
        if ("refusal" in found) {
          await talk.tell(ref, found.refusal);
        } else if (pick.type === "diff-file") {
          await share(ref, found.repository, pick);
        } else {
          await draw(ref, found.repository, pick.session, pick.view, pick.list);
        }
      });
    },
  };
}
