/**
 * The names the daemon's texts take when Claude and Slack are the two modules, written out:
 * what a test fills a text with to compare it with what the owner reads. They are literals on
 * purpose: read from the modules, a wrong name there would pass every comparison.
 */
import type { Names } from "../../src/core/texts.ts";

/** Claude Code's names, for the tests of the Claude module. */
export const NAMES: Names = {
  agent: "Claude Code",
  author: "Claude",
  cli: "claude",
  chat: "Slack",
  examples: "`!compact`, `!model opus`",
  login: "login",
  logout: "logout",
  newSession: ["clear", "reset", "new"],
};

/** The plain agent's names (`PLAIN_WORDS`), for the tests of the core and the chat. */
export const PLAIN_NAMES: Names = {
  agent: "Plain",
  author: "Plain",
  cli: "plain",
  chat: "Slack",
  examples: "`!echo hello`, `!count one two`",
  login: "signin",
  logout: "signout",
  newSession: ["restart"],
};
