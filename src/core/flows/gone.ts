/**
 * The first message of a thread was deleted in the chat: the thread is forgotten at once, as the
 * cleanup would forget it at its next pass (`core/cleanup.ts`). What the daemon wrote in the
 * thread stays; only what `state.json` keeps of it goes, `root_prompt` included. The provider
 * calls only for a thread the core keeps (`ChatInbound.rootGone`), so the core does not ask
 * again.
 */
import type { ThreadRef } from "../../chat/seam.ts";
import { errorName } from "../../values.ts";
import { type FlowDeps, logger } from "./talk.ts";

/** What follows `ChatInbound.rootGone`. */
export type RootGone = (ref: ThreadRef) => Promise<void>;

/**
 * The handler of a deleted first message: holds the thread, closes its session and removes its
 * entry, then frees the hold it took. Does nothing for a thread already held (a delete under way)
 * or in use, or while the daemon stops; the cleanup forgets those at its next pass.
 */
export function rootGone(deps: FlowDeps): RootGone {
  const { sessions, state, stopped } = deps;

  return async ({ channel, thread }) => {
    // Held by a delete already under way (`!delete-thread`, the Home tab's Delete): that delete
    // removes the entry itself, and the event is its own deletion coming back. The hold is its
    // to free, never this call's.
    if (sessions.held(channel, thread)) return;
    // The thread is held until the entry is gone: a message sent in it meanwhile finds no
    // session and none is rebuilt from the entry (`SessionManager.hold`, as a delete does). A
    // refusal took no hold, so nothing is freed for it.
    if (!sessions.hold(channel, thread)) {
      // A turn is running, or the daemon is stopping. The cleanup forgets the thread at its next
      // pass, since a tombstoned root is gone for it too.
      logger.info(
        stopped.aborted
          ? `left ${channel}/${thread} to the next start's cleanup: its first message was deleted`
          : `left ${channel}/${thread} to the cleanup: its first message was deleted while it works`,
      );
      return;
    }
    try {
      await sessions.closeHeld(channel, thread);
      state.removeThread(channel, thread);
      logger.info(`forgot ${channel}/${thread}: its first message was deleted`);
    } catch (error) {
      logger.warning(`could not forget ${channel}/${thread}: ${errorName(error)}`);
    } finally {
      sessions.free(channel, thread);
    }
  };
}
