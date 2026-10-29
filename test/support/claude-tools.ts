/**
 * The Claude vocabulary for the tests of the core and the chat that draw Claude's recorded tools
 * (`Bash`, `Edit`...). Kept here so those tests name the module through one support file.
 */
import { NAME, WORDS } from "../../src/agent/claude/backend.ts";
import { TOOLS } from "../../src/agent/claude/tools.ts";
import { Previews } from "../../src/core/reply/previews.ts";

export { TOOLS as CLAUDE_TOOLS };

/** What a renderer or a sink draws a Claude session's tools with. */
export const CLAUDE_PREVIEWS = new Previews(TOOLS);

/** The agent a Slack provider's texts name in a test of the Claude module through the core. */
export const CLAUDE_AGENT = { name: NAME, words: WORDS, tools: TOOLS };
