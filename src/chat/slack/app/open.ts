/**
 * `!open`: a file of a session's folder shared into its thread, by name or through the message
 * only the owner sees (a search field and a few files as buttons). The logic is the core's
 * (`core/files/`) and `openfile/`; these are its handlers.
 *
 * The message is ephemeral and is replaced as `Suggestions` replaces its own: a search posts a new
 * one and takes the old one away (`delete_original`), since rewriting an ephemeral message
 * through `response_url` showed the new one in the channel too (seen 2026-10-21, desktop).
 */
import {
  changedIn,
  type Found,
  fill,
  NotAFile,
  named,
  newestFirst,
  readOpenable,
  regularFiles,
  TooLarge,
  texts,
} from "../../../core/port.ts";
import { strip } from "../../../text.ts";
import { errorCode } from "../../../values.ts";
import { SNIPPET_LIMIT, uploadFile } from "../openfile/read.ts";
import { QUERY_LIMIT, searchBlocks } from "../openfile/search.ts";
import { take } from "../reply/chars.ts";
import { describe } from "../reply/errors.ts";
import { shownAsWritten } from "../reply/escape.ts";
import * as slackTexts from "../texts.ts";
import { type Answers, type AppParts, isCancelled, logger } from "./answers.ts";
import { interactionActor } from "./guards.ts";
import {
  type Ack,
  clickThread,
  firstAction,
  type Payload,
  type Respond,
  record,
  text,
} from "./wire.ts";

/** The words of a search: what was typed, stripped (`text.ts`), cut at `QUERY_LIMIT` characters. */
function searched(typed: string): string {
  return take(strip(typed), QUERY_LIMIT);
}

// A thread's ts is its root's post time: `<epoch seconds>.<sequence>`.
const EPOCH_SECONDS = /^(\d+)(?:\.\d+)?\n?$/;

/** The epoch second a thread's ts names, or null when the ts is no time. */
export function startedAt(threadTs: string): number | null {
  const seconds = EPOCH_SECONDS.exec(threadTs);
  if (seconds === null) return null;
  const when = Number(seconds[1]);
  return Number.isSafeInteger(when) ? when : null;
}

// How many of the search's messages are remembered as already searched from.
const SEARCHES_KEPT = 16;

export class Open {
  private readonly clicked = new Set<string>();
  private readonly searched = new Set<string>();
  private readonly parts: AppParts;
  private readonly answers: Answers;

  constructor(parts: AppParts, answers: Answers) {
    this.parts = parts;
    this.answers = answers;
  }

  /**
   * The folder of the session that owns a thread, from its entry; null when the thread is no
   * session (or is being deleted). What a click or a typed query names is resolved here and
   * never against the channel's folder, which a later `!bind` may have moved.
   */
  threadFolder(channel: string, threadTs: string): string | null {
    const { state, sessions } = this.parts;
    const thread = state.thread(channel, threadTs);
    if (thread === null || sessions.held(channel, threadTs)) return null;
    return thread.directory;
  }

  /**
   * `!open` typed in a session's thread: the search message alone; with words, the file they
   * name as a path, else the file whose name contains them, else the files that do. A file is
   * opened on its own only when it is the one match of a listing that is complete.
   */
  async openWord(channel: string, threadTs: string, folder: string, words: string): Promise<void> {
    if (!words) {
      await this.showSearch(channel, threadTs, "", await this.foundFiles(folder, threadTs, ""));
      return;
    }
    if ((await regularFiles(folder, [words])).length > 0) {
      await this.openFile(channel, threadTs, folder, words);
      return;
    }
    const found = await this.foundFiles(folder, threadTs, words);
    const [only] = found.paths;
    if (only !== undefined && found.paths.length === 1 && found.complete) {
      await this.openFile(channel, threadTs, folder, only);
    } else {
      await this.showSearch(channel, threadTs, words, found);
    }
  }

  /** Posts the message only the owner sees, its field holding `words` and `found` as buttons. */
  private async showSearch(
    channel: string,
    threadTs: string,
    words: string,
    found: Found,
  ): Promise<void> {
    await this.answers.deliver(
      channel,
      threadTs,
      slackTexts.OPEN_FALLBACK,
      searchBlocks(words, found),
      { ephemeral: true },
    );
  }

  /**
   * What the buttons are chosen from, as paths from `folder`: with no `words`, the files
   * changed in the session, newest first (the union over the folder's repositories, none when
   * there is no repository or nothing changed); else the files whose path contains them, in
   * `rank`'s order (`Listings.search`). A
   * listing that fails is empty and incomplete.
   */
  async foundFiles(folder: string, threadTs: string, words: string): Promise<Found> {
    const { listings } = this.parts;
    try {
      if (!words) {
        const repositories = await listings.repositories(folder);
        const names = await changedIn(folder, repositories, startedAt(threadTs));
        const paths = await newestFirst(folder, names);
        return { paths, count: paths.length, complete: true };
      }
      return await listings.search(folder, words);
    } catch (error) {
      if (isCancelled(error)) throw error;
      logger.warning(`could not list files for a search: ${describe(error)}`);
      return { paths: [], count: 0, complete: false };
    }
  }

