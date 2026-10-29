/**
 * The few tools the terminal shows in words of its own, drawn from what the agent declares.
 *
 * Rendering stays generic: a tool the agent's `ToolVocabulary` does not name shows as its name,
 * counted when it ran more than once, and its line, with no change anywhere. For the tools it
 * names, the terminal writes a sentence or a preview instead, and `Previews` reproduces it from
 * what the agent's events carry. What a changing tool did to a file arrives as the seam's
 * `FileChange`, which a back end reads from the agent's own shape and gives as null for any
 * other: the generic line is shown then. An answered question is the exception: its lines come
 * from the questions and answers the daemon itself sent back (`answered`), not from a result.
 */
import type { DiffHunk, FileChange, Question, ToolVocabulary } from "../../agent/seam.ts";
import type { Preview } from "../../chat/seam.ts";
import {
  ANSWERED,
  fill,
  type Names,
  named,
  TASK_LAUNCHED,
  TASKS_LAUNCHED,
  TASKS_LAUNCHED_BRANCH,
  TASKS_LAUNCHED_LAST,
} from "../texts.ts";
import { oneLine, spaced, splitLines, TITLE_LIMIT } from "./words.ts";

// A diff line's colour where Slack draws none (mobile); an emoji is two columns wide, so a
// context line gets two spaces and the numbers stay aligned.
export const MARKS: Readonly<Record<string, string>> = {
  "-": "\u{1f7e5}",
  "+": "\u{1f7e9}",
  " ": "  ",
};
// The terminal shows a new file's first lines, then how many it leaves out.
export const NEW_FILE_LINES = 10;
/** A task started in the background, as its launch line names it. */
export interface Launch {
  /** The name of the call that started it. */
  readonly name: string;
  readonly agentType: string | null;
  readonly description: string;
  /** The name of the model the agent runs on when it is not the session's; null otherwise. */
  readonly model: string | null;
}

const RESUMING = "\u23bf Resuming agent {id}";
// The terminal names an agent by the first characters of its id.
const AGENT_ID_CHARS = 7;
const COMMAND_LIMIT = 200;

/** The line that says the task `taskId` is resumed. */
export function resuming(taskId: string): string {
  return fill(RESUMING, { id: taskId.slice(0, AGENT_ID_CHARS) });
}

function counted(n: number, noun = "line"): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The parts of a POSIX path as Python's `PurePosixPath` keeps them: no empty part, no `.`. */
function parts(path: string): string[] {
  return path.split("/").filter((part) => part !== "" && part !== ".");
}

/** The path as the terminal names it: relative to the session's folder when inside it. */
function shown(path: string, cwd: string | null): string {
  if (!cwd) return path;
  const base = parts(cwd);
  const inner = parts(path);
  const inside =
    path.startsWith("/") === cwd.startsWith("/") &&
    base.length <= inner.length &&
    base.every((part, index) => inner[index] === part);
  if (!inside) return path;
  return inner.slice(base.length).join("/") || ".";
}

/**
 * Lines added and removed, and the hunks numbered as the terminal numbers them: a removed line
 * by its old number, any other by its new one, `...` between hunks. The sign leads the line,
 * where Slack desktop's diff highlighting looks for it; a coloured square follows, since Slack
 * mobile does not highlight (both measured 2026-09-27): `-🟥 7 sette`, `+🟩 7 7`.
 */
function diff(
  hunks: readonly DiffHunk[],
): { added: number; removed: number; body: string[] } | null {
  let added = 0;
  let removed = 0;
  const rows: [number: number, text: string][] = [];
  for (const [index, hunk] of hunks.entries()) {
    let { oldStart: old, newStart: fresh } = hunk;
    if (index > 0) rows.push([0, "..."]);
    for (const line of hunk.lines) {
      const sign = line.charAt(0);
      const text = line.slice(1);
      if (sign === "-") {
        rows.push([old, `-${text}`]);
        old += 1;
        removed += 1;
      } else if (sign === "+") {
        rows.push([fresh, `+${text}`]);
        fresh += 1;
        added += 1;
      } else if (sign === " ") {
        rows.push([fresh, ` ${text}`]);
        old += 1;
        fresh += 1;
      } else if (sign !== "\\") {
        // `\ No newline at end of file` is about the line above: skipped
        return null;
      }
    }
  }
  const width = String(Math.max(0, ...rows.map(([n]) => n))).length;
  const body = rows.map(([n, text]) => {
    const sign = text.charAt(0);
    return n === 0 ? text : `${sign}${MARKS[sign]} ${String(n).padStart(width)} ${text.slice(1)}`;
  });
  return { added, removed, body };
}

