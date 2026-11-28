// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Translator } from '../../../shared/i18n/index.js';
import { MarkdownDiagram } from './RichBlock.js';
import { MarkdownImage } from './MarkdownImage.js';
import { drawDiagram } from './diagram-client.js';
const translator = new Translator('en');
vi.mock('../../app/app-context.js', () => ({
  useT: () => translator.t.bind(translator),
  useApp: () => ({
    locale: 'en',
    t: translator.t.bind(translator),
    format: {
      number: (n: number, o?: Intl.NumberFormatOptions) => new Intl.NumberFormat('en', o).format(n),
    },
  }),
}));
vi.mock('../../transcript/use-color-scheme.js', () => ({ useDarkScheme: () => false }));
const graphic =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg"><rect width="60" height="40"/></svg>',
  );
vi.mock('./diagram-client.js', () => ({
  drawDiagram: vi.fn(() => Promise.resolve({ url: graphic, size: { width: 60, height: 40 } })),
}));
const release = vi.fn();
vi.mock('../markdown-images/use-markdown-images.js', () => ({
  loadMarkdownImage: () =>
    Promise.resolve({ url: 'piarc-document://markdown-images/sample', release }),
}));
beforeEach(() => {
  vi.mocked(drawDiagram).mockClear();
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(readonly notify: (entries: { isIntersecting: boolean }[]) => void) {}
      observe() {
        this.notify([{ isIntersecting: true }]);
      }
      disconnect() {
        return undefined;
      }
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it.each(['image', 'diagram'])(
  'opens the %s on the same passive resource with zoom, rotation, a fit-width command and focus restoration',
  async (kind) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(
          kind === 'diagram' ? (
            <MarkdownDiagram source="flowchart LR; A-->B" />
          ) : (
            <MarkdownImage
              sessionId="test-session"
              path="test.md"
              source="./img/photo.png"
              alt="Photo"
            />
          ),
        );
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      if (kind === 'diagram') {
        const thumb = host.querySelector('img');
        expect(thumb?.getAttribute('width')).toBe('60');
        expect(thumb?.getAttribute('height')).toBe('40');
      }
      const trigger = host.querySelector('button');
      expect(trigger).not.toBeNull();
      act(() => {
        trigger?.focus();
        trigger?.click();
      });
      const dialog = document.querySelector<HTMLElement>('[role=dialog]');
      expect(dialog).not.toBeNull();
      expect(dialog?.querySelector('img')?.getAttribute('src')).toBe(
        kind === 'diagram' ? graphic : 'piarc-document://markdown-images/sample',
      );
      expect(dialog?.querySelector('svg:not([aria-hidden])')).toBeNull();
      for (const name of ['Zoom in', 'Zoom out', 'Fit to width', 'Rotate clockwise', 'Reset view'])
        expect(dialog?.querySelector('button[aria-label="' + name + '"]'), name).not.toBeNull();
      act(() => {
        dialog?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click();
      });
      expect(document.querySelector('[role=dialog]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    } finally {
      act(() => {
        root.unmount();
      });
      host.remove();
    }
  },
);

it('debounces live fence edits, keeps the figure body editable, and closes an obsolete enlarged drawing', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (source: string) => {
    act(() => {
      root.render(<MarkdownDiagram source={source} editing />);
    });
  };
  try {
    render('first');
    render('current');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(149);
    });
    expect(drawDiagram).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(drawDiagram).toHaveBeenCalledTimes(1);
    expect(vi.mocked(drawDiagram).mock.calls[0]?.[1]).toBe('current');
    const image = host.querySelector('img');
    expect(image?.closest('button')).toBeNull();
    act(() => {
      image?.click();
    });
    expect(document.querySelector('[role=dialog]')).toBeNull();
    act(() => {
      host.querySelector<HTMLButtonElement>('.md-media-expand')?.click();
    });
    expect(document.querySelector('[role=dialog]')).not.toBeNull();
    render('next revision');
    expect(document.querySelector('[role=dialog]')).toBeNull();
  } finally {
    act(() => {
      root.unmount();
    });
    host.remove();
  }
});
