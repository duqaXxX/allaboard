/**
 * Commands typed as messages: `!word`. A few words are allaboard's own; any other
 * `!name args` is a Claude Code command, so a command a new Claude Code release adds works at once.
 *
 * `!` is the product's own prefix in every chat: it leaves the agent's own command prefix free
 * (`AgentWords.commandPrefix`) and works in a chat that never delivers a `/` message to a bot.
 */
import type { CommandInfo } from "../agent/seam.ts";
import type { CommandCandidate } from "../chat/seam.ts";
import { compareCodePoints, PY_SPACE, strip } from "../text.ts";
import { limitsPage } from "../version.ts";
import * as texts from "./texts.ts";

export interface Help {
  readonly kind: "help";
  /** Lowercase; empty lists everything. */
  readonly query: string;
}

export interface Bind {
  readonly kind: "bind";
  readonly path: string;
}

export interface Bypass {
  readonly kind: "bypass";
  readonly on: boolean;
}

export interface Plan {
  readonly kind: "plan";
  /** Null when the word came with a request, which it does not take. */
  readonly on: boolean | null;
}

export interface Status {
  readonly kind: "status";
}

export interface Stop {
  readonly kind: "stop";
}

/** `!memory`: the memory files the thread's session loaded, as the terminal's `/memory` lists them. */
export interface Memory {
  readonly kind: "memory";
}

/** `!skills`: the skills the thread's session can use, as the terminal's `/skills` lists them. */
export interface Skills {
  readonly kind: "skills";
}

/** `!fork [prompt]`: a copy of the session in a new thread of the channel, as the terminal's `/fork`. */
export interface Fork {
  readonly kind: "fork";
  /** What the copy starts on; empty when it waits for the owner's first message. */
  readonly prompt: string;
}

/** `!terminal`: the session moves to a terminal on the host, a running turn with it. */
export interface Terminal {
  readonly kind: "terminal";
}

export interface Resume {
  readonly kind: "resume";
  /** A session id or name; empty lists the sessions. */
  readonly target: string;
}

export interface Open {
  readonly kind: "open";
  /** A path or words in one; empty offers a picker. */
  readonly target: string;
}

export interface Tag {
  readonly kind: "tag";
  /** A name that satisfies `TAG_NAME`, as typed. */
  readonly name: string;
}

export interface Untag {
  readonly kind: "untag";
}

export interface DeleteThread {
  readonly kind: "delete-thread";
}

export interface Guide {
  readonly kind: "guide";
}

/** `!!command`: the terminal's `!` bash mode, run by the daemon once the owner confirms it. */
export interface Shell {
  readonly kind: "shell";
  /** As typed, line breaks kept; never empty. */
  readonly command: string;
}

export interface Allaboard {
  readonly kind: "allaboard";
  /** `show`: the version that runs and the latest; `update` offers the latest; `restart` restarts. */
  readonly action: "show" | "update" | "restart";
}

export interface Passthrough {
  readonly kind: "passthrough";
  readonly text: string;
}

export interface Invalid {
  readonly kind: "invalid";
}

// The daemon's own words, answered without Claude Code; a Passthrough goes to the session.
// `WORD` names each one, and test/core/commands.test.ts checks that the guide (`!guide`) and
// `!help` explain every one: a new word cannot ship without its line in both.
export type Word =
  | Help
  | Guide
  | Bind
  | Bypass
  | Plan
  | Status
  | Stop
  | Memory
  | Skills
  | Terminal
  | Fork
  | Resume
  | Open
  | Tag
  | Untag
  | DeleteThread
  | Allaboard
  | Shell
  | Invalid;
export type Command = Word | Passthrough;

/** The word each of the daemon's own commands is typed as; a new kind of `Word` fails to compile here. */
export const WORD = {
  help: "help",
  guide: "guide",
  bind: "bind",
  bypass: "bypass",
  plan: "plan",
  status: "status",
  stop: "stop",
  memory: "memory",
  skills: "skills",
  terminal: "terminal",
  fork: "fork",
  resume: "resume",
  open: "open",
  tag: "tag",
  untag: "untag",
  "delete-thread": "delete-thread",
  allaboard: "allaboard",
  // Typed `!!`: the `!` of the owner's words stands for the terminal's `/`, so `!!` stands for its `!`.
  shell: "!",
} as const satisfies Record<Exclude<Word["kind"], "invalid">, string>;

