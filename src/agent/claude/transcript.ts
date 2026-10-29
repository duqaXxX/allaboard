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
 * Claude Code writes the entries of a turn before it yields the turn's `result`: 3 results of 3
 * found both kinds already on disk (measured 2026-10-29, 2.1.312). The session reads the file
 * before it passes on each record of the stream, so an entry comes before the record written
 * after it. The format is not documented (`listing.ts` reads the same file).
 *
 * A terminal that resumes the session writes to the same file. Each entry names the kind of
 * process that wrote it in `entrypoint`, which Claude Code takes from `CLAUDE_CODE_ENTRYPOINT`:
 * `cli` for the terminal, `claude-desktop`, `claude-vscode`, `sdk-cli` for a `claude -p` (seen on
 * real transcripts 2026-10-29). The SDK sets `sdk-ts` only when the environment it is given has no
 * value (`sdk.mjs` 0.3.312), and a daemon started from an editor's terminal would pass that
 * editor's on, so a thread's session is given `OWN_ENTRYPOINT` (`session.ts:
 * ClaudeSession`) and only its lines are read here. Another process of the TypeScript SDK on
 * the same session would not be told apart.
 */
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isRecord } from "../../values.ts";
import { projectFolder } from "./listing.ts";

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

/** A size to start from, read before the process starts; 0 when the file is not there. */
async function sizeOf(path: string | null): Promise<number> {
  if (path === null) return 0;
  try {
    const file = await open(path, OPEN_FLAGS);
    try {
      return (await file.stat()).size;
    } finally {
      await file.close();
    }
  } catch {
    return 0;
  }
}

export class Transcript {
  readonly #find: FindTranscript;
  #session: string | null;
  #path: string | null = null;
  #offset: number;
  #decoder = new StringDecoder("utf8");
  // The end of the last read, past its last newline: a line Claude Code is still writing.
  #partial = "";

  /**
   * The transcript of `session` from `offset` on, at `path` when it was found; with a null
   * session, a new one whose id the stream gives (`locate`), read from its start.
   */
  constructor(
    find: FindTranscript,
    session: string | null = null,
    offset = 0,
    path: string | null = null,
  ) {
    this.#find = find;
    this.#session = session;
    this.#offset = offset;
    this.#path = path;
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
    const path = resume === null ? null : await find(resume);
    return new Transcript(find, resume, await sizeOf(path), path);
  }

  /** The id of the session, from the stream: the first one given holds. */
  locate(session: string): void {
    this.#session ??= session;
  }

  /**
   * The entries the session's process appended since the last read, oldest first; none while the
   * file is not there. Rejects when the file cannot be read. One read at a time: the caller
   * awaits each.
   */
  async read(): Promise<unknown[]> {
    if (this.#path === null) {
      if (this.#session === null) return [];
      this.#path = await this.#find(this.#session);
      if (this.#path === null) return [];
    }
    let chunk: string;
    try {
      // The common case, a record that wrote nothing, costs one `stat`.
      const found = await stat(this.#path);
      // Before the size: Windows gives a folder a size of 0, which would read as nothing written.
      if (!found.isFile()) throw new NotAFileError();
      const { size } = found;
      if (size === this.#offset) return [];
      if (size < this.#offset) {
        // Rewritten under the session: what it held is unknown, so reading goes on from here.
        this.#offset = size;
        this.#decoder = new StringDecoder("utf8");
        this.#partial = "";
        return [];
      }
      const file = await open(this.#path, OPEN_FLAGS);
      try {
        const buffer = Buffer.alloc(size - this.#offset);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, this.#offset);
        this.#offset += bytesRead;
        chunk = this.#decoder.write(buffer.subarray(0, bytesRead));
      } finally {
        await file.close();
      }
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return [];
      throw error;
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
