// @vitest-environment happy-dom
// I186: highlighted code takes the dark or the light token colors from the app's theme choice,
// and from the system only when the choice is "system".
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_PREFERENCES, type Preferences } from '../../shared/preferences.js';
import { AppProvider } from '../app/app-context.js';
import { useDarkScheme } from './use-color-scheme.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let systemDark = false;
let unmount: (() => void) | undefined;

beforeAll(() => {
  Object.assign(window, {
    piarc: { onAppEvent: () => () => undefined },
    matchMedia: (query: string) => ({
      matches: query === '(prefers-color-scheme: dark)' ? systemDark : false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
});

afterEach(() => {
  unmount?.();
  unmount = undefined;
});

function Probe() {
  return <span data-dark={String(useDarkScheme())} />;
}

async function dark(theme: Preferences['appearance']['theme']): Promise<string | null> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <AppProvider
        initial={{
          platform: 'darwin',
          preferences: {
            ...DEFAULT_PREFERENCES,
            appearance: { ...DEFAULT_PREFERENCES.appearance, theme },
          },
          locale: 'en',
          focused: true,
          notificationsSupported: true,
        }}
      >
        <Probe />
      </AppProvider>,
    );
    await Promise.resolve();
  });
  unmount = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };
  return container.querySelector('span')?.getAttribute('data-dark') ?? null;
}

describe('useDarkScheme', () => {
  it('follows the app theme, and the system only for "system"', async () => {
    systemDark = false;
    expect(await dark('dark')).toBe('true');
    unmount?.();
    expect(await dark('light')).toBe('false');
    unmount?.();
    expect(await dark('system')).toBe('false');
    unmount?.();
    systemDark = true;
    expect(await dark('light')).toBe('false');
    unmount?.();
    expect(await dark('system')).toBe('true');
  });
});
