import type { ModuleWords } from "../../module-setup.ts";

/**
 * What only the Slack module has, declared for `test/vocabulary.test.ts`. `names` are matched
 * anywhere in an identifier or a string; `literals` as a whole string, since `ts` or `blocks`
 * would hit plain English inside a longer one; `patterns` match the Web API's method names
 * (`chat.update`), which no file outside the module calls or names.
 */
export const MODULE_WORDS: ModuleWords = {
  names: ["bolt", "threadTs", "messageTs", "workspace", "mrkdwn", "modal", "ephemeral", "emoji"],
  literals: [
    "chat.update",
    "blocks",
    "team_id",
    "thread_ts",
    "ts",
    "channel_not_found",
    "reaction_added",
    "app_mention",
    "app_home_opened",
    "message_changed",
    "message_deleted",
    "block_actions",
    "view_submission",
    "Block Kit",
  ],
  patterns: [
    /^(chat|conversations|views|reactions|pins|files|users|apps|auth|assistant)\.[a-zA-Z]/,
  ],
};