// The most of a command's description `!help` shows on its line: the core's own choice since
// `!help` listed the agent's commands, not a limit of any chat.
export const DESCRIPTION_LIMIT = 100;

/**
 * A thread's tag: 1 to 40 letters, digits, `.`, `_` or `-`, kept as typed. One rule for what
 * `!tag` accepts and for what a chat reads back as a tag.
 */
export const TAG_NAME = /^[\p{L}\p{N}._-]{1,40}$/u;

// Python's whitespace, which `strip` and `split` follow, is not JavaScript's `\s` (`text.ts`).
const TRAILING = new RegExp(`[${PY_SPACE}]+$`);
const STARTS_WITH_SPACE = new RegExp(`^[${PY_SPACE}]`);
const WORD_AND_REST = new RegExp(`^([^${PY_SPACE}]+)(?:[${PY_SPACE}]+([\\s\\S]*))?$`);
const RUNS_OF_SPACE = new RegExp(`[${PY_SPACE}]+`);

/**
 * Map a `!word` message to the daemon's own command or a Claude Code passthrough; null when the
 * message is not a command at all.
 */
export function parseBang(text: string): Command | null {
  const stripped = strip(text);
  if (!stripped.startsWith("!")) return null;
  const body = stripped.slice(1);
  if (body === "" || STARTS_WITH_SPACE.test(body)) return null;
  if (body.startsWith("!")) {
    const command = strip(body.slice(1));
    return command === "" ? { kind: "invalid" } : { kind: "shell", command };
  }
  // The word ends at any whitespace: a line break after it (a code block that follows the
  // word, a second line) separates it from its arguments as a space does.
  const split = WORD_AND_REST.exec(body);
  const word = split?.[1] ?? "";
  const rest = strip(split?.[2] ?? "");
  switch (word.toLowerCase()) {
    case "help":
      return { kind: "help", query: rest.toLowerCase() };
    case "guide":
      if (rest === "") return { kind: "guide" };
      break;
    case "bind":
      return { kind: "bind", path: rest }; // alone, it lists the folders a session can start in
    case "bypass":
      switch (rest.toLowerCase()) {
        case "on":
          return { kind: "bypass", on: true };
        case "off":
          return { kind: "bypass", on: false };
        default:
          return { kind: "invalid" };
      }
    case "plan":
      switch (rest.toLowerCase()) {
        case "":
        case "on":
          return { kind: "plan", on: true };
        case "off":
          return { kind: "plan", on: false };
        default:
          // A request sent with the word: the owner is told how plan mode is set, not the help.
          return { kind: "plan", on: null };
      }
    case "status":
      if (rest === "") return { kind: "status" };
      break;
    case "stop":
      if (rest === "") return { kind: "stop" };
      break;
    case "memory":
      if (rest === "") return { kind: "memory" };
      break;
    case "skills":
      if (rest === "") return { kind: "skills" };
      break;
    case "terminal":
      if (rest === "") return { kind: "terminal" };
      break;
    case "fork":
      return { kind: "fork", prompt: rest };
    case "resume":
      return { kind: "resume", target: rest };
    case "open":
      return { kind: "open", target: rest };
    case "tag":
      // Alone, or with a name the rule refuses, it is mistyped: the help shows how it is written.
      return TAG_NAME.test(rest) ? { kind: "tag", name: rest } : { kind: "invalid" };
    case "untag":
      // A thread has one tag, so `!untag devops` means `!untag`: what follows the word says
      // nothing more, and a word the owner typed must not reach the agent as a prompt.
      return { kind: "untag" };
    case "delete-thread":
      // Anything after it is a mistake: the help shows how it is written, and nothing is deleted.
      return rest === "" ? { kind: "delete-thread" } : { kind: "invalid" };
    case "allaboard":
      switch (rest.toLowerCase()) {
        case "":
          return { kind: "allaboard", action: "show" };
        case "update":
          return { kind: "allaboard", action: "update" };
        case "restart":
          return { kind: "allaboard", action: "restart" };
        default:
          return { kind: "invalid" };
      }
  }
  return { kind: "passthrough", text: strip(`${word} ${rest}`) };
}

