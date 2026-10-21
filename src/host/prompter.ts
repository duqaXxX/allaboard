/**
 * Reads one answer from the terminal for `allaboard setup`, with `@inquirer/password` for a secret
 * (it shows an asterisk for each character), `@inquirer/input` for any other answer and
 * `@inquirer/select` for every pick from a list (the chat, the agent, the yes or no). Each prompt clears itself once answered: the wizard
 * prints the answer line, so the terminal holds one line per answer whatever the length of the
 * token. All of them end without an answer when the owner presses Ctrl-C or Ctrl-D, and so does
 * the end of the input.
 */

/** The prefix of a question waiting for its answer; the answered question is cleared, not drawn. */
const THEME = { prefix: { idle: "?", done: "" } };

/**
 * Runs `prompt` with a signal that aborts on Ctrl-D and on the end of the input, and returns null
 * when it ends that way or by Ctrl-C. The library settles only on Ctrl-C or process exit, which is
 * why the other two are listened for here.
 */
async function until<T>(
  prompt: (context: { signal: AbortSignal; clearPromptOnDone: true }) => Promise<T>,
): Promise<T | null> {
  const ended = new AbortController();
  const onEnd = (): void => ended.abort();
  const onKey = (_text: unknown, key: { ctrl?: boolean; name?: string } | undefined): void => {
    if (key?.ctrl === true && key.name === "d") ended.abort();
  };
  process.stdin.once("end", onEnd);
  process.stdin.on("keypress", onKey);
  try {
    return await prompt({ signal: ended.signal, clearPromptOnDone: true });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "ExitPromptError" || error.name === "AbortPromptError")
    ) {
      return null;
    }
    throw error;
  } finally {
    process.stdin.off("end", onEnd);
    process.stdin.off("keypress", onKey);
  }
}

/** The line typed after `message`, or null when the owner ended the wizard. */
export async function askTerminal(message: string, secret: boolean): Promise<string | null> {
  // Loaded here: the daemon starts through this graph and never needs the prompt library.
  if (secret) {
    const { default: password } = await import("@inquirer/password");
    // A token stays hidden, so the show-it key and its tip go. The mask is a single character
    // per keystroke; the answer line the wizard prints shows a fixed one.
    return until((context) =>
      password({ message, mask: "*", toggleMask: false, theme: THEME }, context),
    );
  }
  const { default: input } = await import("@inquirer/input");
  return until((context) => input({ message, theme: THEME }, context));
}

/** The name the owner picks from `names` (arrow keys, Enter), `preselected` first; null when they ended the wizard. */
export async function chooseTerminal(
  message: string,
  names: readonly string[],
  preselected: string,
): Promise<string | null> {
  const { default: select } = await import("@inquirer/select");
  return until((context) =>
    select(
      {
        message,
        choices: [preselected, ...names.filter((name) => name !== preselected)],
        default: preselected,
        theme: THEME,
      },
      context,
    ),
  );
}
