// Registered pages share the same shell and hash routes, including links to a filtered audit.
import { useEffect, useRef, useState } from 'react';

import { useT } from '../app/app-context.js';
import { ManagedBanner, ManagedProvider } from './managed.js';
import { settingsPages } from './registry.js';
import { SettingsIcon } from './SettingsIcon.js';
import { SettingsSearch } from './SettingsSearch.js';

function pageFromHash(): string | undefined {
  return /^#\/settings\/([a-zA-Z0-9.-]+)(?:\?[a-zA-Z0-9=&.-]*)?$/.exec(window.location.hash)?.[1];
}

export function SettingsApp({ onClose }: { readonly onClose?: () => void } = {}) {
  const t = useT();
  const pages = settingsPages();
  const [current, setCurrent] = useState(() => pageFromHash() ?? pages[0]?.id);
  const [target, setTarget] = useState<{ field: string }>();
  const content = useRef<HTMLElement>(null);
  useEffect(() => {
    const onHash = () => {
      const id = pageFromHash();
      if (id) {
        setCurrent(id);
        setTarget(undefined);
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
      field.scrollIntoView({ block: 'nearest' });
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
    setCurrent(id);
    setTarget(field ? { field } : undefined);
    window.history.replaceState(null, '', '#/settings/' + id);
  };
  return (
    <ManagedProvider page={page?.id}>
      <div className="settings" data-testid="settings-window">
        <header className="settings-header">
          <h1>{t('settings.title')}</h1>
          <button
            type="button"
            className="icon-button settings-close"
            data-testid="settings-close"
            aria-label={t('settings.close')}
            onClick={onClose}
          >
            <SettingsIcon name="close" />
          </button>
        </header>
        <nav className="settings-nav" aria-label={t('settings.pages')}>
          <SettingsSearch pages={pages} open={navigate} />
          <ul className="interactive-list">
            {pages.map((p) => (
              <li
                key={p.id}
                className={
                  ['appearance', 'permissions', 'diagnostics'].includes(p.id)
                    ? 'settings-group-start'
                    : undefined
                }
              >
                <button
                  type="button"
                  className={`settings-nav-item${p === page ? ' is-active' : ''}`}
                  aria-current={p === page ? 'page' : undefined}
                  data-testid={`settings-nav-${p.id}`}
                  title={t(p.title)}
                  onClick={() => {
                    navigate(p.id);
                  }}
                >
                  <SettingsIcon name={p.id} />
                  <span>{t(p.title)}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <main
          ref={content}
          className="settings-page"
          data-testid={`settings-page-${page?.id ?? 'none'}`}
        >
          {page && (
            <>
              <h2 className="settings-title">{t(page.title)}</h2>
              <ManagedBanner />
              <page.component />
            </>
          )}
        </main>
      </div>
    </ManagedProvider>
  );
}
