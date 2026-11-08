/** The agent's last guess at the next prompt, per thread (`!next`): memory only, apart from the session. */
import { randomUUID } from "node:crypto";
import type { ThreadRef } from "../chat/seam.ts";

export interface Suggestion {
  readonly text: string;
  readonly id: string;
}

const keyOf = (ref: ThreadRef): string => `${ref.channel}\n${ref.thread}`;

export class Suggestions {
  readonly #held = new Map<string, Suggestion>();
  readonly #taken = new Map<string, string>();
  /** Set by the flows: whether a prompt of the owner's is on its way in a thread. */
  promptOnItsWay: (ref: ThreadRef) => boolean = () => false;

  /** Holds `text` under a fresh id, unless a prompt is on its way: that guess belongs to the turn before. */
  hold(ref: ThreadRef, text: string): void {
    if (this.promptOnItsWay(ref)) return;
    this.#held.set(keyOf(ref), { text, id: randomUUID() });
  }

  held(ref: ThreadRef): Suggestion | null {
    return this.#held.get(keyOf(ref)) ?? null;
  }

  take(ref: ThreadRef): Suggestion | null {
    const key = keyOf(ref);
    const found = this.#held.get(key) ?? null;
    this.#held.delete(key);
    if (found !== null) this.#taken.set(key, found.id);
    return found;
  }

  wasTaken(ref: ThreadRef, id: string): boolean {
    return this.#taken.get(keyOf(ref)) === id;
  }

  clear(ref: ThreadRef): void {
    this.#held.delete(keyOf(ref));
  }
}
