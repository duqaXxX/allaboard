/**
 * The session's title on its thread's root: at the end of each turn the agent is asked for the
 * title it shows for the session (generated, or set by the owner), and the chat makes the root
 * show it. The root's own words are kept in `state.json` first (`rootPrompt`), for `!status`. Both
 * sides are optional capabilities; without either nothing happens.
 */
import { ChatError } from "../../chat/seam.ts";
import { getLogger } from "../../log.ts";
import { errorName } from "../../values.ts";
import type { SessionDeps } from "./deps.ts";

export const logger = getLogger("allaboard.core.sessions.title");

export class ThreadTitle {
  readonly #deps: Pick<SessionDeps, "agent" | "chat" | "state">;
  readonly #channel: string;
  readonly #thread: string;
  readonly #directory: string;
  // True once the daemon is stopping: a title resolving after that touches neither the chat nor
  // the state.
  readonly #stopped: () => boolean;
  // The last title the chat was given, in memory only: after a restart the first turn asks the
  // chat again, which skips an edit that would change nothing.
  #shown: string | null = null;
  // Reads of one thread run one after another, so a slow one cannot land after a newer one.
  #tail: Promise<void> = Promise.resolve();

  constructor(
    deps: Pick<SessionDeps, "agent" | "chat" | "state">,
    channel: string,
    thread: string,
    directory: string,
    stopped: () => boolean = () => false,
  ) {
    this.#stopped = stopped;
    this.#deps = deps;
    this.#channel = channel;
    this.#thread = thread;
    this.#directory = directory;
  }

  /**
   * Shows the session's current title on the root, once the earlier call is done. The promise
   * never rejects; a turn does not await it, so a title neither delays a turn nor fails it.
   */
  refresh(): Promise<void> {
    // Caught here as well as in `#show`: a rejected link would skip every later refresh.
    this.#tail = this.#tail
      .then(() => this.#show())
      .catch((error: unknown) => {
        logger.warning(
          `could not show the session's title of ${this.#channel}/${this.#thread}: ${errorName(error)}`,
        );
      });
    return this.#tail;
  }

  /**
   * The agent's title for the session `session`, or null when it has none or the agent offers
   * none (`sessionTitles`). Rejects when the agent cannot read it.
   */
  async read(session: string): Promise<string | null> {
    const { agent } = this.#deps;
    if (!agent.capabilities.sessionTitles || agent.sessionTitle === undefined) return null;
    return agent.sessionTitle(this.#directory, session);
  }

  async #show(): Promise<void> {
    const { chat, state } = this.#deps;
    // The agent's side is `read`'s: it answers null for an agent with no titles.
    if (!chat.capabilities.threadTitles || chat.titleThread === undefined) return;
    if (this.#stopped()) return;
    let title: string | null = null;
    let stored = false;
    try {
      const id = state.thread(this.#channel, this.#thread)?.sessionId;
      if (id === null || id === undefined) return;
      title = await this.read(id);
      if (title === null || title === this.#shown || this.#stopped()) return;
      const ref = { channel: this.#channel, thread: this.#thread };
      // What the root says is kept before the chat replaces it, so that no crash between the two
      // steps loses it: the chat reads the root once and runs `keep` before its edit. A stored
      // prompt, even an empty one, means the root was replaced already: it is never overwritten,
      // and a title is never kept as the prompt.
      // `keep` runs inside the chat's serialized task and stores only if nothing is stored by
      // then (`setRootPrompt` never replaces): a second session object for the thread, reading
      // the root after the first replaced it, keeps nothing.
      const keep =
        state.thread(this.#channel, this.#thread)?.rootPrompt === null
          ? (text: string) => {
              stored = state.setRootPrompt(this.#channel, this.#thread, text);
            }
          : undefined;
      await chat.titleThread(ref, title, keep);
      this.#shown = title;
    } catch (error) {
      // A refusal that cannot change is not asked again until the title does. If the words were
      // kept for this edit and the edit is refused for good, the root still holds them.
      if (error instanceof ChatError && error.permanent) {
        this.#shown = title;
        if (stored) state.clearRootPrompt(this.#channel, this.#thread);
      }
      // The name only: a title is the owner's content.
      logger.warning(
        `could not show the session's title of ${this.#channel}/${this.#thread}: ${errorName(error)}`,
      );
    }
  }
}