/** Whether `text` is a `!` and nothing else: the owner asking for every command. */
export function isBangAlone(text: string): boolean {
  return strip(text) === "!";
}

/**
 * The daemon's words, then every command the session offers now (null: not bound yet) except
 * those its thread refuses (`refusedInThread`), keeping only the lines whose name or description
 * contains `query`, ignoring case. With no query, the rule that tells a command from a text comes
 * first. `escapeMarkdown` is the chat provider's escape for a markdown block; `names` fill the
 * texts that name the agent and the chat. An agent with no commands of its own
 * (`agentCommands` false) has none listed, and no line about where they are listed. An agent that
 * keeps no record of trust (`folderTrust` false) has a `!bind` line that speaks of none.
 */
export function helpText(
  commands: readonly CommandInfo[] | null,
  query: string,
  escapeMarkdown: (text: string) => string,
  names: texts.Names,
  agentCommands = true,
  unserved: ReadonlySet<string> = new Set(),
  folderTrust = true,
): string {
  const keep = (line: string): boolean => line.toLowerCase().includes(query.toLowerCase());
  // A word the agent or the chat cannot serve is not offered: its line is left out.
  const served = (line: string): boolean =>
    ![...unserved].some(
      (word) => line.startsWith(`\`!${word} `) || line.startsWith(`\`!${word}\``),
    );
  const own = (folderTrust ? texts.HELP_WORDS : texts.HELP_WORDS_ANY)
    .map((word) => texts.named(word, names))
    .filter(served)
    .filter(keep);
  const refused = refusedInThread(commands, names.newSession, agentCommands);
  const offered = (commands ?? []).filter((c) => !refused.has(c.name.toLowerCase()));
  const session = offered
    .toSorted((a, b) => compareCodePoints(a.name, b.name))
    .map((command) => commandParts(command, escapeMarkdown))
    .filter(([usage, description]) => keep(`${usage} ${description}`))
    .map(([usage, description]) => `${usage} ${escapeMarkdown(description)}`.replace(TRAILING, ""));
  // The rule heads the whole list; a search shows its matches alone.
  const lines = [texts.HELP_OWN, ...(query ? [] : [texts.HELP_RULE]), ...own];
  if (agentCommands && commands === null) {
    lines.push(texts.named(texts.HELP_UNBOUND, names));
  } else if (agentCommands) {
    lines.push(texts.named(texts.HELP_AGENT, names), ...session);
  }
  if (query && own.length === 0 && session.length === 0) {
    lines.push(texts.fill(texts.HELP_NO_MATCH, { query }));
  }
  return lines.join("\n");
}

/**
 * The answer to a command that is only ever run on the host (the agent's `login` and `logout`
 * names, in `names`), or null for any other, for a name the agent does not have, and for every one
 * when the agent has no commands of its own (`agentCommands` false): the caller sends that answer
 * and nothing to the agent. These commands act on the host's own login, which the daemon and
 * every session run on.
 */
export function hostOnly(
  command: Passthrough,
  names: texts.Names,
  agentCommands = true,
): string | null {
  if (!agentCommands) return null; // no command is the agent's, so none is run on the host
  const word = (command.text.split(" ", 1)[0] as string).toLowerCase();
  if (names.login !== null && word === names.login.toLowerCase()) {
    return texts.named(texts.LOGIN_ON_HOST, names);
  }
  if (names.logout !== null && word === names.logout.toLowerCase()) {
    return texts.named(texts.LOGOUT_ON_HOST, names);
  }
  return null;
}

/**
 * The answer to a command of the agent's terminal that a session from the chat does not offer
 * (`notOffered`, the agent's words), with what to do instead, or null: for any other name, for one
 * the session's own list (`offered`) has, and for every one when the agent has no commands of its
 * own (`agentCommands` false). The caller sends that answer and nothing to the agent.
 */