function changed(added: number, removed: number): string {
  const said = added > 0 ? [`Added ${counted(added)}`] : [];
  if (removed > 0) {
    said.push(said.length > 0 ? `removed ${counted(removed)}` : `Removed ${counted(removed)}`);
  }
  return said.join(", ") || "No change";
}

/**
 * The answers to a question as the terminal keeps them: a line per question that has one,
 * `· question → answer`, a multi-select's answers joined by commas. Null with no answer.
 * `names` fill the title, which names who wrote the questions.
 */
export function answered(
  questions: readonly Pick<Question, "text">[],
  answers: Readonly<Record<string, string | readonly string[]>>,
  names: Names,
): Preview | null {
  const lines: string[] = [];
  for (const question of questions) {
    const answer = Object.hasOwn(answers, question.text) ? (answers[question.text] ?? "") : "";
    const said = typeof answer === "string" ? answer : answer.join(", ");
    if (said !== "") {
      // One line each, however the question or a typed answer was written.
      lines.push(`· ${spaced(question.text)} → ${spaced(said)}`);
    }
  }
  if (lines.length === 0) return null;
  return {
    title: named(ANSWERED, names),
    summary: "",
    body: lines.join("\n"),
    language: "",
    plain: true,
    record: true,
  };
}

/** Whether `input[key]` holds text, for a tool the vocabulary lists with that key. */
function inputText(
  keys: Readonly<Record<string, string>>,
  name: string,
  input: Readonly<Record<string, unknown>>,
): string | null {
  const said = Object.hasOwn(keys, name) ? input[keys[name] as string] : undefined;
  return typeof said === "string" && said.trim() !== "" ? said : null;
}

/**
 * What an agent's `ToolVocabulary` makes of its tools: the terminal's words for a call, the
 * calls a reply holds, the preview of a change and the plan an approval asks for. An agent that
 * declares nothing gets the generic view for every tool.
 */
export class Previews {
  readonly #tools: ToolVocabulary;

  constructor(tools: ToolVocabulary) {
    this.#tools = tools;
  }

