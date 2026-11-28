// Plain URLs in a terminal row (T34): `https:`, `http:` and `mailto:` addresses found in the
// text the frame shows, with the columns they cover. OSC 8 hyperlinks come from Core
// (`terminalLinkAt`); these are the addresses programs print without one. Opening either goes
// through the main process's confirmation (architecture section 10.3), which only accepts the
// same three schemes.
import type { FrameCell } from './frame/decoder.js';

export interface RowLink {
  readonly uri: string;
  /** First column. */
  readonly start: number;
  /** Last column (included). */
  readonly end: number;
}

/** Schemes a link may have, as the main process accepts them. */
export const LINK_SCHEMES = ['https:', 'http:', 'mailto:'] as const;

// A scheme, then characters that occur in URLs (no spaces, quotes or angle brackets; cells
// hold no control characters); trailing punctuation is trimmed below.
const URL_PATTERN = /\b(?:https?:\/\/|mailto:)[^\s<>"'`]+/giu;

/** Characters that end a sentence or close a bracket the URL was written in. */
const TRAILING = /[.,;:!?'")\]}>]+$/u;

/** Whether `uri` may be opened: one of `LINK_SCHEMES`, no user information. */
export function isOpenableLink(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  return (
    (LINK_SCHEMES as readonly string[]).includes(url.protocol) &&
    url.username === '' &&
    url.password === ''
  );
}

/**
 * The URLs on a row. Each cell contributes its text (a wide character's spacer contributes
 * nothing), so string offsets map back to the columns the URL covers.
 */
export function urlsInRow(cells: readonly FrameCell[]): readonly RowLink[] {
  let text = '';
  // `columns[i]` is the column of the cell that wrote code unit `i` of `text`.
  const columns: number[] = [];
  cells.forEach((cell, x) => {
    if (cell.wide === 2 || cell.wide === 3) return;
    const value = cell.text === '' ? ' ' : cell.text;
    text += value;
    columns.push(...Array.from({ length: value.length }, () => x));
  });
  const links: RowLink[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    let uri = match[0];
    // Keep a closing bracket that has its opening one inside the URL (Wikipedia-style).
    const trimmed = uri.replace(TRAILING, '');
    uri = uri.endsWith(')') && trimmed.includes('(') ? trimmed + ')' : trimmed;
    if (!isOpenableLink(uri)) continue;
    const from = match.index;
    const to = from + uri.length - 1;
    const start = columns[from];
    const end = columns[to];
    if (start === undefined || end === undefined) continue;
    links.push({ uri, start, end });
  }
  return links;
}

/** The URL covering column `x`, if any. */
export function urlAt(cells: readonly FrameCell[], x: number): RowLink | undefined {
  return urlsInRow(cells).find((link) => x >= link.start && x <= link.end);
}
