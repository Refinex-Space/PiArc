// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { DEFAULT_PREFERENCES } from '../../shared/preferences.js';
import { AppProvider } from '../app/app-context.js';
import { ConfigDiagnosticsPage } from './ConfigDiagnosticsPage.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

it('refreshes a visible report without file events and checks it again on return', async () => {
  vi.useFakeTimers();
  const report = (workspace: string) =>
    JSON.stringify({ workspaces: [workspace], workspace, files: [] });
  const read = vi.fn().mockResolvedValue(report('/original'));
  Object.assign(window, {
    piarc: {
      configDiagnostics: read,
      subscribeEvents: vi.fn().mockResolvedValue(undefined),
      unsubscribeEvents: vi.fn().mockResolvedValue(undefined),
      onAppEvent: () => () => undefined,
    },
  });
  const dom = document.createElement('div');
  const root = createRoot(dom);
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const workspace = () => dom.querySelector<HTMLSelectElement>('select')?.value;
  try {
    await act(async () => {
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
          <ConfigDiagnosticsPage />
        </AppProvider>,
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(workspace()).toBe('/original');
    read.mockResolvedValue(report('/edited'));
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(workspace()).toBe('/edited');

    visibility.mockReturnValue('hidden');
    const calls = read.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(read).toHaveBeenCalledTimes(calls);
    read.mockResolvedValue(report('/returned'));
    visibility.mockReturnValue('visible');
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(workspace()).toBe('/returned');

    // A manual refresh and a focus event during a slow read request one follow-up.
    const slow = Promise.withResolvers<string>();
    read.mockReturnValueOnce(slow.promise).mockResolvedValue(report('/latest'));
    const before = read.mock.calls.length;
    const refresh = dom.querySelector<HTMLButtonElement>('[data-testid="diagnostics-refresh"]');
    expect(refresh).toBeTruthy();
    act(() => {
      refresh?.click();
      refresh?.click();
      window.dispatchEvent(new Event('focus'));
    });
    expect(read).toHaveBeenCalledTimes(before + 1);
    await act(async () => {
      slow.resolve(report('/slow'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(read).toHaveBeenCalledTimes(before + 2);
    expect(workspace()).toBe('/latest');
  } finally {
    act(() => {
      root.unmount();
    });
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});
