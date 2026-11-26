// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES } from '../../shared/preferences.js';
import { AppProvider } from '../app/app-context.js';
import { ModelSettingsSection } from './ModelSettingsSection.js';
import type { CatalogEntry, ProviderSettings } from './provider-form.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

it('offers only the supported server strategies and preserves the other per-model settings on save', () => {
  Object.assign(window, { piarc: { onAppEvent: () => () => undefined } });
  const dom = document.createElement('div');
  const root = createRoot(dom);
  const save = vi.fn();
  const model: CatalogEntry = {
    provider: 'anthropic',
    id: 'example',
    name: 'Example',
    contextWindow: 100000,
    vision: false,
    efforts: [],
    toolReliability: 'unknown',
    serverContextEdits: ['clearTools'],
  };
  const key = 'anthropic/example';
  const settings: ProviderSettings = {
    providers: [],
    builtinProviders: [],
    loginProviders: [],
    catalogModels: [model],
    models: { [key]: { displayName: 'Work' } },
    aliases: {},
    disabled: [],
    accounts: [],
    auxiliary: null,
    auxiliaryAlias: null,
    catalogRefresh: false,
  };
  try {
    act(() => {
      root.render(
        <AppProvider
          initial={{
            platform: 'darwin',
            preferences: DEFAULT_PREFERENCES,
            locale: 'en',
            focused: true,
            notificationsSupported: true,
          }}
        >
          <ModelSettingsSection settings={settings} save={save} busy={false} />
        </AppProvider>,
      );
    });
    const edit = dom.querySelector<HTMLButtonElement>(
      '[data-testid="model-edit-anthropic/example"]',
    );
    expect(edit).toBeTruthy();
    act(() => {
      edit?.click();
    });
    const select = dom.querySelector<HTMLSelectElement>('select[id$="-compaction"]');
    expect(select && Array.from(select.options, (option) => option.value)).toEqual([
      '',
      'clearTools',
    ]);
    if (!select) throw new Error('Missing context management setting');
    act(() => {
      select.value = 'clearTools';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    act(() => {
      dom
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(save).toHaveBeenCalledWith(
      JSON.stringify({
        models: { [key]: { serverContextEdit: 'clearTools', displayName: 'Work' } },
        aliases: {},
      }),
    );
  } finally {
    act(() => {
      root.unmount();
    });
  }
});
