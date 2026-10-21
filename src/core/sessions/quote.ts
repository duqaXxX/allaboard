/**
 * A text quoted inside a reference, line by line. A line past `QUOTE_WIDTH` is
 * wrapped first, after whitespace where there is some, else at a grapheme boundary, so that every
 * piece carries its own quote mark: the chat splits a message past its limit at line breaks, and a
 * line it had to cut itself would leave an unquoted chunk.
 */

/** The longest line of a quote, well under any chat's message limit. */
export const QUOTE_WIDTH = 1000;

// Segments lazily: a hard cut reads graphemes only up to the width, whatever the line's length.
const graphemes = new Intl.Segmenter();

/** Where a hard cut of `rest` falls: the last grapheme boundary within `width`, else the first. */
function graphemeCut(rest: string, width: number): number {
  let end = 0;
  for (const { segment } of graphemes.segment(rest)) {
    if (end > 0 && end + segment.length > width) break;
    end += segment.length;
  }
  return end;
}

/**
 * `line` cut into pieces of at most `width` characters, each cut after the last whitespace of a
 * piece, which stays at the end of it so that the pieces joined give the line back. A piece with
 * no whitespace is cut hard at a grapheme boundary, never inside a surrogate pair, a ZWJ sequence
 * or a combining sequence (a single grapheme longer than `width` goes whole).
 */
export function wrapped(line: string, width: number): string[] {
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > width) {
    let end = 0;
    for (let at = width - 1; at > 0; at -= 1) {
      if (/\s/.test(rest.charAt(at))) {
        end = at + 1;
        break;
      }
    }
    if (end === 0) end = graphemeCut(rest, width);
    pieces.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  if (rest !== "" || pieces.length === 0) pieces.push(rest);
  return pieces;
}

/**
 * `text` with each line, and each piece of a long one, escaped by `escaped` and marked `> `. The
 * pieces are cut before they are escaped, so an escape is never split.
 */
export function quoted(text: string, escaped: (piece: string) => string): string {
  return text
    .split(/\r?\n/)
    .flatMap((line) => wrapped(line, QUOTE_WIDTH))
    .map((piece) => `> ${escaped(piece)}`.trimEnd())
    .join("\n");
}
