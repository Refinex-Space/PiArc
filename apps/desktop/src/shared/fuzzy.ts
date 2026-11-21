// Fuzzy matching for the command palettes (T37): the composer's `/` palette and the Mod+K
// palette rank with this one function. A query matches a text when its characters appear in
// order (ignoring case); the score prefers a match at the start, at word starts (after a space,
// `-`, `_`, `:`, `/`, `.` or a lower-to-upper case change) and in runs, and shorter texts.

/** A match of a query in a text. */
export interface FuzzyMatch {
  /** Higher is better. */
  readonly score: number;
  /** UTF-16 offsets of the matched characters in the text. */
  readonly positions: readonly number[];
}

const SEPARATORS = new Set([' ', '-', '_', ':', '/', '.']);

function wordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  const before = text[index - 1] ?? '';
  const here = text[index] ?? '';
  return SEPARATORS.has(before) || (before === before.toLowerCase() && here !== here.toLowerCase());
}

/**
 * The best match of `query` in `text`, or undefined. An empty query matches everything with
 * score 0. Each query character takes the earliest position that keeps the rest matchable,
 * preferring a word start or the position right after the previous match.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | undefined {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return { score: 0, positions: [] };
  const hay = text.toLowerCase();
  const positions: number[] = [];
  let from = 0;
  for (let q = 0; q < needle.length; q += 1) {
    const char = needle[q] ?? '';
    const rest = needle.slice(q + 1);
    let chosen = -1;
    for (let at = hay.indexOf(char, from); at !== -1; at = hay.indexOf(char, at + 1)) {
      if (!matchable(rest, hay, at + 1)) break;
      if (chosen === -1) chosen = at;
      const previous = positions.at(-1);
      if (wordStart(text, at) || (previous !== undefined && at === previous + 1)) {
        chosen = at;
        break;
      }
    }
    if (chosen === -1) return undefined;
    positions.push(chosen);
    from = chosen + 1;
  }
  return { score: scoreOf(text, positions), positions };
}

/** Whether `rest` still matches in order in `hay` from `from`. */
function matchable(rest: string, hay: string, from: number): boolean {
  let at = from;
  for (const char of rest) {
    at = hay.indexOf(char, at);
    if (at === -1) return false;
    at += 1;
  }
  return true;
}

function scoreOf(text: string, positions: readonly number[]): number {
  let score = 0;
  positions.forEach((at, i) => {
    score += 1;
    if (at === 0) score += 8;
    else if (wordStart(text, at)) score += 5;
    const previous = positions[i - 1];
    if (previous !== undefined) {
      if (at === previous + 1) score += 4;
      else score -= Math.min(3, at - previous - 1);
    }
  });
  // Among equal matches the shorter text is the closer one.
  return score - text.length / 100;
}

/**
 * The items matching `query` on any of their texts (`texts(item)`, the first one weighted
 * highest), best first; ties keep the given order.
 */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  texts: (item: T) => readonly string[],
): T[] {
  const ranked: { item: T; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    let best: number | undefined;
    texts(item).forEach((text, weight) => {
      const match = fuzzyMatch(query, text);
      if (match === undefined) return;
      const score = match.score - weight * 10;
      if (best === undefined || score > best) best = score;
    });
    if (best !== undefined) ranked.push({ item, score: best, index });
  });
  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked.map((r) => r.item);
}
