// The address bar's suggestions (design addendum B1.2.3): this workspace's history (title and
// address match), the session's open tabs and its detected local services. Pure, so the
// ranking is tested without Electron.

import type { BrowserRecent, BrowserSuggestion } from '../../shared/browser.js';

/** Where suggestions come from. */
export interface SuggestionSources {
  /** This workspace's recent pages, newest first. */
  readonly history: readonly BrowserRecent[];
  /** The session's open tabs, in strip order. */
  readonly tabs: readonly BrowserRecent[];
  /** Local services (`http://localhost:<port>/`), titled by what runs them. */
  readonly services: readonly BrowserRecent[];
}

const KIND_ORDER: Readonly<Record<BrowserSuggestion['kind'], number>> = {
  tab: 0,
  server: 1,
  history: 2,
};

/** An address without its scheme and `www.`, lowercase: what people type. */
function bare(url: string): string {
  return url
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '');
}

/**
 * How well `candidate` matches `query` (lowercase, trimmed): 4 when the address starts with
 * it, 3 when a word of the title does, 2 when a part of the address does, 1 when either
 * contains it, 0 when it does not match. An empty query matches services and tabs weakly so
 * the list has something to offer when the field is focused.
 */
export function matchScore(query: string, candidate: BrowserRecent): number {
  const address = bare(candidate.url);
  const title = candidate.title.toLowerCase();
  if (query === '') return 0;
  if (address.startsWith(query)) return 4;
  if (title.split(/[\s\-–—|:·/]+/).some((word) => word !== '' && word.startsWith(query))) {
    return 3;
  }
  if (address.split(/[./:?#&=_-]+/).some((part) => part !== '' && part.startsWith(query))) {
    return 2;
  }
  return address.includes(query) || title.includes(query) ? 1 : 0;
}

/** The suggestions for `input`, best first, at most `limit`, one per address. */
export function rankSuggestions(
  input: string,
  sources: SuggestionSources,
  limit: number,
): BrowserSuggestion[] {
  const query = input.trim().toLowerCase();
  const candidates: { item: BrowserSuggestion; score: number; order: number }[] = [];
  const add = (list: readonly BrowserRecent[], kind: BrowserSuggestion['kind']) => {
    list.forEach((entry, order) => {
      if (entry.url === '' || entry.url === 'about:blank') return;
      const score = query === '' ? (kind === 'history' ? 0 : 1) : matchScore(query, entry);
      if (score === 0 && !(query === '' && kind === 'history' && order < limit)) return;
      candidates.push({ item: { url: entry.url, title: entry.title, kind }, score, order });
    });
  };
  add(sources.tabs, 'tab');
  add(sources.services, 'server');
  add(sources.history, 'history');
  candidates.sort(
    (a, b) =>
      b.score - a.score || KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] || a.order - b.order,
  );
  const seen = new Set<string>();
  const result: BrowserSuggestion[] = [];
  for (const { item } of candidates) {
    const key = bare(item.url).replace(/\/$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}
