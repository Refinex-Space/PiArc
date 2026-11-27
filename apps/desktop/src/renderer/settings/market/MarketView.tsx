// The Pi package market (ADR-0102): search, categories with counts, sort, a list that grows
// page by page, and a package's details in place. Core answers from its cache at once and syncs
// in the background; `core/market` events say when to read the list again. Offline, the cached
// catalog stays with a line saying how old it is.
import type { MarketCategory, MarketEntry, MarketPage, MarketSort } from '@piarc/protocol';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { useApp } from '../../app/app-context.js';
import { Button } from '../../app/Button.js';
import { IconButton } from '../../app/IconButton.js';
import { SegmentedControl } from '../../app/SegmentedControl.js';
import { ReloadIcon, SearchIcon } from '../../shell/icons.js';
import { reason } from '../../shell/errors.js';
import { revealBidi } from '../../transcript/reveal.js';
import { MarketAction, type MarketRun, type MarketTarget } from './MarketAction.js';
import { KindBadges, MarketDetail } from './MarketDetail.js';
import { parseEvents, parsePage } from './market-data.js';

const PAGE = 50;
const CATEGORIES: readonly MarketCategory[] = ['all', 'extension', 'skill', 'prompt'];

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

function StatusLine({
  page,
  onRetry,
}: {
  readonly page: MarketPage | undefined;
  readonly onRetry: () => void;
}) {
  const { t, format } = useApp();
  if (page === undefined) return null;
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
    return null;
  }
  return (
    <p className="market-status" data-testid="market-status" data-state={s.state} role="status">
      <span>{text}</span>
      {s.problem != null && s.state !== 'syncing' && (
        <button type="button" className="market-link" onClick={onRetry}>
          {t('market.retry')}
        </button>
      )}
    </p>
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
  const meta = [
    revealBidi(entry.publisher),
    entry.downloadsMonthly > 0
      ? t('market.downloads', {
          count: format.number(entry.downloadsMonthly, { notation: 'compact' }),
        })
      : null,
    entry.updated > 0
      ? t('market.updatedAgo', { when: format.relative(entry.updated, Date.now()) })
      : null,
  ].filter((part): part is string => part !== null && part !== '');
  return (
    <li className="market-row" data-testid="market-row" data-name={entry.name}>
      <div className="market-row-text">
        <div className="market-row-name">
          <button
            type="button"
            className="market-name mono-text"
            data-testid="market-open"
            onClick={onOpen}
          >
            {revealBidi(entry.name)}
          </button>
          <KindBadges kinds={entry.kinds.filter((k) => k !== 'theme')} />
          {entry.insecure && <span className="market-kind is-danger">{t('market.insecure')}</span>}
          {entry.deprecated && (
            <span className="market-kind is-danger">{t('market.deprecated')}</span>
          )}
        </div>
        {entry.description !== '' && (
          <p className="market-description">{revealBidi(entry.description)}</p>
        )}
        <p className="market-meta">{meta.join(' · ')}</p>
      </div>
      <div className="market-row-action">
        <MarketAction entry={entry} target={target} busy={busy} run={run} />
      </div>
    </li>
  );
}

