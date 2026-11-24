// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES } from '../../shared/preferences.js';
import { AppProvider } from '../app/app-context.js';
import { FileTree } from './FileTree.js';
import { listProjectFiles, type ProjectEntry } from './api.js';

vi.mock('./api.js', () => ({
  listProjectFiles: vi.fn(),
  searchProjectFiles: vi.fn(),
  cancelProjectSearch: vi.fn(),
}));

it('keeps thousands of files out of the viewport DOM and applies keyboard and context actions to the selected path', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('piarc', { onAppEvent: () => vi.fn() });
  const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(224);
  const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(240);
  const entries: ProjectEntry[] = Array.from({ length: 6000 }, (_, i) => ({
    path: 'item-' + String(i) + '.md',
    name: 'item-' + String(i) + '.md',
    kind: 'file',
  }));
  vi.mocked(listProjectFiles).mockResolvedValue({ entries, truncated: false });
  const onOpen = vi.fn(),
    onAttach = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  async function settle(change: () => void) {
    await act(async () => {
      change();
      await Promise.resolve();
    });
  }
  try {
    await settle(() => {
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
          <FileTree
            sessionId="session"
            root="/tmp/tree"
            activePath={null}
            onOpen={onOpen}
            actions={{ onAttach, onReveal: vi.fn() }}
          />
        </AppProvider>,
      );
    });
    const tree = host.querySelector<HTMLElement>('[role=tree]');
    if (!tree) throw new Error('Missing tree');
    const key = (value: string, shiftKey = false) => {
      tree.dispatchEvent(
        new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true }),
      );
    };
    expect(tree.querySelectorAll('[role=treeitem]').length).toBeGreaterThan(1);
    expect(tree.querySelectorAll('[role=treeitem]').length).toBeLessThan(32);
    await settle(() => {
      tree.focus();
      key('End');
    });
    await settle(() => {
      key('Enter');
    });
    expect(onOpen).toHaveBeenCalledWith('item-5999.md', { pinned: true });
    await settle(() => {
      key('ArrowUp', true);
    });
    await settle(() => {
      key('F10', true);
    });
    const attach = document.querySelector<HTMLElement>('[data-testid=menu-attach]');
    if (!attach) throw new Error('Missing context menu');
    await settle(() => {
      attach.click();
    });
    expect(onAttach).toHaveBeenCalledWith(['item-5998.md', 'item-5999.md']);
    expect(document.activeElement).toBe(tree);
  } finally {
    act(() => {
      root.unmount();
    });
    host.remove();
    height.mockRestore();
    width.mockRestore();
    vi.unstubAllGlobals();
  }
});
