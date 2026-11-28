// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import type { AppEvent } from '../../shared/ipc.js';
import { DEFAULT_PREFERENCES } from '../../shared/preferences.js';
import { AppProvider } from '../app/app-context.js';
import { rememberMemoryTarget, takeMemoryTarget } from '../settings/memory-target.js';
import { Shell } from './Shell.js';

// Only the page contents stand in for Core. The workbench, routing and settings layer are real.
vi.mock('../settings/pages.js', () => ({ registerBuiltInSettingsPages: vi.fn() }));
vi.mock('../settings/SettingsSurface.js', () => ({
  SettingsSurface: () => {
    const [target] = useState(takeMemoryTarget);
    return <p data-note={target?.note} />;
  },
}));

it('retargets open settings on the same page and closes them before handling workbench commands', async () => {
  const listeners = new Set<(event: AppEvent) => void>();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('Worker', EventTarget);
  vi.stubGlobal('piarc', {
    takeLaunchTargets: vi.fn().mockResolvedValue([]),
    onAppEvent(listener: (event: AppEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setAttentionCount: vi.fn().mockResolvedValue(undefined),
    subscribeEvents: vi.fn().mockResolvedValue(undefined),
    unsubscribeEvents: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue('{"state":"idle","current":"1.0.0"}'),
    resendSnapshots: vi.fn().mockResolvedValue(undefined),
    composerInfo: vi.fn().mockResolvedValue('{}'),
  });
  const send = async (event: AppEvent) => {
    await act(async () => {
      for (const listener of listeners) listener(event);
      await Promise.resolve();
    });
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    window.history.replaceState(null, '', '#/settings/memory');
    rememberMemoryTarget({ workspace: 'project', note: 'first' });
    await act(async () => {
      root.render(
        <AppProvider
          initial={{
            platform: 'darwin',
            focused: true,
            notificationsSupported: false,
            locale: 'en',
            preferences: DEFAULT_PREFERENCES,
          }}
        >
          <Shell />
        </AppProvider>,
      );
      await Promise.resolve();
    });
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    const layer = host.querySelector('.settings-layer[data-open="true"]');
    expect(layer?.querySelector('[data-note="first"]')).toBeTruthy();
    // The workbench stays mounted underneath and takes no input (ADR-0101).
    expect(host.querySelector('[data-testid="app-shell"]')?.hasAttribute('inert')).toBe(true);

    await send({ type: 'command', command: 'app.commandPalette' });
    expect(host.querySelector('[data-testid="global-search"]')).toBeNull();
    rememberMemoryTarget({ workspace: 'project', note: 'second' });
    await send({ type: 'launch', target: { kind: 'settings', page: 'memory' } });
    expect(host.querySelector('.settings-layer[data-open="true"]')).toBe(layer);
    expect(layer?.querySelector('[data-note="second"]')).toBeTruthy();

    await send({ type: 'command', command: 'session.close' });
    expect(host.querySelector('.settings-layer[data-open="true"]')).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(host.querySelector('.settings-layer')).toBeNull();
    expect(host.querySelector('[data-testid="app-shell"]')?.hasAttribute('inert')).toBe(false);
    expect(window.location.hash).toBe('');
    expect(host.querySelector('[data-testid="app-shell"]')).toBeTruthy();
  } finally {
    act(() => {
      root.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
  }
});