export function MarketView({
  target,
  initialQuery,
  initialPackage,
  onPackage,
}: {
  readonly target: MarketTarget;
  readonly initialQuery?: string;
  /** The package `#/settings/skills?view=market&package=` asked for. */
  readonly initialPackage?: string;
  /** The package shown changed (`null`: back to the list). */
  readonly onPackage: (name: string | null) => void;
}) {
  const { t, format } = useApp();
  const searchId = useId();
  const [text, setText] = useState(initialQuery ?? '');
  const query = useDebounced(text.trim(), 250);
  const [category, setCategory] = useState<MarketCategory>('all');
  const [sort, setSort] = useState<MarketSort>('popular');
  const [shown, setShown] = useState(PAGE);
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
    const pages = Math.ceil(shown / PAGE);
    const ask = (offset: number) =>
      window.piarc
        .marketQuery({ query, category, sort, offset, limit: PAGE, workspace: target.workspace })
        .then(parsePage);
    (async () => {
      const first = await ask(0);
      const entries = [...first.entries];
      for (let i = 1; i < pages && entries.length < first.total; i++) {
        entries.push(...(await ask(i * PAGE)).entries);
      }
      if (ticket === request.current) {
        setPage({ ...first, entries });
        setError('');
      }
    })().catch((e: unknown) => {
      if (ticket === request.current) setError(reason(e));
    });
  }, [query, category, sort, shown, target.workspace]);

  useEffect(load, [load]);
  /** Syncs the catalog now (Core answers at once and syncs in the background), then reads. */
  const refresh = useCallback(() => {
    setError('');
    window.piarc.marketRefresh().then(load, (e: unknown) => {
      setError(reason(e));
    });
  }, [load]);
  useEffect(() => {
    setShown(PAGE);
  }, [query, category, sort]);

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
      const key = name;
      setBusy((b) => new Set(b).add(key));
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
            next.delete(key);
            return next;
          });
          load();
          setRevision((r) => r + 1);
        });
    },
    [load, t],
  );

  const show = (name: string | null) => {
    if (name !== null)
      listScroll.current = document.querySelector('.settings-page')?.scrollTop ?? 0;
    setOpen(name);
    onPackage(name);
    if (name === null) {
      requestAnimationFrame(() => {
        const scroller = document.querySelector('.settings-page');
        if (scroller !== null) scroller.scrollTop = listScroll.current;
      });
    }
  };

  if (open !== null) {
    return (
      <MarketDetail
        name={open}
        target={target}
        busy={busy.has(open)}
        run={run}
        revision={revision}
        onBack={() => {
          show(null);
        }}
      />
    );
  }

  const counts = page?.counts;
  const countOf = (c: MarketCategory) =>
    counts === undefined ? undefined : c === 'all' ? counts.all : counts[c];
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
      <label className="settings-search market-search" htmlFor={searchId}>
        <SearchIcon />
        <input
          id={searchId}
          type="search"
          value={text}
          placeholder={t('market.search')}
          aria-label={t('market.search')}
          spellCheck={false}
          autoComplete="off"
          data-testid="market-search"
          onChange={(e) => {
            setText(e.currentTarget.value);
          }}
        />
      </label>
      <div className="market-toolbar">
        <SegmentedControl<MarketCategory>
          aria-label={t('market.category')}
          name="market-category"
          options={CATEGORIES}
          value={category}
          testIdPrefix="market-category"
          labelOf={(c) => {
            const count = countOf(c);
            return count === undefined
              ? t(`market.category.${c}`)
              : t('market.categoryCount', {
                  label: t(`market.category.${c}`),
                  count: format.number(count),
                });
          }}
          onChange={setCategory}
        />
        <span className="market-toolbar-end">
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
          <IconButton
            size="sm"
            label={t('market.refresh')}
            data-testid="market-refresh"
            disabled={page?.status.state === 'syncing'}
            onClick={refresh}
          >
            <ReloadIcon />
          </IconButton>
        </span>
      </div>
      <StatusLine page={page} onRetry={refresh} />
      {notice !== null && (
        <p
          className={notice.failed ? 'market-notice is-failed' : 'market-notice'}
          role={notice.failed ? 'alert' : 'status'}
          data-testid="market-notice"
        >
          {notice.text}
        </p>
      )}
      {page !== undefined && !page.live && query !== '' && page.status.problem != null && (
        <p className="market-note">{t('market.status.searchCached')}</p>
      )}
      {failedEmpty ? (
        <div className="market-empty" data-testid="market-error">
          <p>{t('market.empty.failed')}</p>
          <p className="market-note">{failure}</p>
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
        </div>
      ) : page === undefined || (entries.length === 0 && page.status.state === 'syncing') ? (
        <p className="market-empty" data-testid="market-loading">
          {t('market.empty.loading')}
        </p>
      ) : entries.length === 0 ? (
        <div className="market-empty" data-testid="market-none">
          <p>{t('market.empty.none')}</p>
          {(query !== '' || category !== 'all') && (
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
          )}
        </div>
      ) : (
        <ul className="market-list" data-testid="market-list">
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
        </ul>
      )}
      {page !== undefined && entries.length < page.total && (
        <button
          type="button"
          className="settings-add-link"
          data-testid="market-more"
          onClick={() => {
            setShown((n) => n + PAGE);
          }}
        >
          {t('usage.sessions.more', { count: Math.min(PAGE, page.total - entries.length) })}
        </button>
      )}
    </div>
  );
}
