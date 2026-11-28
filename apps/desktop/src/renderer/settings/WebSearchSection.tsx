// WebSearch's settings (T38, ADR-0055): which configured models search with their provider's
// own tool (the catalog, or the per-model setting above), the third-party search service and its
// API key, and why WebSearch is or is not offered. The key is write-only: Core keeps it in the
// vault and only says whether one is saved.
import { useCallback, useEffect, useId, useState } from 'react';

import { useT } from '../app/app-context.js';
import { reason } from '../shell/errors.js';
import type { ProviderSettings } from './provider-form.js';
import { Button } from '../app/Button.js';
import { SettingsInfo, SettingsRow, SettingsSection } from './layout.js';

interface Backend {
  readonly id: string;
  readonly name: string;
  readonly hasKey: boolean;
}

interface SearchSettings {
  readonly backend: string | null;
  readonly backends: readonly Backend[];
}

function parse(text: string): SearchSettings {
  const value: unknown = JSON.parse(text);
  const record = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!record(value) || !Array.isArray(value.backends)) throw new Error('invalid search settings');
  const backends = (value.backends as unknown[]).flatMap((b): Backend[] =>
    record(b) &&
    typeof b.id === 'string' &&
    typeof b.name === 'string' &&
    typeof b.hasKey === 'boolean'
      ? [{ id: b.id, name: b.name, hasKey: b.hasKey }]
      : [],
  );
  return { backend: typeof value.backend === 'string' ? value.backend : null, backends };
}

/** The configured models whose own search serves WebSearch. */
function nativeModels(settings: ProviderSettings): string[] {
  return settings.catalogModels
    .filter(
      (m) =>
        settings.models[`${m.provider}/${m.id}`]?.nativeWebSearch ?? m.nativeWebSearch === true,
    )
    .map((m) => m.name);
}

export function WebSearchSection({ settings }: { readonly settings: ProviderSettings }) {
  const t = useT();
  const id = useId();
  const [search, setSearch] = useState<SearchSettings>();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const reload = useCallback(() => {
    window.piarc
      .webSearchSettings()
      .then(parse)
      .then(setSearch)
      .catch((error: unknown) => {
        setFailure(reason(error));
      });
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  const run = (action: () => Promise<void>) => {
    setBusy(true);
    setFailure('');
    action()
      .then(() => {
        setKey('');
        reload();
      })
      .catch((error: unknown) => {
        setFailure(reason(error));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  if (search === undefined) return null;
  const chosen = search.backends.find((b) => b.id === search.backend);
  const native = nativeModels(settings);
  const status =
    chosen?.hasKey === true
      ? t('webSearch.status.service', { name: chosen.name })
      : native.length > 0
        ? t('webSearch.status.nativeOnly', { models: native.join(', ') })
        : chosen === undefined
          ? t('webSearch.status.unavailable')
          : t('webSearch.status.noKey', { name: chosen.name });
  return (
    <SettingsSection
      title={t('webSearch.title')}
      testId="web-search-section"
      aside={<SettingsInfo text={t('webSearch.hint')} />}
    >
      <SettingsRow
        label={t('webSearch.backend')}
        htmlFor={`${id}-backend`}
        description={
          <span data-testid="web-search-status" role="status">
            {status}
          </span>
        }
      >
        <select
          id={`${id}-backend`}
          className="input"
          data-testid="web-search-backend"
          disabled={busy}
          value={search.backend ?? ''}
          onChange={(e) => {
            const value = e.currentTarget.value;
            run(() => window.piarc.setWebSearchBackend(value === '' ? null : value));
          }}
        >
          <option value="">{t('webSearch.backend.none')}</option>
          {search.backends.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </SettingsRow>
      {chosen === undefined ? null : (
        <form
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            if (key.trim() === '') return;
            run(() => window.piarc.setWebSearchKey(chosen.id, key.trim()));
          }}
        >
          <SettingsRow label={t('webSearch.key', { name: chosen.name })} htmlFor={`${id}-key`}>
            <input
              id={`${id}-key`}
              className="input"
              type="password"
              data-testid="web-search-key"
              placeholder={t(chosen.hasKey ? 'webSearch.key.saved' : 'webSearch.key.placeholder')}
              value={key}
              disabled={busy}
              onChange={(e) => {
                setKey(e.currentTarget.value);
              }}
            />
            <Button
              type="submit"
              variant="primary"
              data-testid="web-search-key-save"
              disabled={busy || key.trim() === ''}
            >
              {t('webSearch.key.save')}
            </Button>{' '}
            {chosen.hasKey ? (
              <Button
                variant="destructive"
                size="small"
                data-testid="web-search-key-remove"
                disabled={busy}
                onClick={() => {
                  run(() => window.piarc.setWebSearchKey(chosen.id, null));
                }}
              >
                {t('webSearch.key.remove')}
              </Button>
            ) : null}
          </SettingsRow>
        </form>
      )}
      {failure === '' ? null : (
        <p className="error-text" role="alert">
          {t('webSearch.failed', { reason: failure })}
        </p>
      )}
    </SettingsSection>
  );
}
