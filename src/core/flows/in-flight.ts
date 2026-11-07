/**
 * The prompts of the owner's that a provider handed over and that have not reached a session's
 * queue: a stop aborts them (`!stop`, the chat's Stop control), and each one that reads its
 * ticket's signal drops itself with `Not sent.`. Memory only.
 */
import type { ThreadRef } from "../../chat/seam.ts";
import { StoppedByOwner } from "../sessions/errors.ts";

/** One prompt on its way; `release` when it is submitted, dropped or failed (idempotent). */
export interface Ticket {
  readonly ref: ThreadRef;
  readonly signal: AbortSignal;
  release(): void;
}

export class InFlight {
  readonly #tickets = new Set<{ ticket: Ticket; abort: () => boolean }>();

  /** A ticket for a prompt of `ref`'s thread, taken synchronously when it is handed over. */
  take(ref: ThreadRef): Ticket {
    const controller = new AbortController();
    const entry = {
      ticket: {
        ref,
        signal: controller.signal,
        release: () => {
          this.#tickets.delete(entry);
        },
      },
      abort: () => {
        if (controller.signal.aborted) return false;
        controller.abort(new StoppedByOwner());
        return true;
      },
    };
    this.#tickets.add(entry);
    return entry.ticket;
  }

  /** Aborts every ticket of one thread, now; returns how many it aborted. */
  abortThread(ref: ThreadRef): number {
    return this.#abort((held) => held.channel === ref.channel && held.thread === ref.thread);
  }

  /** Aborts every ticket of one channel, now; returns how many it aborted. */
  abortChannel(channel: string): number {
    return this.#abort((held) => held.channel === channel);
  }

  #abort(matches: (ref: ThreadRef) => boolean): number {
    let count = 0;
    for (const { ticket, abort } of this.#tickets) {
      if (matches(ticket.ref) && abort()) count += 1;
    }
    return count;
  }
}
