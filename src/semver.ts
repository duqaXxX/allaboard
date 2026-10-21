/**
 * Semantic Versioning 2.0.0 as npm publishes it: whether a text is a version, and which of two
 * versions is newer. Any layer may import this file: the host asks npm for versions and the core
 * decides whether one is newer than the one that runs.
 */

// Semantic Versioning 2.0.0 without build metadata (`+...`), which npm drops anyway. A match
// starts with a digit, so npm can never read it as an option, and holds no space or quote.
const VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;

/** Whether `text` is a version number as npm publishes one: `0.2.0`, `1.0.0-rc.1`. */
export function isVersion(text: string): boolean {
  return VERSION.test(text);
}

/** Semantic Versioning 2.0.0, rule 11: the order of two pre-release identifiers. */
function identifierOrder(a: string, b: string): number {
  const numbers = [/^\d+$/.test(a), /^\d+$/.test(b)];
  if (numbers[0] && numbers[1]) return Math.sign(Number(a) - Number(b));
  // A numeric identifier is lower than an alphanumeric one.
  if (numbers[0] !== numbers[1]) return numbers[0] ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Whether `candidate` takes precedence over `current` by Semantic Versioning 2.0.0, rule 11. A
 * string that is no version is never newer, and nothing is newer than it.
 */
export function isNewer(candidate: string, current: string): boolean {
  if (!isVersion(candidate) || !isVersion(current)) return false;
  const [cores, pres] = [candidate, current].map((text) => {
    // The first hyphen ends the numbers; a pre-release may hold more of them.
    const dash = text.indexOf("-");
    const core = dash === -1 ? text : text.slice(0, dash);
    return {
      numbers: core.split(".").map(Number),
      pre: dash === -1 ? null : text.slice(dash + 1).split("."),
    };
  }) as [{ numbers: number[]; pre: string[] | null }, { numbers: number[]; pre: string[] | null }];
  for (let index = 0; index < 3; index += 1) {
    const difference = (cores.numbers[index] as number) - (pres.numbers[index] as number);
    if (difference !== 0) return difference > 0;
  }
  // A release is newer than any pre-release of the same numbers.
  if (cores.pre === null || pres.pre === null) return cores.pre === null && pres.pre !== null;
  for (let index = 0; index < Math.min(cores.pre.length, pres.pre.length); index += 1) {
    const order = identifierOrder(cores.pre[index] as string, pres.pre[index] as string);
    if (order !== 0) return order > 0;
  }
  return cores.pre.length > pres.pre.length;
}
