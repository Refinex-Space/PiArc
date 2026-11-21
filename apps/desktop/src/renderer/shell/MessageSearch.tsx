// Full-text search over the sessions' messages in the sidebar (T35, FR-WS-04): the filter's
// text is also looked up in Core's index (`searchSessions`, trigram FTS5); results are grouped
// by session with snippets whose matches are marked. A click shows the session and scrolls to
// the message. Snippets are text: the marks are built from Core's ranges, never from markup.
import { useEffect, useState } from 'react';

import { useT } from '../app/app-context.js';
import { requestLocate } from '../store/locate.js';
import { sessionTitle } from './SessionRow.js';
import { useUi } from './ui.js';
import { reason } from './errors.js';

/** Wait after the last keystroke before asking Core. */
const SEARCH_DELAY_MS = 250;
/** The longest query sent (Core cuts at the same length). */
const MAX_QUERY = 200;

export interface SearchHit {
  readonly entryId: string | undefined;
  readonly role: 'user' | 'assistant';
  readonly snippet: string;
  readonly highlights: readonly (readonly [number, number])[];
}

export interface SearchResult {
  readonly sessionId: string;
  readonly title: string | undefined;
  readonly total: number;
  readonly hits: readonly SearchHit[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Core's answer, checked: malformed results and ranges are dropped. */
export function parseSearch(text: string): SearchResult[] {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !Array.isArray(value.results)) return [];
  return value.results.flatMap((item: unknown): SearchResult[] => {
    if (!isRecord(item) || typeof item.sessionId !== 'string' || !Array.isArray(item.hits)) {
      return [];
    }
    const hits = item.hits.flatMap((hit: unknown): SearchHit[] => {
      if (!isRecord(hit) || typeof hit.snippet !== 'string') return [];
      const length = hit.snippet.length;
      const ranges = Array.isArray(hit.highlights) ? hit.highlights : [];
      return [
        {
          entryId: typeof hit.entryId === 'string' ? hit.entryId : undefined,
          role: hit.role === 'user' ? 'user' : 'assistant',
          snippet: hit.snippet,
          highlights: ranges.flatMap((range: unknown): [number, number][] => {
            if (!Array.isArray(range)) return [];
            const [start, end] = range as unknown[];
            return typeof start === 'number' &&
              typeof end === 'number' &&
              Number.isInteger(start) &&
              Number.isInteger(end) &&
              start >= 0 &&
              start < end &&
              end <= length
              ? [[start, end]]
              : [];
          }),
        },
      ];
    });
    return [
      {
        sessionId: item.sessionId,
        title: typeof item.title === 'string' ? item.title : undefined,
        total: typeof item.total === 'number' ? item.total : hits.length,
        hits,
      },
    ];
  });
}

/** The snippet as text runs, `marked` where it matched. */
export function snippetRuns(hit: SearchHit): { text: string; marked: boolean }[] {
  const runs: { text: string; marked: boolean }[] = [];
  let at = 0;
  for (const [start, end] of [...hit.highlights].sort((a, b) => a[0] - b[0])) {
    if (start < at) continue;
    if (start > at) runs.push({ text: hit.snippet.slice(at, start), marked: false });
    runs.push({ text: hit.snippet.slice(start, end), marked: true });
    at = end;
  }
  if (at < hit.snippet.length) runs.push({ text: hit.snippet.slice(at), marked: false });
  return runs;
}

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'searching'; readonly query: string }
  | { readonly kind: 'done'; readonly query: string; readonly results: readonly SearchResult[] }
  | { readonly kind: 'failed'; readonly query: string; readonly reason: string };

function useSearch(filter: string): State {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const query = filter.trim().slice(0, MAX_QUERY);
  useEffect(() => {
    if (query.length === 0) {
      setState({ kind: 'idle' });
      return;
    }
    let active = true;
    setState({ kind: 'searching', query });
    const timer = setTimeout(() => {
      window.piarc.searchSessions(query).then(
        (text) => {
          if (active) setState({ kind: 'done', query, results: parseSearch(text) });
        },
        (error: unknown) => {
          if (active) setState({ kind: 'failed', query, reason: reason(error) });
        },
      );
    }, SEARCH_DELAY_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query]);
  return state;
}

export function MessageSearch({ filter }: { readonly filter: string }) {
  const t = useT();
  const ui = useUi();
  const state = useSearch(filter);
  if (state.kind === 'idle') return null;
  const open = (sessionId: string, entryId: string | undefined) => {
    if (entryId !== undefined) requestLocate(sessionId, entryId);
    ui.show({ kind: 'session', id: sessionId });
  };
  return (
    <section
      className="message-search"
      aria-label={t('search.messages')}
      data-testid="message-search"
    >
      <header className="workspace-header">
        <span className="workspace-name">{t('search.messages')}</span>
      </header>
      {state.kind === 'searching' && (
        <p className="muted small" role="status">
          {t('search.searching')}
        </p>
      )}
      {state.kind === 'failed' && (
        <p className="error-text small" role="alert">
          {t('search.failed', { reason: state.reason })}
        </p>
      )}
      {state.kind === 'done' && state.results.length === 0 && (
        <p className="muted small">{t('search.none', { query: state.query })}</p>
      )}
      {state.kind === 'done' && (
        <ul className="search-results">
          {state.results.map((result) => (
            <li key={result.sessionId} className="search-result" data-session={result.sessionId}>
              <button
                type="button"
                className="search-session truncate"
                data-testid="search-session"
                onClick={() => {
                  open(result.sessionId, result.hits[0]?.entryId);
                }}
              >
                {sessionTitle(result.title, t('session.untitled'))}
              </button>
              <ul className="search-hits">
                {result.hits.map((hit, index) => (
                  <li key={`${hit.entryId ?? ''}:${String(index)}`}>
                    <button
                      type="button"
                      className="search-hit"
                      data-testid="search-hit"
                      data-entry={hit.entryId}
                      onClick={() => {
                        open(result.sessionId, hit.entryId);
                      }}
                    >
                      <span className="search-role">{t(`search.role.${hit.role}`)}</span>
                      <span className="search-snippet">
                        {snippetRuns(hit).map((run, i) =>
                          run.marked ? (
                            <mark key={i}>{run.text}</mark>
                          ) : (
                            <span key={i}>{run.text}</span>
                          ),
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {result.total > result.hits.length && (
                <p className="muted small">
                  {t('search.more', { count: String(result.total - result.hits.length) })}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
