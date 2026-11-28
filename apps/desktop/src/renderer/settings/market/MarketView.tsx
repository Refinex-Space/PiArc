// The Pi package market (ADR-0102) as a sub-page of "Skills & plugins": a trail back in place of
// the page's title, search and refresh at the head, categories with counts and the sort on one
// row, rows like the installed view's, and pages of 20 like the audit's. Core answers from its
// cache at once and syncs in the background; `core/market` events say when to read again. The
// sync's state is a line under the title; offline, the cached catalog stays with a notice.
import type { MarketCategory, MarketEntry, MarketPage, MarketSort } from '@piarc/protocol';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { MessageId } from '../../../shared/i18n/index.js';
import { useApp } from '../../app/app-context.js';
import { Button } from '../../app/Button.js';
import { IconButton } from '../../app/IconButton.js';
import { reason } from '../../shell/errors.js';
import { ReloadIcon } from '../../shell/icons.js';
import { revealBidi } from '../../transcript/reveal.js';
import {
  CatalogEmpty,
  CatalogList,
  CatalogPager,
  CatalogRow,
  CatalogSearch,
  CatalogTabs,
  CatalogToolbar,
  Crumbs,
} from '../catalog.js';
import { PageHeadActions, PageHeading } from '../page-head.js';
import { MarketAction, type MarketRun, type MarketTarget } from './MarketAction.js';
import { MarketDetail } from './MarketDetail.js';
import { entryTile, kindsText } from './market-kinds.js';
import { parseEvents, parsePage } from './market-data.js';

const PAGE = 20;
const CATEGORIES: readonly MarketCategory[] = ['all', 'extension', 'skill', 'prompt'];
const CATEGORY_LABELS: Record<MarketCategory, MessageId> = {
  all: 'market.category.all',
  extension: 'market.category.extension',
  skill: 'market.category.skill',
  prompt: 'market.category.prompt',
};

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSettled(value);
    }, ms);
    return () => {
      window.clearTimeout(timer);
    };
  }, [value, ms]);
  return settled;
}

/** The sync's state in a line: how fresh the catalog is, or what it is doing. */
function StatusText({
  page,
  onRetry,
}: {
  readonly page: MarketPage;
  readonly onRetry: () => void;
}) {
  const { t, format } = useApp();
  const s = page.status;
  const when = s.syncedAt == null ? null : format.relative(s.syncedAt, Date.now());
  let text: string;
  if (s.state === 'syncing') {
    text = t('market.status.syncing', { done: s.done, total: Math.max(s.total, s.done) });
  } else if (s.problem != null && when !== null) {
    text = t(s.problem.code === 'proxy' ? 'market.status.proxy' : 'market.status.offline', {
      when,
    });
  } else if (when !== null) {
    text =
      s.classified < s.indexed
        ? t('market.status.classifying', { when, done: s.classified, total: s.indexed })
        : t('market.status.updated', { when });
  } else {
    text = t('market.subtitle');
  }
  return (
    <span className="market-status" data-testid="market-status" data-state={s.state} role="status">
      <span>{text}</span>
      {s.problem != null && s.state !== 'syncing' && (
        <button type="button" className="catalog-link" onClick={onRetry}>
          {t('market.retry')}
        </button>
      )}
    </span>
  );
}

function Row({
  entry,
  target,
  busy,
  run,
  onOpen,
}: {
  readonly entry: MarketEntry;
  readonly target: MarketTarget;
  readonly busy: boolean;
  readonly run: MarketRun;
  readonly onOpen: () => void;
}) {
  const { t, format } = useApp();
  const risky = entry.insecure
    ? t('market.insecure')
    : entry.deprecated
      ? t('market.deprecated')
      : '';
  return (
    <CatalogRow
      kind={entryTile(entry)}
      testId="market-row"
      data={{ name: entry.name }}
      title={revealBidi(entry.name)}
      note={
        risky === '' ? (
          kindsText(t, entry) || t('market.kindUnknown')
        ) : (
          <span className="catalog-row-note is-attention">{risky}</span>
        )
      }
      description={revealBidi(entry.description)}
      openLabel={t('catalog.open', { name: entry.name })}
      onOpen={onOpen}
      trailing={
        <>
          {entry.downloadsMonthly > 0 && (
            <span className="catalog-row-meta">
              {t('market.downloads', {
                count: format.number(entry.downloadsMonthly, { notation: 'compact' }),
              })}
            </span>
          )}
          <MarketAction entry={entry} target={target} busy={busy} run={run} />
        </>
      }
    />
  );
}

