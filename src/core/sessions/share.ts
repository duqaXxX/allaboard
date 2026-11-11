/**
 * The model's request to share a file of the session's folder into its thread (`DaemonActions.share`):
 * the same rule as `!open`, answered as a line for the model instead of a message to the owner.
 */

import { basename, isAbsolute, sep } from "node:path";
import { ChatError, type ThreadChat } from "../../chat/seam.ts";
import { getLogger } from "../../log.ts";
import { errorName } from "../../values.ts";
import { relativeTo } from "../files/paths.ts";
import { NotAFile, readOpenable, realpathLoose, TooLarge, titleOf } from "../files/read.ts";
import { sizeText } from "../guide.ts";
import {
  fill,
  SHARE_DONE,
  SHARE_EMPTY,
  SHARE_NOT_A_FILE,
  SHARE_REFUSED,
  SHARE_STOPPED,
  SHARE_TOO_LARGE,
} from "../texts.ts";

/** The part of a thread's chat a share needs: the upload is there, or no share is offered. */
export interface ShareTarget {
  readonly share: NonNullable<ThreadChat["share"]>;
  readonly written: ThreadChat["written"];
}

const logger = getLogger("allaboard.core.sessions.share");

/**
 * Shares `path` (untrusted: the model wrote it; absolute, or relative to `working`, the folder the
 * session works in) into `thread`, up to `limit` bytes. Containment is checked against `folder`,
 * the bound one, so a working folder outside it shares nothing. Resolves with the line for the model, a refusal included; rejects only for a failure
 * that is no refusal. The signal is checked before the upload: the chat has no abort for a call
 * in flight.
 */
export async function shareFile(
  folder: string,
  working: string,
  thread: ShareTarget,
  limit: number,
  path: string,
  signal: AbortSignal,
): Promise<string> {
  const stopped = fill(SHARE_STOPPED, { path });
  if (signal.aborted) return stopped;
  if (path === "") return fill(SHARE_NOT_A_FILE, { path });
  // Joined as text, as `readOpenable` joins: `path.join` would drop `link/..` lexically.
  const target = isAbsolute(path) ? path : `${working}${sep}${path}`;
  let content: Buffer;
  try {
    content = await readOpenable(folder, target, limit);
  } catch (error) {
    if (error instanceof NotAFile) return fill(SHARE_NOT_A_FILE, { path });
    if (error instanceof TooLarge) return fill(SHARE_TOO_LARGE, { path, size: sizeText(limit) });
    throw error;
  }
  // Refused here, not left to whatever the chat answers to an upload of length 0.
  if (content.length === 0) return fill(SHARE_EMPTY, { path });
  if (signal.aborted) return stopped;
  // From the real folder, never the absolute path the model may have sent.
  const title = titleOf(
    relativeTo(await realpathLoose(folder), await realpathLoose(target)) ?? path,
  );
  try {
    await thread.share({ name: basename(title), title, content });
  } catch (error) {
    if (!(error instanceof ChatError)) throw error;
    // The chat's own code, never the file or its path.
    logger.warning(`could not share a file for the model: ${errorName(error)}`);
    return fill(SHARE_REFUSED, { path: title, error: error.name });
  }
  // The chat clears a thread's status line when the app shares into it.
  thread.written();
  return fill(SHARE_DONE, { path: title });
}
