/**
 * The turns another process wrote to a session after a message the daemon's own process saved:
 * what a terminal did with a session while its thread was quiet. A process that loaded the
 * session before them never sees them, and its next message branches the conversation (measured
 * 2026-10-27, SDK 0.3.310 beside Claude Code 2.1.311); a resume reads them.
 *
 * The cheap look is the transcript's last message time (`listing.lastMessageMs`); only when it is
 * newer than the saved message is the conversation read, with the SDK's `getSessionMessages`.
 */
import { join } from "node:path";
import {
  type SessionMessage,
  getSessionMessages as sdkGetSessionMessages,
} from "@anthropic-ai/claude-agent-sdk";
import { isRecord } from "../../values.ts";
import type { ForeignTurn, ForeignTurns, SavedMessage } from "../seam.ts";
import { lastMessageMs, projectFolder } from "./listing.ts";

export type GetSessionMessages = typeof sdkGetSessionMessages;

// The prompt Claude Code writes for a slash command typed in the terminal (`<command-name>/x
// </command-name>`, with its arguments beside), read off transcripts of Claude Code 2.1.310.
const COMMAND_NAME = /<command-name>([^<]*)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([^<]*)<\/command-args>/;

/** The text parts of a message's content, joined; null when it has none. */
function texts(content: unknown, kind: "text"): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content.flatMap((block) =>
    isRecord(block) && block.type === kind && typeof block.text === "string" ? [block.text] : [],
  );
  return parts.length === 0 ? null : parts.join("\n");
}

function hasToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((b) => isRecord(b) && b.type === "tool_result");
}

/**
 * What the owner typed, as the terminal shows it, for a user message that opens a turn; null for
 * a message the owner did not type (a tool's result, a notification Claude Code injected).
 */
export function promptOf(message: SessionMessage): string | null {
  if (message.type !== "user" || !isRecord(message.message)) return null;
  const content = message.message.content;
  if (hasToolResult(content)) return null;
  const text = texts(content, "text");
  if (text === null) return null;
  const name = COMMAND_NAME.exec(text)?.[1]?.trim();
  if (name !== undefined) {
    const args = COMMAND_ARGS.exec(text)?.[1]?.trim() ?? "";
    return args === "" ? name : `${name} ${args}`;
  }
  // Claude Code's own tags (`<task-notification>`, `<local-command-stdout>`, reminders)
  return text.trimStart().startsWith("<") ? null : text;
}

/**
 * The messages after the saved one, as turns: each opened by a prompt the owner typed, with the
 * last text the agent wrote in it. A turn opened by anything else (a notification) is left out.
 */
export function turnsOf(messages: readonly SessionMessage[]): ForeignTurn[] {
  const turns: { prompt: string | null; reply: string | null }[] = [];
  for (const message of messages) {
    if (message.type === "user") {
      if (hasToolResult(isRecord(message.message) ? message.message.content : null)) continue;
      turns.push({ prompt: promptOf(message), reply: null });
    } else if (message.type === "assistant" && turns.length > 0 && isRecord(message.message)) {
      const text = texts(message.message.content, "text");
      const turn = turns.at(-1);
      if (turn !== undefined && text !== null && text.trim() !== "") turn.reply = text;
    }
  }
  return turns.flatMap((turn) =>
    turn.prompt === null ? [] : [{ prompt: turn.prompt, reply: turn.reply }],
  );
}

export interface TurnsOptions {
  /** Claude Code's projects folder for the login. */
  readonly projects: string;
  readonly getSessionMessages?: GetSessionMessages;
  readonly readStamp?: (path: string) => Promise<number | null>;
}

/** What was written to `session` of `folder` after `after`. Rejects when it cannot be read. */
export async function turnsAfter(
  folder: string,
  session: string,
  after: SavedMessage,
  options: TurnsOptions,
): Promise<ForeignTurns> {
  const project = await projectFolder(folder, options.projects);
  if (project === null) return { changed: false, turns: [], last: null };
  const stamp = await (options.readStamp ?? lastMessageMs)(join(project, `${session}.jsonl`));
  if (stamp === null || stamp <= after.at) return { changed: false, turns: [], last: null };
  const read = options.getSessionMessages ?? sdkGetSessionMessages;
  const messages = await read(session, { dir: folder });
  const final = messages.at(-1);
  const last = final === undefined ? null : { id: final.uuid, at: stamp };
  const index = messages.findIndex((message) => message.uuid === after.id);
  if (index === -1) return { changed: true, turns: [], last };
  const rest = messages.slice(index + 1);
  if (rest.length === 0) return { changed: false, turns: [], last: null };
  return { changed: true, turns: turnsOf(rest), last };
}
