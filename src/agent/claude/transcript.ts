/**
 * The entries a session's own Claude Code process appends to its transcript, read as they come.
 *
 * Some of what a session does is written only to its transcript: a goal's changes (`goal_status`)
 * and what the stop hooks said (`stop_hook_summary`). The stream never carries them, and
 * `active_goal`, which `sdk.d.ts` declares, never reaches it (measured 2026-10-29 on Claude Code
 * 2.1.312, as on 2026-10-20 on 2.1.304; upstream anthropics/claude-agent-sdk-typescript#409 and
 * #336). The SDK's `sessionStore` receives the same entries, and the SDK refuses it beside
 * `enableFileCheckpointing` ("file history backup blobs are written directly to local disk and
 * are not mirrored", code.claude.com/docs/en/agent-sdk/session-storage, read 2026-10-29), which
 * `!rewind` needs. The store is a mirror of this file, which "the subprocess always writes ... to
 * local disk first", so the file is read instead.
 *
 * Claude Code writes the transcript through a queue it drains every 100 ms, and drains it before
 * it yields a turn's `result` when `CLAUDE_CODE_EAGER_FLUSH` is set (its own source, 2.1.312),
 * which a thread's session is given; 13 results of 13 had a turn's lines on disk without it
 * (measured 2026-10-29). As each record of the stream comes, the session takes how far the file
 * reaches (`mark`), and reads it up to there before it passes the record on: a line comes before
 * the first record that came after it was written, and after the records that came before. The
 * format is not documented (`listing.ts` reads the same file).
 *
 * A terminal that resumes the session writes to the same file. Each entry names the kind of
 * process that wrote it in `entrypoint`, which Claude Code takes from `CLAUDE_CODE_ENTRYPOINT`:
 * `cli` for the terminal, `claude-desktop`, `claude-vscode`, `sdk-cli` for a `claude -p` (seen on
 * real transcripts 2026-10-29). The SDK sets `sdk-ts` only when the environment it is given has no
 * value (`sdk.mjs` 0.3.312), and a daemon started from an editor's terminal would pass that
 * editor's on, so a thread's session is given `OWN_ENTRYPOINT` (`session.ts:
 * ClaudeSession`) and only its lines are read here. Another process of the TypeScript SDK on
 * the same session would not be told apart.
 *
 * Only what Claude Code does to the file is read right: it appends to it, through a session's
 * turns, a `/compact` and a resume, and keeps the same file (same inode, measured 2026-10-29 on
 * 2.1.312). A file changed from outside (a backup restored over it, a sync tool replacing it, an
 * edit) is not told apart from it: its lines may repeat or be lost (`docs/limits.md`). A file
 * shorter than what was read is the one change caught, since it costs one comparison.
 */
import { constants, lstatSync, statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isRecord } from "../../values.ts";
import { projectFolder, projectKey } from "./listing.ts";

/** The `entrypoint` a thread's session runs under: the SDK's own default (see the module doc). */
export const OWN_ENTRYPOINT = "sdk-ts";

/** Whether `entry` was written by a process running under `OWN_ENTRYPOINT`. */
export function ownEntry(entry: unknown): boolean {
  return isRecord(entry) && entry.entrypoint === OWN_ENTRYPOINT;
}

// As `listing.ts` opens a transcript: a link is not followed, a FIFO is not waited on. The flags
// do not exist on Windows.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** The transcript's path names something other than a regular file. */
export class NotAFileError extends Error {
  override readonly name = "NotAFileError";

  constructor() {
    super("the transcript is not a regular file");
  }
}

/** Where the transcript of `session` is, or null while it is not there. */
export type FindTranscript = (session: string) => Promise<string | null>;

/** Where a `Transcript` starts. */
export interface TranscriptStart {
  /** The session, when it is known before the stream names it (a resume). */
  readonly session?: string | null;
  /**
   * The byte reading starts at; null when unknown, which the file itself settles at its size when
   * a read first opens it. Absent: 0, a new session's file read from its start.
   */
  readonly offset?: number | null;
  /** The file, when it was found. */
  readonly path?: string | null;
  /** The folder the session's file goes in, so that `locate` knows the file at once. */
  readonly project?: string | null;
}

/**
 * Where a resumed session's reading starts, read before the process starts: the file's size, or
 * null when it cannot be read (missing too: whatever is there when a read opens it is old).
 */