  /**
   * Share the file `relative` names under `folder` into the thread, which Slack shows in its own
   * viewer; no line of ours on success. True when it was shared. `relative` is untrusted.
   */
  async openFile(
    channel: string,
    threadTs: string,
    folder: string,
    relative: string,
  ): Promise<boolean> {
    const { slack, sessions } = this.parts;
    const shown = shownAsWritten(relative);
    let content: Buffer;
    try {
      content = await readOpenable(folder, relative, SNIPPET_LIMIT);
    } catch (error) {
      if (error instanceof NotAFile) {
        // The owner reads one sentence whatever the cause; the log says whether the daemon could
        // not read the file (the code only: never the path, which is the owner's).
        const cause = errorCode(error.cause);
        if (cause !== undefined) {
          logger.info(`could not open a file for ${channel}/${threadTs}: ${cause}`);
        }
        await this.answers.tellOwner(
          channel,
          threadTs,
          fill(slackTexts.OPEN_NOT_A_FILE, { path: shown }),
        );
        return false;
      }
      if (error instanceof TooLarge) {
        await this.answers.tellOwner(
          channel,
          threadTs,
          fill(named(slackTexts.OPEN_TOO_LARGE, this.parts.names), { path: shown }),
        );
        return false;
      }
      throw error;
    }
    if (content.length === 0) {
      // Refused here, not left to whatever Slack answers to an upload of length 0.
      await this.answers.tellOwner(channel, threadTs, fill(slackTexts.OPEN_EMPTY, { path: shown }));
      return false;
    }
    if (this.answers.stopped) return false;
    try {
      await uploadFile(slack, channel, threadTs, content, relative);
    } catch (error) {
      if (isCancelled(error)) throw error;
      const code = describe(error);
      // Slack's own code, never the file or its path.
      logger.warning(`could not share a file in ${channel}: ${code}`);
      let told: string;
      if (code === "missing_scope") told = slackTexts.OPEN_NO_SCOPE;
      else if (code === "snippet_too_large")
        told = fill(named(slackTexts.OPEN_TOO_LARGE, this.parts.names), { path: shown });
      else told = fill(slackTexts.OPEN_FAILED, { path: shown, error: code });
      await this.answers.tellOwner(channel, threadTs, told);
      return false;
    }
    // Slack clears a thread's status line when the app shares into it.
    sessions.wrote(channel, threadTs);
    return true;
  }

  /**
   * Enter in the search field: a new message is posted and the old one taken away, the new field
   * holding the words and its buttons the best matches, or the changed files again when the
   * field is empty. The channel and the thread come from the click; the words are untrusted and
   * only match names inside the thread's own folder.
   */
  onOpenSearch = async (ack: Ack, body: Payload, respond?: Respond): Promise<void> => {
    await ack();
    const [user, team] = interactionActor(body);
    const channel = text(record(body.channel).id);
    const threadTs = clickThread(body);
    if (!(await this.answers.admitted(user, team, channel, threadTs)) || channel === null) return;
    // The message goes with its first Enter: a second one for it, a key held or an event sent
    // twice, would post a second message.
    const message = text(record(body.container).message_ts);
    if (message !== null) {
      if (this.searched.has(message)) return;
      this.searched.add(message);
      for (const oldest of this.searched) {
        if (this.searched.size <= SEARCHES_KEPT) break;
        this.searched.delete(oldest);
      }
    }
    const typed = text(firstAction(body).value) ?? "";
    const words = searched(typed);
    const folder = this.threadFolder(channel, threadTs);
    if (folder === null) {
      await this.answers.tellOwner(channel, threadTs, texts.NOT_A_SESSION);
      return;
    }
    await this.answers.replyOnFailure(
      channel,
      threadTs,
      async () => {
        const found = await this.foundFiles(folder, threadTs, words);
        // Posted first: a post that fails leaves the message it would have replaced.
        try {
          await this.showSearch(channel, threadTs, words, found);
        } catch (error) {
          // The message stays, and its field must answer again.
          if (message !== null) this.searched.delete(message);
          throw error;
        }
        await this.answers.takeBack(respond, "the file search");
      },
      (told) => this.answers.tellOwner(channel, threadTs, told),
    );
  };

  /**
   * A file button: the file is shared into the thread, then the message taken away. The button's
   * value is untrusted, and the file is read from the folder of the thread's own session
   * (`readOpenable` refuses anything outside it).
   */
  onOpenFile = async (ack: Ack, body: Payload, respond?: Respond): Promise<void> => {
    await ack();
    const [user, team] = interactionActor(body);
    const channel = text(record(body.channel).id);
    const threadTs = clickThread(body);
    if (!(await this.answers.admitted(user, team, channel, threadTs)) || channel === null) return;
    // A second click while the first is at work shares nothing more.
    const message = text(record(body.container).message_ts);
    if (message !== null && this.clicked.has(message)) return;
    if (message !== null) this.clicked.add(message);
    const relative = text(firstAction(body).value);
    const folder = this.threadFolder(channel, threadTs);
    if (relative === null || folder === null) {
      if (message !== null) this.clicked.delete(message);
      await this.answers.tellOwner(channel, threadTs, texts.NOT_A_SESSION);
      return;
    }
    try {
      // Taken back only once shared: a refused file leaves the other buttons.
      await this.answers.replyOnFailure(
        channel,
        threadTs,
        async () => {
          if (await this.openFile(channel, threadTs, folder, relative)) {
            await this.answers.takeBack(respond, "the file search");
          }
        },
        (told) => this.answers.tellOwner(channel, threadTs, told),
      );
    } finally {
      if (message !== null) this.clicked.delete(message);
    }
  };
}
