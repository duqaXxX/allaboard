/** Whether a folder can hold a session, the folder a typed path names, and `!status`'s terminal line. */
import { realpathSync, statSync } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";
import type { AgentBackend, Repository } from "../../agent/seam.ts";
import { shellQuote } from "../../text.ts";
import { errorCode } from "../../values.ts";
import { untrustedRepositories } from "../files/listing.ts";
import { ABSENT, expandUser, resolvePath } from "../paths.ts";
import * as texts from "../texts.ts";
import { DirectoryMissing, DirectoryUnreadable, DirectoryUntrusted } from "./errors.ts";

/**
 * `agent`'s record of trust as `checkDirectory` and the folder list read it. An agent that
 * keeps none (`folderTrust`) has no gate to start a session behind: every folder counts.
 */
export function trustedBy(agent: AgentBackend): (folder: string) => Promise<boolean> {
  return async (folder) => !agent.capabilities.folderTrust || agent.folderTrusted(folder);
}

/**
 * `agent`'s answer for the repository holding a folder when the daemon's own git may run in it:
 * the one lookup behind the footer and `!open`. Null for an agent with no record of trust
 * (`folderTrust`): the daemon's git runs in no folder then.
 */
export function repositoryBy(agent: AgentBackend): (folder: string) => Promise<Repository | null> {
  return async (folder) =>
    agent.capabilities.folderTrust ? agent.trustedRepository(folder) : null;
}

/**
 * What tells the owner which repositories below `folder` still need `agent`'s trust before the
 * footer and `!open` read them, each with the shell line that asks for it at its
 * key; nothing for an agent that keeps no record of trust. Rejects as the lookups do.
 */
export async function untrustedNotice(
  agent: AgentBackend,
  folder: string,
  names: texts.Names,
  escapeMarkup: (text: string) => string,
): Promise<string[]> {
  const template = agent.words.trust;
  if (!agent.capabilities.folderTrust || template === null) return [];
  const found = await untrustedRepositories(folder, repositoryBy(agent), (directory) =>
    agent.untrustedRepository(directory),
  );
  return untrustedLines(
    template,
    found.map((repository) => repository.key),
    names,
    escapeMarkup,
  );
}

/**
 * Rejects with the `DirectoryUnavailable` that keeps a session from starting in `directory`,
 * the first found in the order the owner can act on: missing, unreadable, untrusted.
 */
export async function checkDirectory(
  directory: string,
  trusted: (folder: string) => Promise<boolean>,
  names: texts.Names,
): Promise<void> {
  // One stat and one directory open on a local folder, as a session start always made them.
  // A folder the daemon is not let into is unreadable at either: at the stat when a folder
  // above it is closed, at the open when it is closed itself. Both say `DirectoryUnreadable`.
  try {
    if (!(await stat(directory)).isDirectory()) throw new DirectoryMissing(directory);
    await (await opendir(directory)).close();
  } catch (error) {
    const code = errorCode(error);
    if (code === "EACCES" || code === "EPERM") throw new DirectoryUnreadable(directory);
    // A path with a null in it is one Node refuses to look at: it names no folder.
    if (code !== undefined && (ABSENT.has(code) || code === "ERR_INVALID_ARG_VALUE")) {
      throw new DirectoryMissing(directory);
    }
    throw error;
  }
  if (!(await trusted(directory))) throw new DirectoryUntrusted(directory, names);
}

/** Whether `path` is `root` or lies under it. */
function under(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Why a typed path names no folder a channel can be bound to. */
export type Refusal = "missing" | "file" | "outside";

/**
 * The real directory `raw` names when it exists under `root`, or why it does not; guards
 * against a typo only.
 */
export function resolveDirectory(
  raw: string,
  root: string,
): { readonly directory: string } | { readonly refused: Refusal } {
  // A relative path is read under the root: the daemon's own working directory means nothing
  // to the owner (launchd starts it in `/`).
  const written = expandUser(raw);
  try {
    // Joined as text: the disk follows a link before a `..`.
    const path = resolvePath(isAbsolute(written) ? written : `${root}/${written}`);
    if (!under(path, root)) return { refused: "outside" };
    if (!statSync(path).isDirectory()) return { refused: "file" };
    // The kernel is asked too, since a session runs in the folder it reaches: whatever the
    // reading above made of the spelling, that folder lies under the root or is refused.
    return under(realpathSync.native(path), realpathSync.native(root))
      ? { directory: path }
      : { refused: "outside" };
  } catch {
    return { refused: "missing" }; // it names nothing, or goes through a loop of links
  }
}

/**
 * The `!status` line with the command that forks a session in the terminal (the agent's
 * `words.terminal`, `template`), run from the thread's folder, where `!resume` in its channel
 * then finds the fork. `escapeMarkup` is the chat's, for a reference (`ChatProvider.escape`).
 */
export function terminalLine(
  template: string,
  directory: string,
  sessionId: string,
  escapeMarkup: (text: string) => string,
): string {
  const command = texts.fill(template, {
    directory: shellQuote(directory),
    session: sessionId,
  });
  return texts.fill(texts.STATUS_TERMINAL, { command: commandShown(command, escapeMarkup) });
}

/** The repositories `untrustedLines` names at most; the rest are counted. */
export const UNTRUSTED_ROWS = 10;

/**
 * What tells the owner which of `roots` still need the agent's trust, each with the shell line
 * that asks for it there (the agent's `words.trust`, `template`); empty with no root.
 */
export function untrustedLines(
  template: string,
  roots: readonly string[],
  names: texts.Names,
  escapeMarkup: (text: string) => string,
): string[] {
  if (roots.length === 0) return [];
  const lines = roots
    .slice(0, UNTRUSTED_ROWS)
    .map((root) =>
      commandShown(texts.fill(template, { directory: shellQuote(root) }), escapeMarkup),
    );
  if (roots.length > UNTRUSTED_ROWS) {
    lines.push(texts.fill(texts.UNTRUSTED_MORE, { count: roots.length - UNTRUSTED_ROWS }));
  }
  return [texts.named(texts.UNTRUSTED_REPOSITORIES, names), ...lines];
}

/** A shell line as a code span, which cannot hold a backtick: such a line is plain text, escaped. */
export function commandShown(command: string, escapeMarkup: (text: string) => string): string {
  return command.includes("`") ? escapeMarkup(command) : `\`${command}\``;
}
