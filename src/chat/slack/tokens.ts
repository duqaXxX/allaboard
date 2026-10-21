/**
 * The kind of each Slack token, told by its prefix. The one rule for the daemon's start and for
 * `allaboard setup`: a swapped pair is named before Slack is called.
 */

/** A token variable, the prefix of its kind and the sentence that names it. */
export const TOKEN_KINDS = {
  SLACK_BOT_TOKEN: { prefix: "xoxb-", message: "the Bot User OAuth Token (xoxb-...)" },
  SLACK_APP_TOKEN: { prefix: "xapp-", message: "the app-level token (xapp-...)" },
  SLACK_USER_TOKEN: { prefix: "xoxp-", message: "the User OAuth Token (xoxp-...)" },
} as const;

export type TokenVariable = keyof typeof TOKEN_KINDS;

/** The sentence that says `token` is not the kind `variable` takes, or null when it is. */
export function wrongKind(variable: TokenVariable, token: string): string | null {
  const kind = TOKEN_KINDS[variable];
  return token.startsWith(kind.prefix) ? null : `${variable} must be ${kind.message}`;
}