export function notOfferedAnswer(
  command: Passthrough,
  offered: readonly CommandInfo[],
  notOffered: Readonly<Record<string, string | null>>,
  names: texts.Names,
  agentCommands = true,
): string | null {
  if (!agentCommands) return null;
  const word = (command.text.split(" ", 1)[0] as string).toLowerCase();
  if (!Object.hasOwn(notOffered, word)) return null;
  if (offered.some((listed) => listed.name.toLowerCase() === word)) return null;
  const instead = notOffered[word] ?? null;
  return [
    texts.fill(texts.named(texts.NOT_OFFERED, names), { command: word }),
    ...(instead === null ? [] : [instead]),
    texts.fill(texts.NOT_OFFERED_SEE, { link: limitsPage() }),
  ].join(" ");
}

/**
 * The command names a thread refuses, lowercase: the agent's `newSession` names (one thread is
 * one session, and a thread is also the only place a session's commands are listed; they are
 * known before a session rebuilt after a restart connects), with every alias the session's own
 * list (`commands`, null or empty before it connects) gives one of them. None for an agent with
 * no commands of its own (`agentCommands` false).
 */
export function refusedInThread(
  commands: readonly CommandInfo[] | null,
  newSession: readonly string[],
  agentCommands = true,
): ReadonlySet<string> {
  if (!agentCommands) return new Set(); // an agent with no commands of its own has none to refuse
  const own = new Set(newSession.map((name) => name.toLowerCase()));
  const aliases = (commands ?? [])
    .filter((command) => own.has(command.name.toLowerCase()))
    .flatMap((command) => command.aliases.map((alias) => alias.toLowerCase()));
  return new Set([...own, ...aliases]);
}

/** `description` on one line, cut at `DESCRIPTION_LIMIT` code points (a unit-wise cut could split an emoji). */
export function oneLine(description: string): string {
  const joined = description
    .split(RUNS_OF_SPACE)
    .filter((word) => word !== "")
    .join(" ");
  const points = Array.from(joined);
  if (points.length <= DESCRIPTION_LIMIT) return joined;
  return `${points.slice(0, DESCRIPTION_LIMIT - 1).join("")}…`;
}

/**
 * `!name hint` and the description as written, cut to one short line; not escaped. The
 * description is third-party text, and a cut can fall inside its own code span: the caller
 * escapes it before showing it (`helpText`).
 */
export function commandParts(
  command: CommandInfo,
  escapeMarkdown: (text: string) => string,
): [usage: string, description: string] {
  const plain = `!${command.name} ${command.argumentHint}`.replace(TRAILING, "");
  // A code span cannot hold a backtick: such a usage is plain text, escaped.
  const usage = plain.includes("`") ? escapeMarkdown(plain) : `\`${plain}\``;
  const description = oneLine(command.description);
  return [usage, description];
}

/** A candidate with the other names that run it: they rank the command and are never shown. */
export interface Candidate extends CommandCandidate {
  readonly aliases: readonly string[];
}

/** How many nearest commands a mistyped word is offered. */
export const SUGGESTION_LIMIT = 5;
/** The most an edit distance may be for a command to be offered at all. */
const NEAR = 2;

/** The Levenshtein distance between two strings, over code points. */
function distance(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  let row = Array.from({ length: right.length + 1 }, (_, j) => j);
  for (const [i, from] of left.entries()) {
    const next = [i + 1];
    for (const [j, to] of right.entries()) {
      next.push(
        Math.min(
          (next[j] as number) + 1,
          (row[j + 1] as number) + 1,
          (row[j] as number) + (from === to ? 0 : 1),
        ),
      );
    }
    row = next;
  }
  return row[right.length] as number;
}

// The daemon's words a session's thread refuses (`!bind`, `!resume`, and `!allaboard update` or
// `restart`, which are what `!allaboard` is offered for): a suggestion made in a thread leaves
// them out.
const REFUSED_IN_THREAD: ReadonlySet<string> = new Set([WORD.bind, WORD.resume, WORD.allaboard]);

