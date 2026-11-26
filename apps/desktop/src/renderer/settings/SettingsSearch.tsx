import { useEffect, useId, useRef, useState } from 'react';
import type { MessageId } from '../../shared/i18n/index.js';
import { useT } from '../app/app-context.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { SettingsIcon } from './SettingsIcon.js';
import type { SettingsPage } from './registry.js';

// Index setting names, never user values, credentials or paths.
const fields: Record<string, readonly (readonly [MessageId, string])[]> = {
  general: [
    ['settings.language', 'setting-language'],
    ['settings.notifications', 'setting-notifications'],
    ['settings.memory', 'setting-memory-read-both'],
  ],
  markdown: [
    ['files.images.storage', 'markdown-image-storage'],
    ['files.images.location', 'markdown-image-location'],
    ['files.images.links', 'markdown-image-link'],
  ],
  appearance: [
    ['settings.theme', 'setting-theme'],
    ['settings.contrast', 'setting-contrast'],
    ['settings.density', 'setting-density'],
    ['settings.reduceMotion', 'setting-reduceMotion'],
  ],
  permissions: [
    ['permissions.auto.title', 'auto-review-section'],
    ['permissions.audit', 'permission-audit'],
    ['permissions.bypass.enable', 'setting-enable-bypass'],
  ],
  providers: [
    ['models.aliases.title', 'alias-section'],
    ['providers.signIn.title', 'provider-connections'],
    ['providers.refresh', 'catalog-refresh'],
    ['models.settings.title', 'model-settings-section'],
    ['webSearch.title', 'web-search-section'],
  ],
  sandbox: [
    ['sandbox.mode', 'sandbox-mode'],
    ['sandbox.domains', 'sandbox-domains'],
  ],
  usage: [
    ['usage.sessions', 'usage-sessions'],
    ['usage.models', 'usage-models'],
    ['usage.overview', 'usage-summary'],
  ],
  agents: [['agents.title', 'agent-list']],
  mcp: [
    ['mcp.title', 'mcp-servers'],
    ['mcp.issues', 'mcp-issues'],
  ],
  skills: [
    ['skills.title', 'skill-list'],
    ['plugins.title', 'plugins-section'],
  ],
  diagnostics: [['diagnostics.bundle.title', 'diagnostic-bundle']],
  memory: [
    ['memory.userEnabled', 'memory-user-enabled'],
    ['memory.import.button', 'memory-import'],
  ],
};
export function SettingsSearch({
  pages,
  open,
}: {
  readonly pages: readonly SettingsPage[];
  readonly open: (id: string, target?: string) => void;
}) {
  const t = useT(),
    input = useRef<HTMLInputElement>(null),
    listId = useId();
  const [query, setQuery] = useState(''),
    [index, setIndex] = useState(0);
  const normalized = query.trim().toLowerCase();
  const results = pages
    .flatMap((p) => [
      { page: p.id, label: p.title, target: '' },
      ...(fields[p.id] ?? []).map(([label, target]) => ({ page: p.id, label, target })),
    ])
    .filter((item) => normalized && t(item.label).toLowerCase().includes(normalized));
  const active = Math.min(index, results.length - 1);
  const choose = (i: number) => {
    const item = results[i];
    if (item) {
      setQuery('');
      open(item.page, item.target);
    }
  };
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
    const find = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === 'f' &&
        !isImeComposing(e) &&
        !input.current?.closest('dialog')?.querySelector('[aria-modal="true"]')
      ) {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener('keydown', find);
    return () => {
      window.removeEventListener('keydown', find);
    };
  }, []);
  useEffect(() => {
    document.getElementById(listId + '-' + String(active))?.scrollIntoView({ block: 'nearest' });
  }, [active, listId, query]);
  return (
    <div
      className="settings-search"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setQuery('');
      }}
    >
      <SettingsIcon name="search" />
      <input
        data-focus-proxy
        ref={input}
        role="combobox"
        aria-label={t('settings.search')}
        placeholder={t('settings.search.placeholder')}
        aria-controls={listId}
        aria-expanded={Boolean(normalized)}
        aria-autocomplete="list"
        aria-activedescendant={
          normalized && active >= 0 ? listId + '-' + String(active) : undefined
        }
        value={query}
        onChange={(e) => {
          setQuery(e.currentTarget.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          if (!normalized || isImeComposing(e.nativeEvent)) return;
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setQuery('');
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            choose(active);
          }
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && results.length) {
            e.preventDefault();
            setIndex((active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
          }
        }}
      />
      <div
        id={listId}
        className="settings-results"
        role="listbox"
        aria-label={t('settings.search')}
        hidden={!normalized}
      >
        {results.map((r, i) => (
          <div
            key={r.page + '-' + r.label}
            role="option"
            id={listId + '-' + String(i)}
            aria-selected={active === i}
            onMouseDown={(e) => {
              e.preventDefault();
            }}
            onMouseMove={() => {
              setIndex(i);
            }}
            onClick={() => {
              choose(i);
            }}
          >
            {t(r.label)}
          </div>
        ))}
        {normalized && !results.length && (
          <div role="option" aria-disabled="true" aria-selected="false">
            {t('settings.search.empty')}
          </div>
        )}
      </div>
    </div>
  );
}
