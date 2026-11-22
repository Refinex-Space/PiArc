// A WebSearch call (T38): the query, the backend that answered and the sources. A source opens
// only through the main process's confirmation (`window.piarc.openExternal`, architecture
// section 8.5), never in the app window.
import type { Item, WebSearchSource } from '@piarc/protocol';

import { useT } from '../../app/app-context.js';
import { safeHref } from '../markdown/text.js';
import { StatusMark } from './tools.js';
import { ReviewNote } from './review.js';

type WebSearchItem = Extract<Item, { type: 'webSearch' }>;

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function open(url: string): void {
  window.piarc.openExternal(url).catch((error: unknown) => {
    console.error('[transcript] opening a search result failed', error);
  });
}

function Source({ source }: { readonly source: WebSearchSource }) {
  // The address comes from the search backend: only what a Markdown link may open (R5).
  const href = safeHref(source.url);
  return (
    <li className="web-search-source" data-testid="web-search-source">
      {href === null ? (
        <span title={source.url}>{source.title}</span>
      ) : (
        <a
          className="md-link"
          href={href}
          title={href}
          onClick={(event) => {
            event.preventDefault();
            open(href);
          }}
        >
          {source.title}
        </a>
      )}{' '}
      <span className="web-search-host">{hostOf(source.url)}</span>
    </li>
  );
}

export function WebSearchCard({ id, item }: { readonly id: string; readonly item: WebSearchItem }) {
  const t = useT();
  const sources = item.sources ?? [];
  const backend = item.backend ?? undefined;
  return (
    <div
      className={`row row-web-search is-${item.status}`}
      data-testid="web-search-card"
      data-row-id={id}
      data-status={item.status}
    >
      <div className="bash-head">
        <StatusMark status={item.status} />
        <span className="bash-label">{t('transcript.webSearch.label')}</span>
        <span className="web-search-query" data-testid="web-search-query">
          {item.query}
        </span>
        {backend === undefined ? null : (
          <span className="web-search-backend">
            {backend === 'native'
              ? t('transcript.webSearch.native')
              : t('transcript.webSearch.service', { name: backend })}
          </span>
        )}
      </div>
      <ReviewNote review={item.review} />
      {sources.length > 0 ? (
        <ol className="web-search-sources" aria-label={t('transcript.webSearch.sources')}>
          {sources.map((source, n) => (
            <Source key={`${String(n)}:${source.url}`} source={source} />
          ))}
        </ol>
      ) : item.status === 'completed' ? (
        <div className="web-search-empty">{t('transcript.webSearch.none')}</div>
      ) : null}
    </div>
  );
}
