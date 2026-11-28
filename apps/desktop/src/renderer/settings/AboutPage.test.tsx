// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { DEFAULT_PREFERENCES } from '../../shared/preferences.js';
import { AppProvider } from '../app/app-context.js';
import { resetUpdateStatus } from '../updates/update-store.js';
import { AboutPage } from './AboutPage.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const INFO = {
  app: '1.0.0',
  electron: '45.3.2',
  chromium: '146.0.0.0',
  node: '24.11.0',
  pi: '1.5.2',
  protocol: '1.0',
  ghostty: '1.0.1',
  platform: 'darwin',
  arch: 'arm64',
  osVersion: '15.1.0',
  release: true,
};

const RELEASE = {
  version: '1.1.0',
  date: '2026-12-01',
  security: true,
  notes: { en: '### Fixed\n\n- The **proxy** is used for updates.', 'zh-CN': '修复' },
  size: 186_000_000,
  pageUrl: 'https://github.com/Refinex-Space/PiArc/releases/tag/v1.1.0',
};

let root: Root;
let dom: HTMLElement;

beforeEach(() => {
  resetUpdateStatus();
  vi.stubGlobal(
    'Worker',
    class extends EventTarget {
      postMessage(): void {
        // No highlighting here.
      }
      terminate(): void {
        // Nothing runs.
      }
    },
  );
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  dom.remove();
  vi.unstubAllGlobals();
});

async function show(api: Record<string, unknown>): Promise<void> {
  Object.assign(window, {
    piarc: {
      aboutInfo: () => Promise.resolve(INFO),
      onAppEvent: () => () => undefined,
      ...api,
    },
  });
  dom = document.createElement('div');
  document.body.append(dom);
  root = createRoot(dom);
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
        <AboutPage />
      </AppProvider>,
    );
    await Promise.resolve();
  });
}

const status = (value: object) => () => Promise.resolve(JSON.stringify(value));
const byTestId = (id: string) => dom.querySelector(`[data-testid="${id}"]`);

it('shows the version, the parts and an up-to-date check that finds a newer release', async () => {
  const check = vi.fn(status({ state: 'available', current: '1.0.0', release: RELEASE }));
  await show({
    updateStatus: status({ state: 'upToDate', current: '1.0.0', checkedAt: Date.now() }),
    checkForUpdates: check,
  });
  expect(byTestId('about-version')?.textContent).toBe('Version 1.0.0 (arm64)');
  expect(byTestId('about-update')?.textContent).toContain('PiArc is up to date');
  expect(byTestId('about-update')?.textContent).toContain('Last checked');
  const versions = byTestId('about-versions')?.textContent ?? '';
  for (const part of ['45.3.2', '1.5.2', '1.0.1', 'macOS 15.1.0 (arm64)']) {
    expect(versions).toContain(part);
  }
  await act(async () => {
    (byTestId('about-check') as HTMLButtonElement).click();
    await Promise.resolve();
  });
  expect(check).toHaveBeenCalledOnce();
  expect(byTestId('about-update')?.textContent).toContain('PiArc 1.1.0 is available');
  expect(byTestId('about-security')?.textContent).toBe('Security update');
  expect(byTestId('about-update')?.textContent).toContain('186 MB');
  // The notes render as Markdown, in the app's language (English here).
  expect(byTestId('about-notes')?.querySelector('strong')?.textContent).toBe('proxy');
  expect(byTestId('about-download')).not.toBeNull();
});

it('shows download progress and can cancel it', async () => {
  const cancel = vi.fn(status({ state: 'available', current: '1.0.0', release: RELEASE }));
  await show({
    updateStatus: status({
      state: 'downloading',
      current: '1.0.0',
      release: RELEASE,
      progress: { received: 93_000_000, total: 186_000_000 },
    }),
    cancelUpdateDownload: cancel,
  });
  expect(byTestId('about-progress')?.getAttribute('aria-valuenow')).toBe('50');
  expect(byTestId('about-update')?.textContent).toContain('93 MB of 186 MB');
  await act(async () => {
    (byTestId('about-cancel') as HTMLButtonElement).click();
    await Promise.resolve();
  });
  expect(cancel).toHaveBeenCalledOnce();
  expect(byTestId('about-download')).not.toBeNull();
});

it('explains when the ready update has to be installed by hand', async () => {
  const install = vi.fn(() => Promise.resolve({ kind: 'manual', reason: 'translocated' }));
  await show({
    updateStatus: status({ state: 'ready', current: '1.0.0', release: RELEASE }),
    installUpdate: install,
  });
  expect(byTestId('about-update')?.textContent).toContain('PiArc 1.1.0 is ready to install');
  await act(async () => {
    (byTestId('about-install') as HTMLButtonElement).click();
    await Promise.resolve();
  });
  expect(install).toHaveBeenCalledOnce();
  expect(byTestId('about-manual')?.textContent).toContain('Applications folder');
});

it('names the reason of a failed check and offers to check again', async () => {
  await show({
    updateStatus: status({
      state: 'failed',
      current: '1.0.0',
      problem: { code: 'proxy', message: 'cannot reach the proxy: refused' },
    }),
  });
  expect(byTestId('about-update')?.textContent).toContain('Could not check for updates');
  expect(byTestId('about-problem')?.textContent).toContain('Settings › Proxy');
  expect(byTestId('about-problem')?.getAttribute('data-tooltip')).toBe(
    'cannot reach the proxy: refused',
  );
  expect(byTestId('about-check')).not.toBeNull();
});

it('says why a build without a release key cannot update', async () => {
  await show({
    updateStatus: status({ state: 'idle', current: '0.0.0', unavailable: 'noTrustedKey' }),
  });
  expect(byTestId('about-update')?.textContent).toContain('not available in this build');
  expect(byTestId('about-check')).toBeNull();
});
