/**
 * Claude Code's changelog between two CLI versions, for the probe's report: what a release
 * changed in the CLI the SDK bundles, read by a person next to the claims. Never a verdict.
 */

/** Where Claude Code publishes it (verified 2026-10-24): `## <version>` headings, newest first. */
export const CHANGELOG_URL =
  "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md";

/** Version numbers in order: `0.3.99` before `0.3.296`. */
export function byVersion(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const step = (x[i] ?? 0) - (y[i] ?? 0);
    if (step !== 0) return step;
  }
  return 0;
}

/**
 * The sections of `text` above `baseline` (exclusive) up to `tested` (inclusive), newest first,
 * headings and bullets as written. A line says so when none falls in the range; one says the
 * tested version is missing when the changelog does not list it yet (the file trails a release).
 */
export function changelogBetween(text: string, baseline: string, tested: string): string {
  const sections: { version: string; lines: string[] }[] = [];
  for (const line of text.split("\n")) {
    // A version may be followed by more words (a date, a note): the section is still its own.
    const heading = /^##\s+v?(\d+(?:\.\d+)*)(?:\s.*)?$/.exec(line);
    if (heading?.[1]) sections.push({ version: heading[1], lines: [line] });
    else sections.at(-1)?.lines.push(line);
  }
  const range = sections
    .filter(({ version }) => byVersion(version, baseline) > 0 && byVersion(version, tested) <= 0)
    .sort((a, b) => byVersion(b.version, a.version));
  const title = `Claude Code changelog, ${baseline} (exclusive) to ${tested}`;
  const missing = sections.some(({ version }) => version === tested)
    ? ""
    : `\n${tested} is not in the changelog yet.`;
  if (range.length === 0) return `${title}\nNo section in that range.${missing}`;
  const body = range.map(({ lines }) => lines.join("\n").trimEnd()).join("\n\n");
  return `${title}${missing}\n\n${body}`;
}

/** The changelog's text; throws when the host answers with an error. */
export async function fetchChangelog(): Promise<string> {
  const response = await fetch(CHANGELOG_URL, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`the changelog host answered ${response.status}`);
  return response.text();
}