async function sizeOf(path: string): Promise<number | null> {
  try {
    const file = await open(path, OPEN_FLAGS);
    try {
      return (await file.stat()).size;
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

// The `stat` a mark takes: not following a link where the read does not either (`O_NOFOLLOW`),
// which Windows does not have.
const statOfMark = constants.O_NOFOLLOW === undefined ? statSync : lstatSync;

export class Transcript {
  readonly #find: FindTranscript;
  readonly #project: string | null;
  #session: string | null;
  #path: string | null = null;
  // `#path` was only worked out from the project folder (`locate`), not found: until a read finds
  // the file there, each read looks for it (`#find`), so that a file Claude Code put elsewhere (a
  // long folder name it hashed otherwise) is not waited for forever.
  #guessed = false;
  // Where reading stands, the reader's own state: behind the marks of the records whose reads wait
  // in line. Null when unknown (a resumed session's file could not be read at the start): the
  // file settles it, at its size when a read first opens it, never a mark, so no old line is told
  // for a new one.
  #offset: number | null;
  #decoder = new StringDecoder("utf8");
  // The end of the last read, past its last newline: a line Claude Code is still writing.
  #partial = "";

  /**
   * The transcript `find` finds, from `start`; with no session, a new one whose id the stream
   * gives (`locate`), read from its start.
   */
  constructor(find: FindTranscript, start: TranscriptStart = {}) {
    this.#find = find;
    this.#session = start.session ?? null;
    this.#offset = start.offset === undefined ? 0 : start.offset;
    this.#path = start.path ?? null;
    this.#project = start.project ?? null;
  }

  /**
   * The transcript of a session in `folder` under the projects directory `projects`, read from
   * what it holds now: a resumed session's earlier entries are not its process's.
   */
  static async open(projects: string, folder: string, resume: string | null): Promise<Transcript> {
    const find: FindTranscript = async (session) => {
      const project = await projectFolder(folder, projects);
      return project === null ? null : join(project, `${session}.jsonl`);
    };
    // Where Claude Code puts the folder's transcripts when it has none yet; a long folder name
    // may get another hash from it, which `find` then catches up with.
    const found = await projectFolder(folder, projects);
    const project = found ?? join(projects, await projectKey(folder));
    if (resume === null) return new Transcript(find, { project });
    // A resumed session's folder not found (unreadable, or a long name hashed otherwise): what
    // its file holds is unknown, and the file settles it when a read opens it.
    const path = found === null ? null : join(found, `${resume}.jsonl`);
    const offset = path === null ? null : await sizeOf(path);
    return new Transcript(find, { session: resume, offset, path, project });
  }

  /** The id of the session, from the stream: the first one given holds. */
  locate(session: string): void {
    this.#session ??= session;
    if (this.#path === null && this.#project !== null) {
      this.#path = join(this.#project, `${this.#session}.jsonl`);
      this.#guessed = true;
    }
  }

  /**
   * How far the transcript reaches now, taken as a stream record arrives so that the read for it
   * stops there: its size, 0 for a file not written yet while nothing has been read, and null when
   * it cannot be measured (where it is not known yet, not a regular file, a `stat` that fails). A
   * `stat` of a few microseconds, done at once so that no line written after the record is taken
   * for one written before it.
   */
  mark(): number | null {
    if (this.#path === null) return null;
    try {
      const found = statOfMark(this.#path);
      return found.isFile() ? found.size : null;
    } catch (error) {
      return isRecord(error) && error.code === "ENOENT" && this.#offset === 0 ? 0 : null;
    }
  }

  /**
   * The entries the session's process appended since the last read, up to `until` (the mark of
   * the record the read goes with), oldest first. With no mark (null) it delivers nothing: what
   * was written comes with the next record that has one, late rather than ahead of a record that
   * came before it; it still opens the file, so that a failure is told and an unknown start is
   * settled. Rejects when the file cannot be read. One read at a time: the caller awaits each.
   */
  async read(until: number | null): Promise<unknown[]> {
    if (this.#path === null) {
      if (this.#session === null) return [];
      this.#path = await this.#find(this.#session);
      if (this.#path === null) return [];
    }
    let chunk: string;
    try {
      if (this.#guessed) {
        // Worked out, not found: a missing file sends the read to look where it is (`#find`).
        const found = await stat(this.#path);
        if (!found.isFile()) throw new NotAFileError();
        this.#guessed = false;
      }
      // Once the file is found, a record that wrote nothing costs no call at all.
      if (until !== null && until === this.#offset) return [];
      const file = await open(this.#path, OPEN_FLAGS);
      try {
        // What was opened, which a link is not (`O_NOFOLLOW`): the truth a mark only stands for.
        // Before the size: Windows gives a folder a size of 0, which would read as nothing written.
        const opened = await file.stat();
        if (!opened.isFile()) throw new NotAFileError();
        if (this.#offset === null || opened.size < this.#offset) {
          // Unknown, or shorter than what was read: reading goes on from its end, with no line
          // begun. A mark below the offset alone is not a shorter file: it may be the mark of a
          // record that came before the reads caught up.
          this.#offset = opened.size;
          this.#decoder = new StringDecoder("utf8");
          this.#partial = "";
          return [];
        }
        if (until === null) return [];
        const end = Math.min(opened.size, until);
        if (end <= this.#offset) return [];
        const buffer = Buffer.alloc(end - this.#offset);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, this.#offset);
        this.#offset += bytesRead;
        chunk = this.#decoder.write(buffer.subarray(0, bytesRead));
      } finally {
        await file.close();
      }
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
      // Not written yet, or not where it was worked out to be: the next read looks where it is.
      if (this.#guessed && this.#session !== null) {
        const found = await this.#find(this.#session);
        if (found !== null && found !== this.#path) {
          this.#path = found;
          this.#guessed = false;
        }
      }
      return [];
    }
    const lines = (this.#partial + chunk).split("\n");
    this.#partial = lines.pop() ?? "";
    const entries: unknown[] = [];
    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // A line that is not JSON is no entry this module reads.
      }
    }
    return entries.filter(ownEntry);
  }
}
