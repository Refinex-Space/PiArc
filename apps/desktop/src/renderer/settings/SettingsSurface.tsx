// Settings as a workbench view (ADR-0101): the navigation takes the sidebar's column, the page
// takes the main area. Registered pages, hash routes and links to a field stay as they were.
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { useApp } from '../app/app-context.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { ManagedBanner, ManagedProvider } from './managed.js';
import { PageHeadingSlot, PageHeadSlot } from './page-head.js';
import { SETTINGS_GROUPS, settingsPages } from './registry.js';
import { SettingsIcon } from './SettingsIcon.js';
import { searchSettings, SettingsResults, SettingsSearchField } from './SettingsSearch.js';

function pageFromHash(): string | undefined {
  return /^#\/settings\/([a-zA-Z0-9.-]+)(?:\?[a-zA-Z0-9=&.%_~-]*)?$/.exec(
    window.location.hash,
  )?.[1];
}

/** Whether Escape belongs to something inside the page: a dialog, a menu or an open picker. */
function escapeTakenInside(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('dialog, [role="dialog"], [role="alertdialog"], [role="menu"]')) return true;
  const select = target.closest('select');
  if (select === null) return false;
  try {
    return select.matches(':open');
  } catch {
    return false;
  }
}

export function SettingsSurface({ onClose }: { readonly onClose: () => void }) {
  const { t } = useApp();
  const pages = settingsPages();
  const listId = useId();
  const [current, setCurrent] = useState(() => pageFromHash() ?? pages[0]?.id);
  const [target, setTarget] = useState<{ field: string }>();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [headSlot, setHeadSlot] = useState<HTMLElement | null>(null);
  const [headingSlot, setHeadingSlot] = useState<HTMLElement | null>(null);
  const [headingClaims, setHeadingClaims] = useState(0);
  const claimHeading = useCallback((on: boolean) => {
    setHeadingClaims((n) => Math.max(0, n + (on ? 1 : -1)));
  }, []);
  const content = useRef<HTMLElement>(null);
  const heading = useMemo(
    () => ({ slot: headingSlot, claim: claimHeading }),
    [headingSlot, claimHeading],
  );
  const results = searchSettings(pages, query, t);
  const searching = query.trim() !== '';
  const chosen = Math.max(0, Math.min(active, results.length - 1));

  useEffect(() => {
    const onHash = () => {
      const id = pageFromHash();
      if (id) {
        setCurrent(id);
        setTarget(undefined);
        setQuery('');
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
    };
  }, []);
  const page = pages.find((p) => p.id === current) ?? pages[0];
  useEffect(() => {
    const pane = content.current;
    if (!pane) return;
    pane.scrollTop = 0;
    if (!target) return;
    const reveal = () => {
      const field = pane.querySelector<HTMLElement>(`[data-testid="${CSS.escape(target.field)}"]`);
      if (!field) return false;
      field.scrollIntoView({ block: 'center' });
      // Restart the mark when the same field is located again.
      field.classList.remove('is-located');
      field.getBoundingClientRect();
      field.classList.add('is-located');
      const focusable =
        'input:checked:enabled, select:enabled, button:enabled, input:enabled, textarea:enabled';
      const control = field.matches(focusable)
        ? field
        : field.querySelector<HTMLElement>(focusable);
      control?.focus({ preventScroll: true });
      return true;
    };
    if (reveal()) return;
    const observer = new MutationObserver(() => {
      if (reveal()) observer.disconnect();
    });
    observer.observe(pane, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, [current, target]);
  const navigate = (id: string, field = '') => {
    setQuery('');
    setCurrent(id);
    setTarget(field ? { field } : undefined);
    window.history.replaceState(null, '', '#/settings/' + id);
  };
  const choose = (index: number) => {
    const result = results[index];
    if (result) navigate(result.page, result.target);
  };
  const shown = searching ? pages.filter((p) => results.some((r) => r.page === p.id)) : pages;
  return (
    <ManagedProvider page={page?.id}>
      <div
        className="settings settings-surface"
        data-testid="settings-window"
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || event.defaultPrevented) return;
          if (isImeComposing(event.nativeEvent) || escapeTakenInside(event.target)) return;
          event.preventDefault();
          if (searching) setQuery('');
          else onClose();
        }}
      >
        <div className="settings-sidebar-clip">
          <nav className="sidebar settings-sidebar settings-nav" aria-label={t('settings.pages')}>
            <div className="titlebar sidebar-titlebar" />
            <div className="settings-sidebar-head">
              <button
                type="button"
                className="settings-back"
                data-testid="settings-close"
                aria-keyshortcuts="Escape"
                onClick={onClose}
              >
                <SettingsIcon name="back" />
                <span>{t('settings.back')}</span>
                <kbd className="settings-back-key" aria-hidden="true">
                  {t('settings.back.key')}
                </kbd>
              </button>
              <SettingsSearchField
                query={query}
                onQuery={setQuery}
                results={results}
                active={chosen}
                onActive={setActive}
                onChoose={choose}
                listId={listId}
              />
            </div>
            <div className="settings-nav-list">
              {SETTINGS_GROUPS.map((group) => {
                const members = shown.filter((p) => p.group === group);
                if (members.length === 0) return null;
                return (
                  <Fragment key={group}>
                    <div className="settings-nav-group" id={`${listId}-group-${group}`}>
                      {t(`settings.group.${group}`)}
                    </div>
                    <ul role="list" aria-labelledby={`${listId}-group-${group}`}>
                      {members.map((p) => {
                        const isCurrent = !searching && p === page;
                        const hits = results.filter((r) => r.page === p.id).length;
                        return (
                          <li key={p.id}>
                            <button
                              type="button"
                              className={`settings-nav-item${isCurrent ? ' is-active' : ''}`}
                              aria-current={isCurrent ? 'page' : undefined}
                              data-testid={`settings-nav-${p.id}`}
                              onClick={() => {
                                navigate(p.id);
                              }}
                            >
                              <SettingsIcon name={p.id} />
                              <span className="settings-nav-label">{t(p.title)}</span>
                              {searching ? (
                                <span className="settings-nav-count">{hits}</span>
                              ) : p.scoped ? (
                                <span
                                  className="settings-nav-scope"
                                  data-tooltip={t('settings.scoped.hint')}
                                >
                                  {t('settings.scoped')}
                                </span>
                              ) : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </Fragment>
                );
              })}
            </div>
          </nav>
        </div>
        <section className="settings-view">
          <header className="titlebar main-titlebar settings-titlebar">
            <div className="settings-crumb" aria-hidden="true">
              <span>{t('settings.title')}</span>
              <SettingsIcon name="chevron" />
              <strong>
                {searching ? t('settings.search.placeholder') : page && t(page.title)}
              </strong>
            </div>
          </header>
          <main
            ref={content}
            className="settings-page"
            data-testid={`settings-page-${page?.id ?? 'none'}`}
          >
            <div className="settings-column">
              {searching && (
                <SettingsResults
                  pages={pages}
                  query={query}
                  results={results}
                  active={chosen}
                  onActive={setActive}
                  onChoose={choose}
                  listId={listId}
                />
              )}
              {page && (
                <div className="settings-page-body" hidden={searching} key={page.id}>
                  <header className="settings-page-head">
                    <div className="settings-page-heading" hidden={headingClaims > 0}>
                      <h2 className="settings-title">{t(page.title)}</h2>
                      <p>{t(page.description)}</p>
                    </div>
                    <div
                      className="settings-page-heading"
                      ref={setHeadingSlot}
                      hidden={headingClaims === 0}
                    />
                    <div className="settings-page-actions" ref={setHeadSlot} />
                  </header>
                  <ManagedBanner />
                  <PageHeadSlot.Provider value={headSlot}>
                    <PageHeadingSlot.Provider value={heading}>
                      <page.component />
                    </PageHeadingSlot.Provider>
                  </PageHeadSlot.Provider>
                </div>
              )}
            </div>
          </main>
        </section>
      </div>
    </ManagedProvider>
  );
}
