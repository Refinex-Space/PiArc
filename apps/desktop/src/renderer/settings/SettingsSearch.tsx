// Settings search (ADR-0101): the field sits at the top of the settings navigation, the results
// fill the page area. Enter opens the chosen setting's page and focuses its control.
import { Fragment, useEffect, useRef } from 'react';
import type { MessageId } from '../../shared/i18n/index.js';
import { useT } from '../app/app-context.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { SettingsIcon } from './SettingsIcon.js';
import type { SettingsPage } from './registry.js';

// Index setting names, never user values, credentials or paths.
// An optional third entry is another name people search the setting by.
export const SEARCH_FIELDS: Record<
  string,
  readonly (readonly [MessageId, string] | readonly [MessageId, string, MessageId])[]
> = {
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
    ['settings.theme.title', 'setting-theme', 'settings.theme'],
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
  voice: [
    ['settings.voice.device', 'voice-device'],
    ['settings.voice.mode', 'voice-mode'],
    ['settings.voice.modelEnhanced', 'voice-model-enhanced'],
    ['settings.voice.punctuation', 'voice-punctuation'],
    ['settings.voice.dictionary', 'voice-dictionary'],
  ],
  diagnostics: [['diagnostics.bundle.title', 'diagnostic-bundle']],
  memory: [
    ['memory.userEnabled', 'memory-user-enabled'],
    ['memory.import.button', 'memory-import'],
  ],
};

export interface SearchResult {
  readonly page: string;
  readonly label: MessageId;
  /** The field's test id; empty for the page itself. */
  readonly target: string;
}

/** The pages and settings whose name contains every word of `query`. */
export function searchSettings(
  pages: readonly SettingsPage[],
  query: string,
  t: (id: MessageId) => string,
): readonly SearchResult[] {
  const words = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return [];
  return pages
    .flatMap((p) => [
      { page: p.id, label: p.title, target: '' },
      ...(SEARCH_FIELDS[p.id] ?? []).map(([label, target, alias]) => ({
        page: p.id,
        label,
        target,
        ...(alias === undefined ? {} : { alias }),
      })),
    ])
    .filter((item: SearchResult & { readonly alias?: MessageId }) => {
      const page = t(pages.find((p) => p.id === item.page)?.title ?? item.label);
      const alias = item.alias === undefined ? '' : t(item.alias);
      const text = `${t(item.label)} ${alias} ${page}`;
      return words.every((word) => text.toLowerCase().includes(word));
    });
}

/** `text` with the first occurrence of the query's first word marked. */
export function Marked({ text, query }: { readonly text: string; readonly query: string }) {
  const word = query.trim().split(/\s+/u)[0] ?? '';
  const at = word ? text.toLowerCase().indexOf(word.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + word.length)}</mark>
      {text.slice(at + word.length)}
    </>
  );
}

export function SettingsSearchField({
  query,
  onQuery,
  results,
  active,
  onActive,
  onChoose,
  listId,
}: {
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly results: readonly SearchResult[];
  readonly active: number;
  readonly onActive: (index: number) => void;
  readonly onChoose: (index: number) => void;
  readonly listId: string;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const searching = query.trim() !== '';
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
    const find = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === 'f' &&
        !isImeComposing(e) &&
        !document.querySelector('.settings-surface :is(dialog[open], [role="dialog"])')
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
  return (
    <div className="settings-search">
      <SettingsIcon name="search" />
      <input
        data-focus-proxy
        ref={input}
        role="combobox"
        aria-label={t('settings.search')}
        placeholder={t('settings.search.placeholder')}
        aria-controls={listId}
        aria-expanded={searching}
        aria-autocomplete="list"
        aria-activedescendant={
          searching && results.length > 0 ? `${listId}-${String(active)}` : undefined
        }
        value={query}
        onChange={(e) => {
          onQuery(e.currentTarget.value);
          onActive(0);
        }}
        onKeyDown={(e) => {
          if (!searching || isImeComposing(e.nativeEvent)) return;
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onQuery('');
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            onChoose(active);
          }
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && results.length) {
            e.preventDefault();
            onActive((active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
          }
        }}
      />
    </div>
  );
}

/** The results in the page area, grouped by page in navigation order. */
export function SettingsResults({
  pages,
  query,
  results,
  active,
  onActive,
  onChoose,
  listId,
}: {
  readonly pages: readonly SettingsPage[];
  readonly query: string;
  readonly results: readonly SearchResult[];
  readonly active: number;
  readonly onActive: (index: number) => void;
  readonly onChoose: (index: number) => void;
  readonly listId: string;
}) {
  const t = useT();
  useEffect(() => {
    document.getElementById(`${listId}-${String(active)}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, listId, query]);
  return (
    <section className="settings-results-page" data-testid="settings-results">
      <header className="settings-page-head">
        <div className="settings-page-heading">
          <h2 className="settings-title">“{query.trim()}”</h2>
          <p>
            {results.length === 0
              ? t('settings.search.empty')
              : `${t('settings.results', { count: results.length })} · ${t('settings.results.keys')}`}
          </p>
        </div>
      </header>
      <div
        id={listId}
        className="settings-results"
        role="listbox"
        aria-label={t('settings.search')}
      >
        {pages.map((page) => {
          const hits = results
            .map((result, index) => ({ result, index }))
            .filter(({ result }) => result.page === page.id);
          if (hits.length === 0) return null;
          return (
            <Fragment key={page.id}>
              <div className="settings-results-group" role="presentation">
                <SettingsIcon name={page.id} />
                {t(page.title)}
              </div>
              {hits.map(({ result, index }) => (
                <div
                  key={`${result.page}-${result.label}`}
                  id={`${listId}-${String(index)}`}
                  role="option"
                  className="settings-result"
                  aria-selected={active === index}
                  onMouseDown={(e) => {
                    e.preventDefault();
                  }}
                  onMouseMove={() => {
                    onActive(index);
                  }}
                  onClick={() => {
                    onChoose(index);
                  }}
                >
                  <span className="settings-result-label">
                    <Marked text={t(result.label)} query={query} />
                  </span>
                  <SettingsIcon name="chevron" />
                </div>
              ))}
            </Fragment>
          );
        })}
      </div>
    </section>
  );
}
