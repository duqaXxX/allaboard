/**
 * `!next`: the agent's suggested next prompt, offered with Send and Cancel. Send sends the shown
 * text as a typed prompt (`sendPrompt`). The offer holds nothing open, so it never blocks the thread.
 */
import type { ListPick, ThreadRef } from "../../chat/seam.ts";
import { getLogger } from "../../log.ts";
import { errorName } from "../../values.ts";
import { quoted } from "../reply/words.ts";
import type { ThreadSession } from "../sessions/session.ts";
import * as texts from "../texts.ts";
import { named } from "../texts.ts";
import type { NextFlow } from "./contract.ts";
import type { SendPrompt } from "./fork.ts";
import type { InFlight } from "./in-flight.ts";
import type { FlowDeps, Talk } from "./talk.ts";

const logger = getLogger("allaboard.core.flows.next");

export function nextFlow(
  deps: FlowDeps,
  talk: Talk,
  send: SendPrompt,
  inFlight: InFlight,
): NextFlow {
  const { sessions, state, names, chat, agent } = deps;
  const { suggestions } = sessions;

  async function picked(pick: Extract<ListPick, { type: "suggestion" }>): Promise<void> {
    const { ref } = pick;
    const thread = talk.thread(ref);
    if (!pick.send) {
      await thread.withdraw(pick.list);
      return;
    }
    await talk.replyOnFailure(ref, async () => {
      if (suggestions.wasTaken(ref, pick.id)) return;
      const held = suggestions.held(ref);
      if (
        state.thread(ref.channel, ref.thread)?.sessionId !== pick.session ||
        held === null ||
        held.id !== pick.id
      ) {
        await thread.rewrite(pick.list, texts.NEXT_NOT_SENT);
        return;
      }
      suggestions.take(ref);
      const ticket = inFlight.take(ref);
      try {
        const sending = send(ref, held.text, ticket);
        const shown = thread
          .rewrite(pick.list, quoted(chat.escape(held.text, "notice")))
          .catch((error: unknown) => {
            logger.warning(`could not rewrite a suggestion's offer: ${errorName(error)}`);
          });
        try {
          await sending;
        } finally {
          await shown;
        }
      } finally {
        ticket.release();
      }
    });
  }

  return {
    async word(ref: ThreadRef, _session: ThreadSession) {
      if (!agent.capabilities.nextPrompts || talk.thread(ref).offer === undefined) {
        await talk.tell(ref, named(texts.NEXT_UNAVAILABLE, names));
        return;
      }
      const held = suggestions.held(ref);
      const sessionId = state.thread(ref.channel, ref.thread)?.sessionId;
      if (held === null || sessionId === null || sessionId === undefined) {
        await talk.tell(ref, named(texts.NEXT_NONE, names));
        return;
      }
      const list = {
        type: "suggestion",
        session: sessionId,
        id: held.id,
        text: held.text,
      } as const;
      await talk.thread(ref).offer?.(list, texts.NEXT_TITLE);
    },
    picked,
  };
}
