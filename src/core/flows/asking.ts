/**
 * The questions the daemon and the agent put to the owner, and what follows each answer: a
 * tool's permission, the agent's questions, the same-folder hold, a session's setup.
 */
import { answersFlow } from "./answers.ts";
import type { AnswersFlow, HoldFlow, SetupFlow, TerminalFlow } from "./contract.ts";
import { holdFlow } from "./hold.ts";
import { setupFlow } from "./setup.ts";
import type { FlowDeps, Talk } from "./talk.ts";
import { terminalFlow } from "./terminal.ts";

/** The flows of this file, over one set of stores. */
export interface Asking {
  readonly setup: SetupFlow;
  readonly hold: HoldFlow;
  readonly terminal: TerminalFlow;
  readonly answers: AnswersFlow;
}

export function asking(deps: FlowDeps, talk: Talk): Asking {
  return {
    setup: setupFlow(deps, talk),
    hold: holdFlow(deps, talk),
    terminal: terminalFlow(deps, talk),
    answers: answersFlow(deps, talk),
  };
}
