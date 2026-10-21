/**
 * What a module (an agent back end or a chat provider) tells `allaboard setup` to ask of the owner
 * to write its variables into `.env`. The types live here, outside both seams, because both seams
 * use them and a seam imports nothing of the core.
 */

/** What a check says of an answer: a sentence that refuses it, or that it holds. */
export type Check =
  | { readonly refusal: string }
  | {
      /** Shown after the tick: what the answer was found to be. */
      readonly note?: string;
      /** The text written for the question's own variable in place of the answer. */
      readonly value?: string;
      /**
       * Variables the answer settles besides its own; a question for one of them is not asked.
       * Each must be named in the question's `sets`, or the wizard refuses.
       */
      readonly set?: Readonly<Record<string, string>>;
    };

/** One question of a module's setup, and the check of its answer. */
export interface SetupQuestion {
  /** The variable of `.env` the answer is written to. */
  readonly variable: string;
  /** What is asked, without the leading `? `. */
  readonly message: string;
  /** Whether the answer is hidden as it is typed. */
  readonly secret: boolean;
  /** Whether an empty answer skips the variable. Ignored when `default` is set. */
  readonly optional: boolean;
  /**
   * The answer an empty line gives. The wizard shows it nowhere: the module says it in `message`.
   * The check judges it like a typed answer.
   */
  readonly default?: string;
  /** The other variables a check may set, declared so that a test can tell the setup covers them. */
  readonly sets?: readonly string[];
  /** Judges a trimmed, non-empty answer; may call out to the chat or the machine. */
  check(answer: string): Promise<Check>;
}

/** What a module asks of the owner to write its variables. */
export interface ModuleSetup {
  /** Printed before the first question: what to do outside the terminal, with the link. */
  readonly intro: readonly string[];
  readonly questions: readonly SetupQuestion[];
}
