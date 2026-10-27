/** Every flow of the core, built over one set of stores and wired to one another. */
import type { ListPick } from "../../chat/seam.ts";
import { asking } from "./asking.ts";
import type { OtherFlows } from "./contract.ts";
import { rootGone } from "./gone.ts";
import { Inbound } from "./inbound.ts";
import { lists } from "./lists.ts";
import { messages } from "./messages.ts";
import { type FlowDeps, Talk } from "./talk.ts";
import { updating } from "./update.ts";

export interface Built {
  /** What the chat provider calls when the owner did something. */
  readonly inbound: Inbound;
}

export function buildFlows(deps: FlowDeps): Built {
  const talk = new Talk(deps);
  const { setup, hold, terminal, answers } = asking(deps, talk);
  const { resume, bind, picks } = lists(deps, talk);
  const allaboard = deps.updates === undefined ? undefined : updating(deps, deps.updates, talk);
  const flows: OtherFlows = {
    setup,
    hold,
    terminal,
    resume,
    bind,
    ...(allaboard ? { allaboard } : {}),
  };
  const all = messages(deps, talk, flows);
  // A failure after the provider's checks reaches the owner in the channel of the offer; a click
  // on the chat's own page has none, and that page shows the state.
  const updatePicked = (pick: Extract<ListPick, { type: "update" }>): Promise<void> => {
    const { channel } = pick;
    if (allaboard === undefined) return Promise.resolve();
    return talk.replyOnFailure(
      { channel: channel ?? "page", thread: pick.list ?? "page" },
      () => allaboard.picked(pick),
      (told) => (channel === null ? Promise.resolve() : talk.inChannel(channel, told)),
    );
  };
  return {
    inbound: new Inbound({
      // The notice decides before the message is handled and is not waited for: the message
      // takes its place in its thread's line first (`messages.ts`), the line follows it.
      message: async (message) => {
        const told = allaboard?.notice(message);
        await Promise.all([told, all.message(message)]);
      },
      answer: (ref, requestId, answer, message) => answers.answer(ref, requestId, answer, message),
      picked: (pick) => (pick.type === "update" ? updatePicked(pick) : picks.picked(pick)),
      unbound: (channel) => talk.unbound(channel),
      rootGone: rootGone(deps),
    }),
  };
}
