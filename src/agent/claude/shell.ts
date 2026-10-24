/**
 * A shell command the owner ran, told to the session as the terminal's `!` bash mode tells it:
 * one user message of two text blocks, the command and its output (terminal transcripts of
 * Claude Code 2.1.296, 2.1.302 and 2.1.306, read 2026-10-24). Sent with a turn, so the session
 * answers it, as the terminal does with `respondToBashCommands` at its default (settings
 * reference, read 2026-10-24); the owner's own value of that setting is not readable through the
 * SDK.
 */
import type { PromptContent, ShellMode, ShellRun } from "../seam.ts";
import { sessionEnvironment } from "./session.ts";

// Claude Code's default for a foreground Bash command (environment variables page,
// `BASH_DEFAULT_TIMEOUT_MS`, "default: 120000", read 2026-10-24).
export const DEFAULT_TIMEOUT_MS = 120_000;

/** What the terminal would add for `run`; a run that did not end by itself says so in its stderr. */
export function shellPrompt(run: ShellRun): PromptContent {
  // The terminal's stdout carries no trailing line break; its stderr is kept as printed.
  const stdout = run.stdout.replace(/\n+$/, "");
  const note =
    run.end === "timedOut"
      ? `Command timed out after ${Math.round(run.seconds)} s`
      : run.end === "stopped"
        ? "Command stopped"
        : run.signal !== null
          ? `Command ended by ${run.signal}`
          : "";
  const stderr = note === "" ? run.stderr : `${run.stderr}${run.stderr === "" ? "" : "\n"}${note}`;
  return [
    { type: "text", text: `<bash-input>${run.command}</bash-input>` },
    {
      type: "text",
      text: `<bash-stdout>${stdout}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`,
    },
  ];
}

/**
 * The shell mode of a back end started with the owner's `variables`: the session's environment
 * and its Bash timeout, which a value Claude Code would not take leaves at its default.
 */
export function shellMode(variables: Readonly<Record<string, string>>): ShellMode {
  const written = Number(variables.BASH_DEFAULT_TIMEOUT_MS);
  return {
    timeoutMs: Number.isInteger(written) && written > 0 ? written : DEFAULT_TIMEOUT_MS,
    environment: sessionEnvironment(variables),
    prompt: shellPrompt,
  };
}
