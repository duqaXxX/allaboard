/**
 * `allaboard setup`: the terminal wizard that writes an instance's `.env`. The flow is the core's
 * (refuse a file that exists, ask, check each answer and ask again when it is refused, list what
 * the file will hold, write it, offer the service); what to ask for the chat and the agent is each
 * module's (`ModuleSetup`), and how a line is read from the terminal is the host's (`Prompter`).
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, sep } from "node:path";
import { parseEnv } from "node:util";
import type { Check, ModuleSetup, SetupQuestion } from "../module-setup.ts";
import { errorCode } from "../values.ts";
import { allowedRootOf, ConfigError, REQUIRED, SELECTORS } from "./config.ts";
import { configDirOf, type Instance } from "./instance.ts";

/**
 * Reads from the terminal; null when the owner ends the wizard (Ctrl-C, end of input). Both clear
 * their own question once answered: the wizard prints the answer line.
 */
export interface Prompter {
  ask(message: string, secret: boolean): Promise<string | null>;
  /** One of `names` picked from a list, `preselected` first; the answer is cleared like the others. */
  choose(message: string, names: readonly string[], preselected: string): Promise<string | null>;
}

/** What one action of the service manager printed and its exit status. */
export interface ServiceReport {
  readonly code: number;
  readonly out: readonly string[];
  readonly err: readonly string[];
}

/** What the wizard needs of the machine. */
export interface WizardHost {
  /** The owner's home: the configuration folder derives from it, and `~` stands for it on screen. */
  readonly home: string;
  /** Whether stdin and stdout are a terminal. */
  readonly interactive: boolean;
  readonly prompter: Prompter;
  /** Installs and starts the instance's service; null where the system has no service manager. */
  readonly installService: (() => ServiceReport) | null;
}

export interface WizardOutput {
  out(text: string): void;
  err(text: string): void;
}

/** The status a shell reports for a process ended by Ctrl-C. */
export const INTERRUPTED = 130;

const [VARIABLE_ALLOWED_ROOT] = REQUIRED;

/** The variables the wizard itself writes: a test holds them against the core's own lists. */
export const CORE_VARIABLES: readonly string[] = [...SELECTORS, VARIABLE_ALLOWED_ROOT];

/** The chats and agents the owner picks from, by name, and the ones listed first. */
export interface SetupModules {
  readonly chats: Readonly<
    Record<string, { readonly setup?: (instance: Instance) => ModuleSetup }>
  >;
  readonly agents: Readonly<
    Record<string, { readonly setup?: () => ModuleSetup; readonly executable?: string }>
  >;
  readonly defaults: { readonly agent: string; readonly chat: string };
}

