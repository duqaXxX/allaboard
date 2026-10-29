/**
 * The memory chat: a second chat provider held in memory, for the tests of the seam. Its
 * capabilities are all false (no native streaming, no reactions, no activity line, no session
 * index, no file upload, no line for the owner alone) unless a test asks for command suggestions,
 * and it implements every required member of the chat seam for real. It is written against the seam and the core's port alone, and places the
 * footer and the list by a rule of its own model.
 *
 * `memoryChat()` is a registry entry that is also the handle on what the provider it builds
 * holds, and on the people a test plays:
 *
 *     const chat = memoryChat();
 *     const channel = chat.openChannel("work");
 *     // ... the daemon builds and starts the provider through `chat` ...
 *     const sent = await chat.as(OWNER).says(channel, "hello");  // top-level: opens a thread
 *     await chat.as(OWNER).says(channel, "more", { thread: sent.ref.thread });
 *     chat.texts(channel, sent.ref.thread);                      // what the thread shows
 *     chat.requests();                                           // what the owner can answer
 *     await chat.as(OWNER).answers(requestId, { type: "permission", allow: true });
 *     await chat.as(SOMEONE).says(channel, "hi");                // in the chat, never delivered
 *
 * Messages, threads and channels keep their names across a restart (build a new provider from
 * the same entry): the chat outlives the daemon.
 */
import type { ChatProvider } from "../../src/chat/seam.ts";
import type { ChatContext, ChatEntry } from "../../src/core/port.ts";
import { MemoryProvider } from "./memory-chat/provider.ts";
import { OWNER, Room } from "./memory-chat/room.ts";

export type {
  OpenList,
  OpenRequest,
  OpenSuggestion,
  Person,
  SaysOptions,
  Sent,
  ShownMessage,
} from "./memory-chat/room.ts";
export { DAEMON, ELSEWHERE, HOME, OWNER, SOMEONE } from "./memory-chat/room.ts";

export interface MemoryChatOptions {
  /** The owner's user id; `OWNER` when absent. */
  readonly owner?: string;
  /** The keys the provider reports (`ChatProvider.identities`); `[MEMORY_IDENTITY]` when absent. */
  readonly identities?: readonly string[];
  /** The provider declares `commandSuggestions` and shows a suggestion as a message. */
  readonly suggestions?: boolean;
  /**
   * How a thread is named: by a name of its own (the default, never the id of the message that
   * opened it), or by the id of its opening message (`opening`).
   */
  readonly threadIds?: "own" | "opening";
  /**
   * False for a chat that cannot rewrite a message once its reply ended: the list of what still
   * runs is not drawn, and the session's footer is a message of its own.
   */
  readonly edits?: boolean;
}

/** The identity of a memory chat given none. */
export const MEMORY_IDENTITY = "memory:daemon";

/** The registry entry of the memory chat, and the handle on its room. */
export class MemoryChat extends Room implements ChatEntry {
  readonly required: readonly string[] = [];
  readonly optional: readonly string[] = [];
  readonly limitsHeading = "Limits of the memory chat";
  readonly #identities: readonly string[];
  readonly #suggests: boolean;
  #built: MemoryProvider | null = null;

  constructor(
    owner: string,
    identities: readonly string[],
    suggests = false,
    threadIds: "own" | "opening" = "own",
    edits = true,
  ) {
    super(owner, threadIds, edits);
    this.#identities = identities;
    this.#suggests = suggests;
  }

  /** The provider `build` made last; throws before the first build. */
  get provider(): ChatProvider {
    if (this.#built === null) throw new Error("the memory chat is not built yet");
    return this.#built;
  }

  async build(context: ChatContext): Promise<ChatProvider> {
    this.bind(context.clock);
    this.#built = new MemoryProvider(this, this.#identities, this.#suggests);
    return this.#built;
  }
}

/** A memory chat with no channel yet. */
export function memoryChat(options: MemoryChatOptions = {}): MemoryChat {
  return new MemoryChat(
    options.owner ?? OWNER,
    options.identities ?? [MEMORY_IDENTITY],
    options.suggestions ?? false,
    options.threadIds ?? "own",
    options.edits ?? true,
  );
}
