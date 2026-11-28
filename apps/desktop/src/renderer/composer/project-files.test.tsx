// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES } from '../../shared/preferences.js';
import { AppProvider } from '../app/app-context.js';
import { attachProjectFiles, FILE_DRAG_TYPE } from '../files/navigation.js';
import { Composer } from './Composer.js';

it('accepts a Files menu or drag only for the live editor session and inserts cwd-relative mentions', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('piarc', { onAppEvent: () => () => undefined });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const show = async (sessionId: string, directory: string) => {
    await act(async () => {
      root.render(
        <AppProvider
          initial={{
            platform: 'darwin',
            focused: true,
            locale: 'en',
            notificationsSupported: false,
            preferences: DEFAULT_PREFERENCES,
          }}
        >
          <Composer
            sessionId={sessionId}
            fileScope={{ root: '/work/tree', directory }}
            running={false}
            handlers={{
              submit: () => true,
              stop: vi.fn(),
              command: vi.fn(),
              mentionOpened: vi.fn(),
              mentionChosen: vi.fn(),
            }}
            limits={undefined}
            mentions={{ search: () => Promise.resolve([]), cancel: vi.fn() }}
            commands={[]}
          />
        </AppProvider>,
      );
      await Promise.resolve();
    });
  };
  const drop = (sessionId: string, path: string) => {
    const transfer = new DataTransfer();
    transfer.setData(FILE_DRAG_TYPE, JSON.stringify({ sessionId, paths: [path] }));
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    host.querySelector('[contenteditable=true]')?.dispatchEvent(event);
  };
  try {
    await show('one', 'src');
    await show('two', 'docs');
    act(() => {
      drop('one', 'private.txt');
      drop('two', 'docs/guide.md');
      attachProjectFiles('two', ['assets/icon.png']);
    });
    const mentions = [...host.querySelectorAll<HTMLElement>('[data-piarc-mention]')];
    expect(mentions.map((chip) => chip.title)).toEqual(['guide.md', '../assets/icon.png']);
    expect(mentions.map((chip) => chip.textContent)).toEqual(['@guide.md', '@icon.png']);
  } finally {
    act(() => {
      root.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
  }
});
