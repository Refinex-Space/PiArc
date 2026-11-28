// @vitest-environment happy-dom
// Mount the actual window with an external launch target already waiting after cold start.
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { AppEvent, LaunchTarget } from '../../shared/ipc.js';
import { DEFAULT_PREFERENCES } from '../../shared/preferences.js';
import { AppProvider } from '../app/app-context.js';
import { Shell } from './Shell.js';

it('presents external text for editing only after a trust decision and never sends it', async () => {
  const path = '/test/workspace';
  const text = '/help <b>quoted</b> & 中文';
  const target: LaunchTarget = { kind: 'draft', path, text };
  const listeners = new Set<(event: AppEvent) => void>();
  const createSession = vi.fn();
  const prompt = vi.fn();
  const api = {
    takeLaunchTargets: vi.fn().mockResolvedValueOnce([target]).mockResolvedValue([]),
    onAppEvent: (f: (event: AppEvent) => void) => {
      listeners.add(f);
      return () => {
        listeners.delete(f);
      };
    },
    openWorkspace: vi.fn((dir: string) => Promise.resolve(JSON.stringify({ path: dir }))),
    chooseFolder: vi.fn().mockResolvedValue('/another'),
    projectTrust: vi.fn().mockResolvedValue('{"version":"1"}'),
    decideProjectTrust: vi
      .fn()
      .mockResolvedValue('{"version":"2","decision":"denied","applied":true}'),
    setAttentionCount: vi.fn().mockResolvedValue(undefined),
    subscribeEvents: vi.fn().mockResolvedValue(undefined),
    unsubscribeEvents: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue('{"state":"idle","current":"1.0.0"}'),
    resendSnapshots: vi.fn().mockResolvedValue(undefined),
    composerInfo: vi.fn().mockResolvedValue('{}'),
    createSession,
    prompt,
  };
  vi.stubGlobal('piarc', api);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('Worker', EventTarget);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <StrictMode>
          <AppProvider
            initial={{
              platform: 'win32',
              focused: true,
              notificationsSupported: false,
              locale: 'en',
              preferences: DEFAULT_PREFERENCES,
            }}
          >
            <Shell />
          </AppProvider>
        </StrictMode>,
      );
      await Promise.resolve();
    });
    expect(api.openWorkspace).toHaveBeenCalledWith(path);
    const draft = () => container.querySelector<HTMLElement>('[data-testid="home-input"]');
    expect(draft()?.textContent).toBe('');
    const restricted = container.querySelector<HTMLButtonElement>('[data-testid="trust-deny"]');
    expect(restricted?.disabled).toBe(false);
    await act(async () => {
      restricted?.click();
      await Promise.resolve();
    });
    expect(draft()?.textContent).toBe(text);
    expect(draft()?.getAttribute('contenteditable')).toBe('true');
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('[data-testid="session-row"]')).toBeNull();
    // The jump-list tasks reach the same listener as a later second-instance event.
    for (const kind of ['newSession', 'chooseFolder'] as const) {
      api.projectTrust.mockResolvedValue('{"version":"2","decision":"denied"}');
      await act(async () => {
        for (const listener of listeners) listener({ type: 'launch', target: { kind } });
        await Promise.resolve();
      });
      expect(draft()?.textContent).toBe('');
    }
    expect(api.chooseFolder).toHaveBeenCalledOnce();
    expect(api.openWorkspace).toHaveBeenLastCalledWith('/another');
    expect(createSession).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  } finally {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  }
});
