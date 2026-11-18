// The settings window (architecture section 8.2): navigation from the registered pages
// (`registry.ts`), one page at a time. The hash `#/settings/<page>` selects the page.
import { useEffect, useState } from 'react';

import { useT } from '../app/app-context.js';
import { settingsPages } from './registry.js';

function pageFromHash(): string | undefined {
  const match = /^#\/settings\/([a-zA-Z0-9.-]+)$/.exec(window.location.hash);
  return match?.[1];
}

export function SettingsApp() {
  const t = useT();
  const pages = settingsPages();
  const [current, setCurrent] = useState(() => pageFromHash() ?? pages[0]?.id);
  useEffect(() => {
    document.title = t('settings.title');
  }, [t]);
  useEffect(() => {
    const onHash = () => {
      const page = pageFromHash();
      if (page !== undefined) {
        setCurrent(page);
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
    };
  }, []);
  const page = pages.find((p) => p.id === current) ?? pages[0];
  return (
    <div className="settings" data-testid="settings-window">
      <nav className="settings-nav" aria-label={t('settings.pages')}>
        <ul>
          {pages.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className={`settings-nav-item${p === page ? ' is-active' : ''}`}
                aria-current={p === page ? 'page' : undefined}
                data-testid={`settings-nav-${p.id}`}
                onClick={() => {
                  setCurrent(p.id);
                }}
              >
                {t(p.title)}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <main className="settings-page" data-testid={`settings-page-${page?.id ?? 'none'}`}>
        {page !== undefined && (
          <>
            <h1 className="settings-title">{t(page.title)}</h1>
            <page.component />
          </>
        )}
      </main>
    </div>
  );
}
