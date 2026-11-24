// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES } from '../../shared/preferences.js';
import { AppProvider } from '../app/app-context.js';
import { Home } from './Home.js';

const { show } = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('./ui.js', () => ({
  baseName: (path: string) => path,
  useUi: () => ({ show }),
}));
vi.mock('../store/hooks.js', () => ({
  useStore: () => ({ editorDraft: () => ({}) }),
  useWorkspaces: () =>
    ['/a', '/b', '/c'].map((path) => ({ path, displayName: path.slice(1), open: false })),
}));

it('the shell owns the target after switching from a recent folder to a different route', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('piarc', { onAppEvent: () => () => undefined });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (workspace: string) => {
    act(() => {
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
          <Home workspace={workspace} draft={undefined} failure={undefined} />
        </AppProvider>,
      );
    });
  };
  const folder = () => host.querySelector<HTMLButtonElement>('[data-testid="home-workspace"]');
  try {
    render('/a');
    act(() => folder()?.click());
    act(() => host.querySelector<HTMLElement>('[data-testid="menu-/b"]')?.click());
    render('/c');
    expect(folder()?.value).toBe('/c');
    expect(show).toHaveBeenCalledWith({ kind: 'home', workspace: '/b' });
  } finally {
    act(() => {
      root.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
  }
});
