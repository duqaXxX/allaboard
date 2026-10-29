/**
 * What `!rewind` remembers of a thread, in memory: which messages each prompt's replies wrote (the
 * messages a rewind folds), and the prompt a rewind cut the conversation at until a prompt is sent
 * after it. Nothing is stored in `state.json` (invariant 3): after a restart of the daemon the
 * replies of earlier turns are not known, and a rewind does not fold them.
 */
import type { MessageId, Reply } from "../../chat/seam.ts";

// The prompts kept; the oldest go. The terminal keeps 100 checkpoints; replies hold their text, so
// the memory bound is what `TURN_CHANGES_KEPT` uses for the edits.
export const REPLIES_KEPT = 50;

interface Entry {
  readonly prompt: string;
  /** Live replies, asked for their messages when a rewind needs them. */
  replies: Set<Reply>;
  /** The messages of replies let go of (`settle`). */
  ids: MessageId[];
}

export class RewindMemory {
  private readonly entries: Entry[] = [];

  /**
   * The prompt a rewind cut the conversation at, until a prompt is sent after the cut: the agent
   * keeps a cut only once something is written after it, so every start before that asks for it
   * again. Null when no cut waits.
   */
  cutAt: string | null = null;

  /** The agent's token for the conversation as the cut found it (`AgentSession.rewindToken`). */
  token: string | null = null;

  /** No cut waits any more: it was kept, or it can no longer be asked for. */
  drop(): void {
    this.cutAt = null;
    this.token = null;
  }

  /** Nothing is remembered, and no cut waits. */
  get empty(): boolean {
    return this.entries.length === 0 && this.cutAt === null;
  }

  /** A turn begins for the prompt `prompt`, writing into `reply`. */
  begin(prompt: string, reply: Reply): void {
    if (reply.posted === undefined) return;
    this.entries.push({ prompt, replies: new Set([reply]), ids: [] });
    if (this.entries.length > REPLIES_KEPT) this.entries.shift();
  }

  /** A turn the agent started writes into `reply`: it belongs to the prompt before it. */
  add(reply: Reply): void {
    const last = this.entries.at(-1);
    if (last === undefined || reply.posted === undefined) return;
    if (this.entries.some((entry) => entry.replies.has(reply))) return;
    last.replies.add(reply);
  }

  /** Whether the replies of any of the prompts `ids` were remembered. */
  knows(ids: readonly string[]): boolean {
    return this.entries.some((entry) => ids.includes(entry.prompt));
  }

  /** The messages the replies of the prompts `ids` wrote, oldest first. */
  messagesOf(ids: readonly string[]): MessageId[] {
    const seen = new Set<MessageId>();
    for (const entry of this.entries) {
      if (!ids.includes(entry.prompt)) continue;
      for (const id of entry.ids) seen.add(id);
      for (const reply of entry.replies) for (const id of reply.posted?.() ?? []) seen.add(id);
    }
    return [...seen];
  }

  /** Forgets the prompts `ids`: their replies are folded. */
  forgetIds(ids: readonly string[]): void {
    for (let at = this.entries.length - 1; at >= 0; at -= 1) {
      if (ids.includes(this.entries[at]?.prompt ?? "")) this.entries.splice(at, 1);
    }
  }

  /** Replaces the replies by their messages, so that a closed session holds no reply's text. */
  settle(): void {
    for (const entry of this.entries) {
      for (const reply of entry.replies) {
        for (const id of reply.posted?.() ?? []) if (!entry.ids.includes(id)) entry.ids.push(id);
      }
      entry.replies = new Set();
    }
  }
}
