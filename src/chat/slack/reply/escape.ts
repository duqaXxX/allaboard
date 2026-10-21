/**
 * Third-party text shown as written in Slack's two markup languages. A leaf module, so the
 * footer, the sinks, the approvals and the lists can all use it without an import cycle.
 */

// The characters that start inline formatting in a markdown block, each escapable with a backslash
// (Slack's markdown block reference, read 2026-09-25). `#`, `+`, `-`, `.` and `!` act only at the
// start of a line. `~` is not in the reference's list, but `~~` renders as strikethrough (measured
// live 2026-09-25). `<` stays text there, except in a mention sequence (`quietMentions`).
const MARKDOWN_INLINE = /([\\`*_{}[\]()&~])/g;

/** Slack's mrkdwn reads `&`, `<` and `>` as markup; a tool's title is shown as written. */
export function mrkdwnEscape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Text for inside a markdown block's own formatting, shown as written: a session's title, which
 * Claude writes, notifies nobody either (`quietMentions`).
 */
export function markdownEscape(text: string): string {
  return quietMentions(text.replace(MARKDOWN_INLINE, "\\$1"), true);
}

/**
 * Model-written text for mrkdwn, shown as written: `&`, `<` and `>` escaped, so no
 * `<url|label>` can hide what it links, and a zero-width space after each backtick, so no
 * run of three can close a code block.
 */
export function shownAsWritten(text: string): string {
  return mrkdwnEscape(text).replaceAll("`", "`​");
}

// Slack's mention sequences that notify: `<!here>`, `<!channel>`, `<!everyone>`, `<!subteam^…>`
// and `<@…>`. In a markdown block or a stream's markdown text each is stored as a broadcast or
// user element and notifies as one typed would, and a backslash before `<` stops none of them. A
// zero-width space after the `<` stops each, in text, in inline code and after an autolink alike,
// and shows nothing (measured 2026-10-21, dev app, private channel, by post, stream and edit).
// Matched wherever it is, code included: Slack pairs backticks where CommonMark would not, and a
// reply split across messages can start a message inside a fence, so no reading of the markdown
// can tell for sure that a sequence is code. `<#C…>`, a channel link, notifies nobody.
const MENTION = /<(?=!(?:here|channel|everyone|subteam\^)|@)/gi;
const BROADCASTS = ["<!here", "<!channel", "<!everyone", "<!subteam^"];
// Never pasted as a literal character in source, always by its code.
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);

/**
 * Text with a zero-width space after the `<` of every mention sequence that notifies, so a reply
 * notifies nobody that Claude, or a page it read, names; it reads the same.
 *
 * For text that is still arriving (`whole` false), the end that may still become a sequence (`<`,
 * `<!he`) waits for what follows, so every later call starts with what this one returns. With
 * `whole` that end gets the space too, since words added later would follow it in Slack.
 */
export function quietMentions(text: string, whole: boolean): string {
  const at = text.lastIndexOf("<");
  if (at === -1) return text;
  const tail = text.slice(at).toLowerCase();
  const open = tail === "<" || BROADCASTS.some((word) => word !== tail && word.startsWith(tail));
  if (!open) return text.replace(MENTION, `<${ZERO_WIDTH_SPACE}`);
  const head = text.slice(0, at).replace(MENTION, `<${ZERO_WIDTH_SPACE}`);
  return whole ? `${head}<${ZERO_WIDTH_SPACE}${text.slice(at + 1)}` : head;
}
