// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { DEFAULT_PREFERENCES } from '../../../shared/preferences.js';
import { AppProvider } from '../../app/app-context.js';
import { MarketView } from './MarketView.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const status = { state: 'idle', done: 0, total: 0, classified: 1, indexed: 1, syncedAt: 1 };
const page = (...names: string[]) =>
  JSON.stringify({
    entries: names.map((name) => ({ name, version: '1.0.0', kinds: ['skill'] })),
    total: names.length,
    counts: { all: names.length, extension: 0, skill: names.length, prompt: 0 },
    status,
    live: true,
  });

let dom: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  dom = document.createElement('div');
  document.body.append(dom);
  root = createRoot(dom);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  dom.remove();
  vi.useRealTimers();
});

function mount(
  query: ReturnType<typeof vi.fn>,
  extra: Record<string, unknown> = {},
  trusted = true,
) {
  Object.assign(window, {
    piarc: {
      marketQuery: query,
      marketRefresh: vi.fn().mockResolvedValue(undefined),
      subscribeEvents: vi.fn().mockResolvedValue(undefined),
      unsubscribeEvents: vi.fn().mockResolvedValue(undefined),
      onAppEvent: () => () => undefined,
      ...extra,
    },
  });
  return act(async () => {
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
        <MarketView target={{ workspace: '/w', trusted }} onPackage={() => undefined} />
      </AppProvider>,
    );
    await vi.advanceTimersByTimeAsync(0);
  });
}

function type(text: string) {
  const input = dom.querySelector<HTMLInputElement>('[data-testid="market-search"]');
  if (input === null) throw new Error('no search field');
  // React tracks the value it set; the native setter makes the change visible to it.
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  descriptor?.set?.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const names = () =>
  [...dom.querySelectorAll('[data-testid="market-row"]')].map((row) =>
    row.getAttribute('data-name'),
  );

it('asks once per pause in typing and never shows an older answer over a newer one', async () => {
  const slow = Promise.withResolvers<string>();
  const query = vi.fn((q: { query: string }) =>
    q.query === 'sl'
      ? slow.promise
      : Promise.resolve(page(q.query === '' ? 'top' : `hit-${q.query}`)),
  );
  await mount(query);
  expect(names()).toEqual(['top']);
  expect(query).toHaveBeenCalledTimes(1);

  act(() => {
    type('s');
  });
  await act(() => vi.advanceTimersByTimeAsync(100));
  act(() => {
    type('sl');
  });
  await act(() => vi.advanceTimersByTimeAsync(250));
  // "s" was never asked for; "sl" is in flight.
  expect(query.mock.calls.map(([q]) => q.query)).toEqual(['', 'sl']);

  act(() => {
    type('slo');
  });
  await act(() => vi.advanceTimersByTimeAsync(250));
  expect(names()).toEqual(['hit-slo']);
  await act(async () => {
    slow.resolve(page('stale'));
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(names()).toEqual(['hit-slo']);
});

it('installs the catalog’s version for every project and keeps project-only behind trust', async () => {
  const install = vi.fn().mockResolvedValue('{}');
  await mount(vi.fn().mockResolvedValue(page('pi-tools')), { marketInstall: install }, false);
  const button = dom.querySelector<HTMLButtonElement>('[data-testid="market-action-pi-tools"]');
  expect(button?.dataset.action).toBe('install');
  await act(async () => {
    button?.click();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(install).toHaveBeenCalledWith({
    name: 'pi-tools',
    version: '1.0.0',
    scope: 'user',
    workspace: null,
  });
  expect(dom.querySelector('[data-testid="market-notice"]')?.textContent).toContain('installed');

  await act(async () => {
    dom.querySelector<HTMLButtonElement>('[data-testid="market-action-pi-tools-more"]')?.click();
    await vi.advanceTimersByTimeAsync(0);
  });
  const project = document.querySelector<HTMLElement>(
    '[data-testid="market-action-pi-tools-project"]',
  );
  expect(project).toBeTruthy();
  expect(
    project?.getAttribute('aria-disabled') === 'true' || project?.hasAttribute('disabled'),
  ).toBe(true);
});