/** One `NAME=value` line, the value quoted when a bare one would not read back as written. */
function envLine(name: string, value: string): string {
  if (/[\r\n]/.test(value) || value.includes("${")) {
    throw new Error(`${name} cannot be written to .env: it holds a line break or "\${"`);
  }
  let written = value;
  if (/[\s#'"`]/.test(value)) {
    const quote = ['"', "'", "`"].find((mark) => !value.includes(mark));
    if (quote === undefined)
      throw new Error(`${name} cannot be written to .env: it holds every quote`);
    written = `${quote}${value}${quote}`;
  }
  return `${name}=${written}`;
}

/**
 * The text of a `.env` that holds `values` and nothing else. Reads it back through `parseEnv`, the
 * parser the daemon uses, and throws when a value does not come back as it went in.
 */
export function envText(values: Readonly<Record<string, string>>): string {
  const text = `${Object.entries(values)
    .map(([name, value]) => envLine(name, value))
    .join("\n")}\n`;
  const back = parseEnv(text);
  for (const [name, value] of Object.entries(values)) {
    if (back[name] !== value) throw new Error(`${name} does not read back from .env as written`);
  }
  return text;
}

/**
 * Creates `file` holding `text`, readable by its owner alone, and fails with `EEXIST` rather than
 * replace one that is there. The text goes to a temporary file in the same folder first and is
 * linked to its name, which is atomic and never overwrites; the temporary name is removed either
 * way. The text is flushed to disk before the link. On Windows Node ignores the modes (as `loadConfig` does not check them there).
 */
export function createPrivateFile(file: string, folder: string, text: string): void {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const temporary = join(folder, `.env.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeSync(descriptor, text);
      // On disk before the name exists: a power loss must not leave an empty .env that blocks setup.
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    linkSync(temporary, file);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // Never created: the write itself failed, and that error is the one to report.
    }
  }
}

/** Whether `path` exists; throws `Unreadable` for any failure but absence. */
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return false;
    throw new Unreadable(error);
  }
}

/** `exists` could not tell: the folder is not readable or the path is broken. */
class Unreadable extends Error {
  readonly reason: unknown;
  constructor(reason: unknown) {
    super("unreadable");
    this.reason = reason;
  }
}

/** `path` with the home written as `~`, keeping the system's separator after it. */
function shown(path: string, home: string): string {
  return path === home || path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

const instanceFlag = (instance: Instance): string =>
  instance.name === null ? "" : ` --instance ${instance.name}`;

/** What a secret answer shows on screen: never its length. */
const HIDDEN = "********";

/** The line that stands for an answered question: `? message shown   verdict`. */
function answerLine(message: string, shown: string, verdict: string): string {
  const head = [`?`, message, shown].filter((part) => part !== "").join(" ");
  return `${head}${verdict === "" ? "" : `   ${verdict}`}\n`;
}

/** Thrown inside the wizard when the owner ends it; never leaves `answerWizard`. */
class Ended extends Error {}

/**
 * Asks `message` until `check` accepts the answer, and returns the answer with what the check
 * set; `value` is what is written for the question's variable (the check's, else the answer). Null
 * when an optional question is skipped. Throws `Ended` when the owner ends the wizard.
 */
async function ask(
  host: WizardHost,
  output: WizardOutput,
  question: Pick<
    SetupQuestion,
    "variable" | "message" | "secret" | "optional" | "default" | "check"
  >,
): Promise<{ value: string; set: Readonly<Record<string, string>> } | null> {
  for (;;) {
    const typed = await host.prompter.ask(question.message, question.secret);
    if (typed === null) throw new Ended();
    const value = typed.trim() === "" ? (question.default ?? "") : typed.trim();
    const shown = question.secret ? HIDDEN : value;
    if (value === "") {
      if (question.optional) {
        output.out(answerLine(question.message, "skipped", ""));
        return null;
      }
      output.out(answerLine(question.message, "", "✖ Nothing was typed; this one is needed."));
      continue;
    }
    const checked = await question.check(value);
    if ("refusal" in checked) {
      output.out(answerLine(question.message, shown, `✖ ${checked.refusal}`));
      continue;
    }
    // Refused here, not at the write step after every token was pasted.
    const set = checked.set ?? {};
    const written = checked.value ?? value;
    try {
      envText({ ...set, [question.variable]: written });
    } catch (error) {
      output.out(
        answerLine(
          question.message,
          shown,
          `✖ ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      continue;
    }
    output.out(
      answerLine(question.message, shown, checked.note === undefined ? "✔" : `✔ ${checked.note}`),
    );
    return { value: written, set };
  }
}

/** The root question: the same rule the daemon applies when it starts. */
const ALLOWED_ROOT_QUESTION: SetupQuestion = {
  variable: VARIABLE_ALLOWED_ROOT,
  message: "Folder your projects live under (ALLOWED_ROOT):",
  secret: false,
  optional: false,
  check: async (answer): Promise<Check> => {
    try {
      allowedRootOf(answer);
      return {};
    } catch (error) {
      if (error instanceof ConfigError) return { refusal: error.message };
      throw error;
    }
  },
};

/** Ends the wizard for the owner's Ctrl-C: nothing is written. */
function cancelled(output: WizardOutput): number {
  output.out("\nCancelled: nothing was written.\n");
  return INTERRUPTED;
}

/** Asks which of `entries` to use, `preselected` first, and prints the answer line; null when ended. */
async function pick(
  host: WizardHost,
  output: WizardOutput,
  message: string,
  entries: Readonly<Record<string, unknown>>,
  preselected: string,
): Promise<string | null> {
  const chosen = await host.prompter.choose(message, Object.keys(entries), preselected);
  if (chosen === null) return null;
  output.out(answerLine(message, chosen, "✔"));
  return chosen;
}

/**
 * Asks `questions` in order, adding to `values`. A variable an earlier answer settled is not
 * asked; a check that sets a variable its question did not declare is a defect of the module.
 */
async function asked(
  questions: readonly SetupQuestion[],
  values: Record<string, string>,
  host: WizardHost,
  output: WizardOutput,
): Promise<void> {
  for (const question of questions) {
    if (Object.hasOwn(values, question.variable)) continue;
    const answered = await ask(host, output, question);
    if (answered === null) continue;
    const undeclared = Object.keys(answered.set).filter((name) => !question.sets?.includes(name));
    if (undeclared.length > 0) {
      throw new Error(
        `the check of ${question.variable} set ${undeclared.join(", ")} without declaring it in "sets"`,
      );
    }
    values[question.variable] = answered.value;
    Object.assign(values, answered.set);
  }
}