/**
 * The commands a typed `!word` could mean in a session's thread: the daemon's words that a thread
 * takes, then the session's commands (the names `refusedInThread` refuses left out), each as a
 * candidate whose pick puts `rest`, the arguments as typed, after its name; a word whose usage
 * takes no argument is offered bare. `unserved` and `folderTrust` are `helpText`'s. A command
 * the session lists under the name of a daemon word is the daemon's: the word is answered first.
 */
export function commandPool(
  commands: readonly CommandInfo[] | null,
  rest: string,
  names: texts.Names,
  options: {
    readonly unserved?: ReadonlySet<string>;
    readonly folderTrust?: boolean;
  } = {},
): Candidate[] {
  const { unserved = new Set(), folderTrust = true } = options;
  const text = (name: string): string => (rest === "" ? `!${name}` : `!${name} ${rest}`);
  const daemon = (folderTrust ? texts.HELP_WORDS : texts.HELP_WORDS_ANY)
    .map((word) => texts.named(word, names))
    .flatMap((line): Candidate[] => {
      // A help line opens with its usage in backticks, then says what the word does.
      const usage = /^`([^`]+)`\s*([\s\S]*)$/.exec(line);
      const name = usage?.[1]?.slice(1).split(" ", 1)[0];
      if (usage === null || name === undefined) return [];
      // `!!` is a syntax of its own, never what a mistyped `!word` meant.
      if (unserved.has(name) || REFUSED_IN_THREAD.has(name) || name === WORD.shell) return [];
      const bare = !(usage[1] as string).includes(" ");
      const described = (usage[2] as string).split(";", 1)[0] as string;
      return [
        {
          name,
          usage: usage[1] as string,
          description: oneLine(described),
          group: "daemon",
          text: bare ? `!${name}` : text(name),
          aliases: [],
        },
      ];
    });
  const taken = new Set(daemon.map((candidate) => candidate.name));
  const refused = refusedInThread(commands, names.newSession);
  const session = (commands ?? [])
    .filter((c) => !refused.has(c.name.toLowerCase()) && !taken.has(c.name.toLowerCase()))
    .toSorted((a, b) => compareCodePoints(a.name, b.name))
    .map(
      (c): Candidate => ({
        name: c.name,
        usage: `!${c.name} ${c.argumentHint}`.replace(TRAILING, ""),
        description: commandParts(c, (plain) => plain)[1],
        group: "agent",
        text: text(c.name),
        aliases: c.aliases,
      }),
    );
  return [...daemon, ...session];
}

/**
 * At most `SUGGESTION_LIMIT` of `pool` that `word` could mean, ignoring case: the names that
 * start with it, then those that contain it, then those within `NEAR` edits of it, nearest
 * first; a name or an alias counts. Within each rank the pool's order stands. An empty word
 * gives no candidate: the caller lists the whole pool then.
 */
export function rankCandidates(word: string, pool: readonly Candidate[]): Candidate[] {
  const wanted = word.toLowerCase();
  if (wanted === "") return [];
  const length = Array.from(wanted).length;
  const ranked: Array<readonly [rank: number, far: number, Candidate]> = [];
  for (const candidate of pool) {
    const forms = [candidate.name, ...candidate.aliases].map((form) => form.toLowerCase());
    if (forms.some((form) => form.startsWith(wanted))) ranked.push([0, 0, candidate]);
    else if (forms.some((form) => form.includes(wanted))) ranked.push([1, 0, candidate]);
    else {
      // A name whose length differs from the word's by more than `NEAR` is farther than that:
      // the distance is not computed for it.
      const close = forms.filter((form) => Math.abs(Array.from(form).length - length) <= NEAR);
      const near = Math.min(...close.map((form) => distance(wanted, form)));
      if (near <= NEAR) ranked.push([2, near, candidate]);
    }
  }
  // Stable: equal ranks keep the pool's order.
  return ranked
    .toSorted((a, b) => a[0] - b[0] || a[1] - b[1])
    .slice(0, SUGGESTION_LIMIT)
    .map(([, , candidate]) => candidate);
}
