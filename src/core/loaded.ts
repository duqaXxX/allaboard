/**
 * `!memory` and `!skills`: what a live session has loaded, read only, as the terminal's
 * `/memory` and `/skills` panels list it. Each is one message for the owner alone.
 */
import { homedir } from "node:os";
import { sep } from "node:path";
import type { CommandInfo, LoadedContext } from "../agent/seam.ts";
import { oneLine } from "./commands.ts";
import { relativeTo } from "./files/paths.ts";
import * as texts from "./texts.ts";

const count = (n: number): string => n.toLocaleString("en-US");

/** `path` from the session's folder when it lies under it, else with the home written as `~`. */
function shownPath(path: string, directory: string, home: string): string {
  const inside = relativeTo(directory, path);
  if (inside !== null && inside !== "") return inside;
  return path === home || path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

/** The memory files a session loaded, each with its size; `shown` makes a path show as written. */
export function memoryText(
  loaded: LoadedContext,
  directory: string,
  shown: (text: string) => string,
  home = homedir(),
): string {
  const files = loaded.memoryFiles;
  if (files.length === 0) return texts.MEMORY_NONE;
  const total = files.reduce((sum, file) => sum + file.tokens, 0);
  return [
    texts.fill(texts.MEMORY_TITLE, { count: String(files.length), tokens: count(total) }),
    ...files.map((file) =>
      texts.fill(texts.MEMORY_LINE, {
        path: shown(shownPath(file.path, directory, home)),
        tokens: count(file.tokens),
      }),
    ),
  ].join("\n");
}

/**
 * The skills a session can use, each with the one-line description the agent gives its command
 * of the same name, or where it comes from when it gives none.
 */
export function skillsText(
  loaded: LoadedContext,
  commands: readonly CommandInfo[],
  shown: (text: string) => string,
): string {
  const skills = loaded.skills;
  if (skills.length === 0) return texts.SKILLS_NONE;
  const described = new Map(commands.map((command) => [command.name, command.description]));
  return [
    texts.fill(texts.SKILLS_TITLE, { count: String(skills.length) }),
    ...skills.map((skill) => {
      const description = oneLine(described.get(skill.name) ?? "");
      return texts.fill(texts.SKILLS_LINE, {
        name: shown(skill.name),
        about: shown(description || skill.source),
      });
    }),
  ].join("\n");
}
