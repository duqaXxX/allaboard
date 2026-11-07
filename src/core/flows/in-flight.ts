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
  readonly #tickets = new Set<{ ticket: Ticket; channelOnly: boolean; abort: () => boolean }>();

  /**
   * A ticket for a prompt of `ref`'s thread, taken synchronously when it is handed over.
   * `channelOnly` makes it answer to a stop of the channel and not to one of `ref`'s thread: the
   * bridge of a `!fork` between the original's ticket and the copy's, which the original's own
   * stop must not drop. `link` is a signal whose abort aborts this ticket too: the copy's ticket
   * follows the bridge.
   */
  take(
    ref: ThreadRef,
    options: { readonly channelOnly?: boolean; readonly link?: AbortSignal } = {},
  ): Ticket {
    const { channelOnly = false, link } = options;
    const controller = new AbortController();
    const entry = {
      channelOnly,
      ticket: {
        ref,
        signal: link === undefined ? controller.signal : AbortSignal.any([controller.signal, link]),
        release: () => {
          this.#tickets.delete(entry);
        },
      },
      abort: () => {
        // The ticket's real signal: a linked ticket the bridge already aborted is not counted again.
        if (entry.ticket.signal.aborted) return false;
        controller.abort(new StoppedByOwner());
        return true;
      },
    };
    this.#tickets.add(entry);
    return entry.ticket;
  }

  /** Aborts every ticket of one thread, now; returns how many it aborted. */
  abortThread(ref: ThreadRef): number {
    return this.#abort(
      (held, channelOnly) =>
        !channelOnly && held.channel === ref.channel && held.thread === ref.thread,
    );
  }

  /** Aborts every ticket of one channel, now; returns how many it aborted. */
  abortChannel(channel: string): number {
    return this.#abort((held) => held.channel === channel);
  }

  #abort(matches: (ref: ThreadRef, channelOnly: boolean) => boolean): number {
    let count = 0;
    for (const { ticket, channelOnly, abort } of this.#tickets) {
      if (matches(ticket.ref, channelOnly) && abort()) count += 1;
    }
    return count;
  }
}
