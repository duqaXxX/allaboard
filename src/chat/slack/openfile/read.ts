/**
 * What `!open` hands to Slack: the bytes the core read, shared into the thread. Which path may be
 * read is the core's (`src/core/files/read.ts`).
 */
import { posix } from "node:path";
import type { WebClient } from "@slack/web-api";
import { looksBinary, titleOf } from "../../../core/port.ts";

// Slack's documented limit for a snippet: `snippet_too_large` on `files.getUploadURLExternal`
// (docs.slack.dev/reference/methods/files.getUploadURLExternal, read 2026-10-05).
export const SNIPPET_LIMIT = 1 << 20;

/**
 * Shares `content`, the bytes `readOpenable` read from `relative`, into the thread: the basename as
 * the file's name and the path from the folder as its title, nothing posted on success. Rejects
 * with Slack's error.
 *
 * `@slack/web-api` 8.2.0 types `content` as a string (`FileUploadStringContents`,
 * `types/request/files.d.ts`) and encodes it as UTF-8, which would damage a binary file; its
 * `file` field takes a `Buffer` as the bytes (a `string` there is a path read from disk,
 * `dist/file-upload.js` `getFileData`). A Buffer is what is passed.
 */
export async function uploadFile(
  client: WebClient,
  channel: string,
  threadTs: string,
  content: Buffer,
  relative: string,
): Promise<void> {
  const title = titleOf(relative);
  await shareFile(client, channel, threadTs, content, posix.basename(title), title);
}

/**
 * Shares `content` into the thread as the file `filename`, shown under `title`: the form of
 * `uploadFile` for a file that is no path of the folder (`!diff` shares a patch). Rejects with
 * Slack's error. Resolves with the file's id, null when Slack's answer holds none.
 */
export async function shareFile(
  client: WebClient,
  channel: string,
  threadTs: string,
  content: Buffer,
  filename: string,
  title: string,
): Promise<string | null> {
  // Slack types a `.ts` by its own guess: a file of 256 KB came out `Binary` (seen 2026-10-31).
  // Video shares these extensions, which is what the bytes rule out.
  const typescript = /\.[cm]?ts$|\.tsx$/i.test(filename) && !looksBinary(content);
  const done = await client.files.uploadV2({
    channel_id: channel,
    thread_ts: threadTs,
    file: content,
    filename,
    title,
    ...(typescript && { snippet_type: "typescript" }),
  });
  // The id sits one level down: the upload's result lists the answer of each file's completion.
  // `files.uploadV2` is typed as a bare result; `filesUploadV2`, which it is bound to, adds `files`.
  const { files } = done as Awaited<ReturnType<WebClient["filesUploadV2"]>>;
  return files?.[0]?.files?.[0]?.id ?? null;
}
