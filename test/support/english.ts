/**
 * Detects prose that is not English. Everything the repository holds in prose is English, and
 * the check is a count of function words: an Italian paragraph is rich in the Italian ones and
 * poor in the English ones, which a short quotation inside an English paragraph does not change.
 */

const ITALIAN = new Set(
  `il lo la gli le della delle dello degli che non per sono una uno questo questa quando come
   perché anche più già essere fatto con nel nella del dei`.split(/\s+/),
);
const ENGLISH = new Set(
  "the of and to is in that it for with as are this be on by not or from".split(" "),
);

/** Fenced code blocks and backtick spans removed, so that code and quoted literals do not count. */
export function stripCode(text: string): string {
  return text.replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, "").replace(/`[^`\n]*`/g, " ");
}

/** True when the paragraph has at least 3 Italian function words and more of them than English ones. */
export function isNotEnglish(paragraph: string): boolean {
  const words =
    stripCode(paragraph)
      .toLowerCase()
      .match(/[a-zàèéìòù]+/g) ?? [];
  const italian = words.filter((word) => ITALIAN.has(word)).length;
  const english = words.filter((word) => ENGLISH.has(word)).length;
  return italian >= 3 && italian > english;
}

/** The blank-line separated paragraphs of a markdown text, fenced code blocks removed first. */
export function markdownParagraphs(text: string): string[] {
  return stripCode(text)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

/**
 * The comment blocks of a source file, one string per run of consecutive lines that start with
 * `//`, `/*` or `*`. A comment after code on the same line is not read.
 */
export function commentBlocks(source: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) blocks.push(current.join("\n").trim());
    current = [];
  };
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (/^(\/\/|\/\*|\*)/.test(trimmed)) {
      current.push(trimmed.replace(/^(\/\/+|\/\*+|\*+\/?)\s?/, "").replace(/\*\/$/, ""));
    } else flush();
  }
  flush();
  return blocks;
}

/** The first 80 characters of a paragraph on one line, for a failure message. */
export function excerpt(paragraph: string): string {
  return paragraph.replace(/\s+/g, " ").slice(0, 80);
}
