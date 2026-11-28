// @vitest-environment happy-dom
// B5.1: the preview offers Chrome's sign-ins once per workspace, on a site of the web, when Chrome
// has profiles and the workspace has none imported yet; "Choose sites…" opens the import.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { DEFAULT_PREFERENCES } from '../../shared/preferences.js';
import { AppProvider } from '../app/app-context.js';
import { ChromePrompt } from './ChromePrompt.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PROFILES = JSON.stringify({ chrome: true, profiles: [{ id: 'Default', name: 'Me' }] });
const NO_IMPORTS = JSON.stringify({ imports: [] });

let dom: HTMLDivElement;
let root: Root;
let api: {
  chromeProfiles: ReturnType<typeof vi.fn>;
  browserImports: ReturnType<typeof vi.fn>;
  openSettings: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  api = {
    chromeProfiles: vi.fn(() => Promise.resolve(PROFILES)),
    browserImports: vi.fn(() => Promise.resolve(NO_IMPORTS)),
    openSettings: vi.fn(() => Promise.resolve()),
  };
  Object.assign(window, { piarc: { ...api, onAppEvent: () => () => undefined } });
  dom = document.createElement('div');
  document.body.append(dom);
  root = createRoot(dom);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  dom.remove();
});

async function show(url: string, workspace: string, enabled = true): Promise<void> {
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
        <ChromePrompt
          url={url}
          workspace={workspace}
          enabled={enabled}
          localNames={['*.test']}
          anchor={() => null}
        />
      </AppProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

const offer = () => dom.querySelector('[data-testid="browser-chrome-offer"]');

it('offers once per workspace and opens the import for the page’s site', async () => {
  await show('https://github.com/piarc', '/w');
  expect(offer()).not.toBeNull();
  expect(offer()?.textContent).toContain('Passwords are not copied');
  dom.querySelector<HTMLButtonElement>('[data-testid="browser-chrome-offer-import"]')?.click();
  await act(async () => {
    await Promise.resolve();
  });
  expect(api.openSettings).toHaveBeenCalledWith('browser');
  expect(window.sessionStorage.getItem('piarc.browserImportTarget')).toContain('github.com');
  expect(offer()).toBeNull();

  // Asked already: not again in this workspace, whatever the site.
  act(() => {
    root.unmount();
  });
  root = createRoot(dom);
  api.chromeProfiles.mockClear();
  await show('https://example.org/', '/w');
  expect(offer()).toBeNull();
  expect(api.chromeProfiles).not.toHaveBeenCalled();
  // Another workspace is asked once too.
  await show('https://example.org/', '/other');
  expect(offer()).not.toBeNull();
});

it('closes with Not now and stays closed', async () => {
  await show('https://github.com/', '/w');
  dom.querySelector<HTMLButtonElement>('[data-testid="browser-chrome-offer-dismiss"]')?.click();
  await act(async () => {
    await Promise.resolve();
  });
  expect(offer()).toBeNull();
  expect(api.openSettings).not.toHaveBeenCalled();
});

it('does not ask on local pages, while the page is held, or without Chrome', async () => {
  await show('http://localhost:5173/', '/w');
  await show('https://shop.test/', '/w');
  await show('https://github.com/', '/w', false);
  expect(api.chromeProfiles).not.toHaveBeenCalled();
  expect(offer()).toBeNull();

  api.chromeProfiles.mockResolvedValue(JSON.stringify({ chrome: false, profiles: [] }));
  await show('https://github.com/', '/w');
  expect(offer()).toBeNull();
  // Not asked yet: a later visit with Chrome present still offers.
  expect(window.localStorage.getItem('piarc.browser.chromePrompted')).toBeNull();
});

it('does not ask a workspace that has imported sign-ins', async () => {
  api.browserImports.mockResolvedValue(
    JSON.stringify({
      imports: [{ site: 'github.com', count: 3, profile: 'Default', importedAt: 1 }],
    }),
  );
  await show('https://github.com/', '/w');
  expect(offer()).toBeNull();
});
