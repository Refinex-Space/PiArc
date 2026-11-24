// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES } from '../../shared/preferences.js';
import { AppProvider } from '../app/app-context.js';
import { FileViewer } from './FileViewer.js';
import { readProjectFile } from './api.js';
vi.mock('./api.js', () => ({ readProjectFile: vi.fn(), saveProjectFile: vi.fn() }));
vi.mock('../shell/ui.js', () => {
  const context = {
    transcriptServices: { highlight: { highlight: vi.fn().mockResolvedValue(null) } },
    addToast: vi.fn(),
  };
  return { useUi: () => context };
});

it('virtualizes a large source and attaches the exact range from the gutter to the current draft', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('piarc', { onAppEvent: () => vi.fn() });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(20);
  const lines = Array.from({ length: 8000 }, (_, i) => 'Line ' + String(i + 1));
  vi.mocked(readProjectFile).mockResolvedValue({
    kind: 'text',
    path: 'sample.txt',
    size: 80000,
    editable: true,
    text: lines.join('\n'),
    revision: 'v1',
  });
  const attach = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
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
          <FileViewer sessionId="viewer" path="sample.txt" onAttach={attach} />
        </AppProvider>,
      );
      await Promise.resolve();
    });
    const numbered = host.querySelectorAll<HTMLButtonElement>('.file-line-number');
    expect(numbered.length).toBeGreaterThan(3);
    expect(numbered.length).toBeLessThan(60);
    act(() => {
      numbered[1]?.click();
    });
    act(() => {
      numbered[3]?.dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true }));
    });
    const add = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Add selection to chat',
    );
    expect(add).toBeDefined();
    act(() => {
      add?.click();
    });
    expect(attach).toHaveBeenCalledExactlyOnceWith('sample.txt', {
      startLine: 2,
      endLine: 4,
      text: 'Line 2\nLine 3\nLine 4',
    });
  } finally {
    act(() => {
      root.unmount();
    });
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it('releases a mounted document preview when it becomes a background tab', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const preview = vi.fn((_id: string, _path: string, action: string) =>
    Promise.resolve(action === 'release' ? '' : 'about:blank'),
  );
  vi.stubGlobal('piarc', { onAppEvent: () => vi.fn(), projectFilePreview: preview });
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue(
    Object.assign([new DOMRect(0, 0, 400, 300)], {
      item: (index: number) => (index === 0 ? new DOMRect(0, 0, 400, 300) : null),
    }),
  );
  vi.mocked(readProjectFile).mockResolvedValue({
    kind: 'pdf',
    path: 'report.pdf',
    size: 500,
    editable: false,
  });
  const host = document.createElement('div');
  // Keep this unit fixture detached so the DOM emulator does not attempt to load a PDF.
  const root = createRoot(host);
  async function show(visible: boolean) {
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
          <FileViewer
            visible={visible}
            sessionId="visibility"
            path="report.pdf"
            onAttach={vi.fn()}
          />
        </AppProvider>,
      );
      await Promise.resolve();
    });
  }
  try {
    await show(true);
    expect(preview).toHaveBeenCalledWith('visibility', 'report.pdf', 'media');
    expect(host.querySelector('iframe')).not.toBeNull();
    await show(false);
    expect(host.querySelector('iframe')).toBeNull();
    expect(preview).toHaveBeenCalledWith('visibility', 'report.pdf', 'release', 'about:blank');
  } finally {
    act(() => {
      root.unmount();
    });
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