export function MarketView({
  target,
  headActions,
  initialPackage,
  onPackage,
  onLeave,
}: {
  readonly target: MarketTarget;
  /** The page's own head controls (the project picker), before the market's. */
  readonly headActions?: ReactNode;
  /** The package `#/settings/skills?view=market&package=` asked for. */
  readonly initialPackage?: string;
  /** The package shown changed (`null`: back to the list). */
  readonly onPackage: (name: string | null) => void;
  /** Back to "Skills & plugins". */
  readonly onLeave: () => void;
}) {
  const { t } = useApp();
  const [text, setText] = useState('');
  const query = useDebounced(text.trim(), 250);
  const [category, setCategory] = useState<MarketCategory>('all');
  const [sort, setSort] = useState<MarketSort>('popular');
  const [pageIndex, setPageIndex] = useState(0);
  const [page, setPage] = useState<MarketPage | undefined>(undefined);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ text: string; failed: boolean } | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [revision, setRevision] = useState(0);
  const [open, setOpen] = useState<string | null>(initialPackage ?? null);
  const request = useRef(0);
  const listScroll = useRef(0);

  const load = useCallback(() => {
    const ticket = ++request.current;
    window.piarc
      .marketQuery({
        query,
        category,
        sort,
        offset: pageIndex * PAGE,
        limit: PAGE,
        workspace: target.workspace,
      })
      .then(parsePage)
      .then((answer) => {
        if (ticket === request.current) {
          setPage(answer);
          setError('');
        }
      })
      .catch((e: unknown) => {
        if (ticket === request.current) setError(reason(e));
      });
  }, [query, category, sort, pageIndex, target.workspace]);

  useEffect(load, [load]);
  useEffect(() => {
    setPageIndex(0);
  }, [query, category, sort]);
  /** Syncs the catalog now (Core answers at once and syncs in the background), then reads. */
  const refresh = useCallback(() => {
    setError('');
    window.piarc.marketRefresh().then(load, (e: unknown) => {
      setError(reason(e));
    });
  }, [load]);

  // `core/market`: sync pages, kinds and installs change the list; read it again shortly after.
  useEffect(() => {
    let timer: number | undefined;
    const route = 'core/market';
    window.piarc
      .subscribeEvents(route, (batch) => {
        const changes = parseEvents(batch.payload);
        if (changes.status !== undefined) {
          const status = changes.status;
          setPage((current) => (current === undefined ? current : { ...current, status }));
        }
        if (changes.refresh) {
          window.clearTimeout(timer);
          timer = window.setTimeout(() => {
            load();
            setRevision((r) => r + 1);
          }, 400);
        }
      })
      .catch(() => {
        // The list still works; it only stops following background changes.
      });
    return () => {
      window.clearTimeout(timer);
      void window.piarc.unsubscribeEvents(route);
    };
  }, [load]);

  const run: MarketRun = useCallback(
    (name, label, action) => {
      setBusy((b) => new Set(b).add(name));
      setNotice({ text: label, failed: false });
      action()
        .then((done) => {
          setNotice(done === null ? null : { text: done, failed: false });
        })
        .catch((e: unknown) => {
          setNotice({ text: t('market.failed', { reason: reason(e) }), failed: true });
        })
        .finally(() => {
          setBusy((b) => {
            const next = new Set(b);
            next.delete(name);
            return next;
          });
          load();
          setRevision((r) => r + 1);
        });
    },
    [load, t],
  );

  const show = (name: string | null) => {
    const scroller = document.querySelector('.settings-page');
    if (name !== null) listScroll.current = scroller?.scrollTop ?? 0;
    setOpen(name);
    onPackage(name);
    requestAnimationFrame(() => {
      if (scroller !== null) scroller.scrollTop = name === null ? listScroll.current : 0;
    });
  };

  const noticeLine = notice !== null && (
    <p
      className={notice.failed ? 'catalog-notice is-danger' : 'catalog-notice is-plain'}
      role={notice.failed ? 'alert' : 'status'}
      data-testid="market-notice"
    >
      {notice.text}
    </p>
  );

  if (open !== null) {
    return (
      <>
        <PageHeading>
          <Crumbs
            items={[
              { label: t('settings.skills'), onClick: onLeave, testId: 'skills-view-installed' },
              {
                label: t('market.title'),
                onClick: () => {
                  show(null);
                },
                testId: 'market-back',
              },
              { label: revealBidi(open) },
            ]}
          />
        </PageHeading>
        <PageHeadActions>{headActions}</PageHeadActions>
        {noticeLine}
        <MarketDetail
          name={open}
          target={target}
          busy={busy.has(open)}
          run={run}
          revision={revision}
        />
      </>
    );
  }

  const counts = page?.counts;
  const entries = page?.entries ?? [];
  // Nothing to show and nothing cached: the registry (or the proxy) could not be reached.
  const unreachable =
    page !== undefined &&
    page.status.state !== 'syncing' &&
    page.status.syncedAt == null &&
    page.status.problem != null &&
    page.counts.all === 0;
  const failedEmpty = (page === undefined && error !== '') || unreachable;
  const failure =
    error !== ''
      ? error
      : t(page?.status.problem?.code === 'proxy' ? 'market.empty.proxy' : 'market.empty.offline');
  return (
    <div className="market" data-testid="market">
      <PageHeading>
        <Crumbs
          items={[
            { label: t('settings.skills'), onClick: onLeave, testId: 'skills-view-installed' },
            { label: t('market.title') },
          ]}
          title={t('market.title')}
          description={
            page === undefined ? t('market.subtitle') : <StatusText page={page} onRetry={refresh} />
          }
        />
      </PageHeading>
      <PageHeadActions>
        {headActions}
        <CatalogSearch
          value={text}
          label={t('market.search')}
          testId="market-search"
          onChange={setText}
        />
        <IconButton
          size="sm"
          label={t('market.refresh')}
          data-testid="market-refresh"
          disabled={page?.status.state === 'syncing'}
          onClick={refresh}
        >
          <ReloadIcon />
        </IconButton>
      </PageHeadActions>
      <CatalogToolbar>
        <CatalogTabs
          label={t('market.category')}
          tabs={CATEGORIES.map((c) => ({
            id: c,
            label: t(CATEGORY_LABELS[c]),
            count: counts === undefined ? undefined : c === 'all' ? counts.all : counts[c],
          }))}
          value={category}
          testIdPrefix="market-category"
          onChange={setCategory}
        />
        <select
          className="market-sort"
          aria-label={t('market.sort')}
          value={sort}
          data-testid="market-sort"
          onChange={(e) => {
            setSort(e.currentTarget.value === 'updated' ? 'updated' : 'popular');
          }}
        >
          <option value="popular">{t('market.sort.popular')}</option>
          <option value="updated">{t('market.sort.updated')}</option>
        </select>
      </CatalogToolbar>
      {noticeLine}
      {page !== undefined && !page.live && query !== '' && page.status.problem != null && (
        <p className="catalog-notice">{t('market.status.searchCached')}</p>
      )}
      {failedEmpty ? (
        <CatalogEmpty
          testId="market-error"
          action={
            <span className="market-empty-actions">
              <Button size="small" onClick={refresh}>
                {t('market.retry')}
              </Button>
              <Button
                size="small"
                variant="ghost"
                onClick={() => {
                  window.location.hash = '#/settings/proxy';
                }}
              >
                {t('market.proxySettings')}
              </Button>
            </span>
          }
        >
          {t('market.empty.failed')} {failure}
        </CatalogEmpty>
      ) : page === undefined || (entries.length === 0 && page.status.state === 'syncing') ? (
        <CatalogEmpty testId="market-loading">{t('market.empty.loading')}</CatalogEmpty>
      ) : entries.length === 0 ? (
        <CatalogEmpty
          testId="market-none"
          action={
            (query !== '' || category !== 'all') && (
              <Button
                size="small"
                variant="ghost"
                onClick={() => {
                  setText('');
                  setCategory('all');
                }}
              >
                {t('market.clearFilters')}
              </Button>
            )
          }
        >
          {t('market.empty.none')}
        </CatalogEmpty>
      ) : (
        <CatalogList testId="market-list">
          {entries.map((entry) => (
            <Row
              key={entry.name}
              entry={entry}
              target={target}
              busy={busy.has(entry.name)}
              run={run}
              onOpen={() => {
                show(entry.name);
              }}
            />
          ))}
        </CatalogList>
      )}
      {page !== undefined && (
        <CatalogPager
          page={pageIndex}
          size={PAGE}
          total={page.total}
          testId="market-pager"
          onPage={(next) => {
            setPageIndex(next);
            document.querySelector('.settings-page')?.scrollTo({ top: 0 });
          }}
        />
      )}
    </div>
  );
}