/**
 * Answers `allaboard setup` for `instance`: asks which chat and which agent to use and writes the
 * two selectors, asks what the chat needs, the allowed root, then what the agent needs, lists the
 * file's variables, writes `.env` and offers the service. Refuses before asking anything when
 * there is no terminal or the file exists; refuses after the two picks when the chosen chat
 * offers no setup. Returns the exit status: 0, 1 for a refusal or a failed write, 130 when the
 * owner ended it.
 */
export async function answerWizard(
  instance: Instance,
  modules: SetupModules,
  output: WizardOutput,
  host: WizardHost,
): Promise<number> {
  const refuse = (sentence: string): number => {
    output.err(`allaboard setup: ${sentence}\n`);
    return 1;
  };
  const { defaults } = modules;
  if (!host.interactive) return refuse("it needs a terminal to ask on.");
  const folder = configDirOf(instance, host.home);
  const file = join(folder, ".env");
  const name = shown(file, host.home);
  try {
    if (exists(file)) {
      return refuse(`${name} exists already. Edit it, or move it away to run setup again.`);
    }
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    return refuse(`cannot look at ${name} (${errorCode(error.reason) ?? "unknown error"}).`);
  }
  output.out(`\nallaboard setup: writes ${name}\n\n`);
  const [agentSelector, chatSelector] = SELECTORS;
  // A list of one is still shown: the owner sees what the build holds and confirms it.
  const chatName = await pick(
    host,
    output,
    `Chat (${chatSelector}):`,
    modules.chats,
    defaults.chat,
  );
  if (chatName === null) return cancelled(output);
  const agentName = await pick(
    host,
    output,
    `Agent (${agentSelector}):`,
    modules.agents,
    defaults.agent,
  );
  if (agentName === null) return cancelled(output);
  const chat = modules.chats[chatName] as SetupModules["chats"][string];
  if (chat.setup === undefined) {
    return refuse(`the chat ${chatName} offers no setup; write .env by hand (docs/setup.md).`);
  }
  const chatSetup = chat.setup(instance);
  const agentSetup = (modules.agents[agentName] as SetupModules["agents"][string]).setup?.();
  output.out("\n");
  for (const line of chatSetup.intro) output.out(`${line}\n`);
  output.out("\n");
  const values: Record<string, string> = {
    [agentSelector]: agentName,
    [chatSelector]: chatName,
  };
  // Secret is known from the question that asks for the variable, never from its value.
  const secrets = new Set(
    [...chatSetup.questions, ...(agentSetup?.questions ?? [])]
      .filter((q) => q.secret)
      .map((q) => q.variable),
  );
  try {
    await asked([...chatSetup.questions, ALLOWED_ROOT_QUESTION], values, host, output);
    if (agentSetup !== undefined) {
      for (const line of agentSetup.intro) output.out(`${line}\n`);
      await asked(agentSetup.questions, values, host, output);
    }
  } catch (error) {
    if (!(error instanceof Ended)) throw error;
    return cancelled(output);
  }
  output.out("\nThe file holds:\n");
  for (const [variable, value] of Object.entries(values)) {
    output.out(`  ${variable}=${secrets.has(variable) ? HIDDEN : shown(value, host.home)}\n`);
  }
  try {
    createPrivateFile(file, folder, envText(values));
  } catch (error) {
    return refuse(
      errorCode(error) === "EEXIST"
        ? `${name} appeared while you answered; nothing was changed.`
        : `could not write ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  output.out(
    `\nWrote ${name}${process.platform === "win32" ? "" : " (readable by you only)"}.\n\n`,
  );
  const later = `Start it with \`allaboard${instanceFlag(instance)}\`.\n`;
  if (host.installService === null) {
    output.out(later);
    return 0;
  }
  const message = "Start allaboard now and at every login?";
  const picked = await host.prompter.choose(message, ["Yes", "No"], "Yes");
  if (picked === null) {
    output.out("\nThe file is written; the service is not installed.\n");
    return INTERRUPTED;
  }
  output.out(answerLine(message, picked, "✔"));
  if (picked !== "Yes") {
    output.out(
      `Not installed. \`allaboard service install${instanceFlag(instance)}\` does it later.\n`,
    );
    return 0;
  }
  const report = host.installService();
  for (const line of report.out) output.out(`${line}\n`);
  for (const line of report.err) output.err(`${line}\n`);
  return report.code;
}