  /**
   * Whether a reply holds a call of that tool until it ends: one that shows a preview of its
   * change, or a question the owner answers, which leaves a record in place of its card. A stream
   * cannot take back a card, and a call that ended well is its preview alone.
   */
  holds(name: string): boolean {
    return (
      Object.hasOwn(this.#tools.previews, name) ||
      this.#tools.askers.includes(name) ||
      this.launches(name)
    );
  }

  /**
   * Whether the tool starts a task. A reply holds a call of one until its task says how it runs:
   * in the background the terminal writes a line and no more (`launched`).
   */
  launches(name: string): boolean {
    return this.#tools.launchers.includes(name);
  }

  /**
   * The launch line of a task started in the background: the agent's type when it names one, else
   * the name of the call that started it, then what the task does.
   */
  launched(launch: Launch): string {
    const { name, agentType, description, model } = launch;
    const plain = agentType === null || agentType === this.#tools.plainAgentType;
    return fill(TASK_LAUNCHED, {
      name: plain ? name : (agentType as string),
      description: oneLine(description, TITLE_LIMIT),
      model: model === null ? "" : ` ${model}`,
    });
  }

  /**
   * The lines for the tasks one message started in the background: one task's own line, or for
   * several a count and what each does, with no name.
   */
  launchedTogether(launches: readonly Launch[]): string {
    const [only] = launches;
    if (only !== undefined && launches.length === 1) return this.launched(only);
    const lines = launches.map(({ description }, index) =>
      fill(index === launches.length - 1 ? TASKS_LAUNCHED_LAST : TASKS_LAUNCHED_BRANCH, {
        description: oneLine(description, TITLE_LIMIT),
      }),
    );
    return [fill(TASKS_LAUNCHED, { n: launches.length }), ...lines].join("\n");
  }

  /** Whether a failed call of that tool is counted in its run with the calls that ended well. */
  failsCounted(name: string): boolean {
    return this.#tools.failsCounted.includes(name);
  }

  /** The terminal's title for a call that runs, where it has one of its own; null for any other. */
  described(name: string, input: Readonly<Record<string, unknown>>): string | null {
    const said = inputText(this.#tools.described, name, input);
    return said === null ? null : oneLine(said, TITLE_LIMIT);
  }

  /**
   * The line a call the terminal times lists under its title (`$ sleep 20`); null for any other
   * call, and for one whose input holds no text there.
   */
  commandLine(name: string, input: Readonly<Record<string, unknown>>): string | null {
    const said = inputText(this.#tools.commanded, name, input);
    return said === null ? null : `$ ${oneLine(said, COMMAND_LIMIT)}`;
  }

  /** The task a call continues, when its tool is one that continues a task; null otherwise. */
  continued(name: string, input: Readonly<Record<string, unknown>>): string | null {
    const { continuers } = this.#tools;
    const to = Object.hasOwn(continuers, name) ? input[continuers[name] as string] : undefined;
    return typeof to === "string" && to !== "" ? to : null;
  }

  /**
   * How `n` finished calls of `name` read in a folded line. The terminal's words take a capital
   * only when they open the line (for example `Read 1 file, ran 4 shell commands`); a tool's name is its own.
   */
  folded(name: string, n: number, first = true): string {
    const { words } = this.#tools;
    const sentence = Object.hasOwn(words, name) ? words[name] : undefined;
    if (sentence === undefined) {
      return n === 1 ? name : `${name} ×${n}`;
    }
    const said = fill(n === 1 ? sentence[0] : sentence[1], { n });
    return first ? said : said.charAt(0).toLowerCase() + said.slice(1);
  }

  /**
   * The plan an approval for the plan tool asks for, as the text the agent wrote, without the
   * path of the file it may also name. Null for any other tool, and for an input that holds more
   * or less than the measured shape: Approve hands the agent the whole input, so an input that
   * could hide something behind the plan is shown whole, as any tool's is.
   */
  plan(name: string, input: Readonly<Record<string, unknown>>): string | null {
    const { plan } = this.#tools;
    if (plan === null || name !== plan.tool) return null;
    const text = input[plan.text];
    if (typeof text !== "string" || text.trim() === "") return null;
    return Object.keys(input).every((key) => plan.keys.includes(key)) ? text.trim() : null;
  }

  /**
   * The terminal's view of a finished call of a tool that changes files, from what it did to a
   * file, or null for any other tool and for a call that reports no change. `cwd` is the
   * session's folder.
   */
  preview(name: string, change: FileChange | null, cwd: string | null): Preview | null {
    if (change === null || !Object.hasOwn(this.#tools.previews, name)) return null;
    const path = shown(change.path, cwd);
    if (change.kind === "created") {
      if (change.content === null) return null;
      const lines = splitLines(change.content);
      const width = String(Math.min(lines.length, NEW_FILE_LINES)).length;
      const body = lines
        .slice(0, NEW_FILE_LINES)
        .map((line, index) => `${String(index + 1).padStart(width)} ${line}`);
      if (lines.length > NEW_FILE_LINES) body.push(`… +${counted(lines.length - NEW_FILE_LINES)}`);
      return {
        title: `${name}(${path})`,
        summary: `Wrote ${counted(lines.length)} to ${path}`,
        body: body.join("\n"),
        language: "",
        plain: false,
        record: false,
      };
    }
    if (change.hunks.length === 0) return null;
    const numbered = diff(change.hunks);
    if (numbered === null) return null;
    return {
      title: `${this.#tools.previews[name]}(${path})`,
      summary: changed(numbered.added, numbered.removed),
      body: numbered.body.join("\n"),
      language: "diff",
      plain: false,
      record: false,
    };
  }
}
