// @vitest-environment happy-dom
// "Connect a model" (ADR-0110) with the IPC stubbed: built-in providers would reach the real
// vendor in L4, so their save-then-test path is checked here.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_PREFERENCES } from '../../shared/preferences.js';
import { AppProvider } from '../app/app-context.js';
import { ConnectModel } from './ConnectModel.js';

const settings = (providers: unknown[] = []) =>
  JSON.stringify({
    providers,
    builtinProviders: [
      { id: 'deepseek', name: 'DeepSeek' },
      { id: 'zai', name: 'Z.AI' },
      { id: 'zai-coding-cn', name: 'Z.AI Coding CN' },
    ],
    catalogRefresh: false,
    loginProviders: [],
  });

const providerSettings = vi.fn<() => Promise<string>>();
const saveProvider = vi.fn<(config: string, secret?: string) => Promise<string>>();
const testProvider = vi.fn<(id: string) => Promise<string>>();
const openExternal = vi.fn<(url: string) => Promise<boolean>>();
const onBack = vi.fn();
const onDone = vi.fn();
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('piarc', {
    providerSettings,
    saveProvider,
    testProvider,
    openExternal,
    onAppEvent: () => () => undefined,
  });
  providerSettings.mockResolvedValue(settings());
  saveProvider.mockImplementation(() =>
    Promise.resolve(settings([{ id: 'deepseek', kind: 'builtin', hasCredential: true }])),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  vi.clearAllMocks();
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function render(locale: 'en' | 'zh-CN' = 'en') {
  act(() => {
    root.render(
      <AppProvider
        initial={{
          platform: 'darwin',
          preferences: DEFAULT_PREFERENCES,
          locale,
          focused: true,
          notificationsSupported: true,
        }}
      >
        <ConnectModel backLabel="onboarding.back" onBack={onBack} onDone={onDone} />
      </AppProvider>,
    );
  });
  await flush();
}

const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function typeKey(text: string) {
  const input = byTestId('onboarding-key') as HTMLInputElement;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  act(() => {
    descriptor?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function fill(id: string, text: string) {
  const input = byTestId(id) as HTMLInputElement;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  act(() => {
    descriptor?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function click(id: string) {
  act(() => {
    byTestId(id)?.click();
  });
}

describe('ConnectModel', () => {
  it('keeps one endpoint id across a failed test and the retry', async () => {
    const endpoint = (id: string) => ({
      id,
      kind: 'custom',
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:8080/v1',
      models: ['m'],
      hasCredential: true,
    });
    saveProvider.mockImplementation((config: string) =>
      Promise.resolve(settings([endpoint((JSON.parse(config) as { id: string }).id)])),
    );
    testProvider
      .mockResolvedValueOnce(JSON.stringify({ ok: false, message: '401', network: false }))
      .mockResolvedValueOnce(JSON.stringify({ ok: true, network: false }));
    await render();
    click('onboarding-tile-custom');
    fill('onboarding-url', 'http://127.0.0.1:8080/v1');
    fill('onboarding-model', 'm');
    typeKey('sk-wrong');
    click('onboarding-submit');
    await flush();
    expect(byTestId('onboarding-failed')).not.toBeNull();
    typeKey('sk-good');
    click('onboarding-submit');
    await flush();
    const ids = saveProvider.mock.calls.map(
      ([config]) => (JSON.parse(config) as { id: string }).id,
    );
    expect(ids).toEqual(['custom', 'custom']);
    expect(testProvider.mock.calls.map(([id]) => id)).toEqual(['custom', 'custom']);
    expect(byTestId('onboarding-connected')).not.toBeNull();
  });

  it('saves a built-in provider’s key once, tests it and starts', async () => {
    testProvider.mockResolvedValue(
      JSON.stringify({ ok: true, model: 'deepseek-v4', latencyMs: 412, network: false }),
    );
    await render();
    expect(byTestId('onboarding-form-title')?.textContent).toBe('DeepSeek');
    typeKey('sk-test-123');
    click('onboarding-submit');
    click('onboarding-submit');
    await flush();
    expect(saveProvider).toHaveBeenCalledTimes(1);
    expect(JSON.parse(saveProvider.mock.calls[0]?.[0] ?? '')).toEqual({
      id: 'deepseek',
      kind: 'builtin',
    });
    expect(JSON.parse(saveProvider.mock.calls[0]?.[1] ?? '')).toEqual({ key: 'sk-test-123' });
    expect(testProvider).toHaveBeenCalledWith('deepseek');
    expect(byTestId('onboarding-connected')?.textContent).toContain('deepseek-v4');
    expect((byTestId('onboarding-key') as HTMLInputElement).value).toBe('');
    expect(byTestId('onboarding-submit')?.textContent).toBe('Start using PiArc');
    click('onboarding-submit');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('drops the key when another tile or variant is chosen', async () => {
    await render('zh-CN');
    typeKey('sk-for-deepseek');
    click('onboarding-tile-family-glm');
    expect((byTestId('onboarding-key') as HTMLInputElement).value).toBe('');
    typeKey('sk-for-glm');
    click('onboarding-tile-custom');
    expect((byTestId('onboarding-key') as HTMLInputElement).value).toBe('');
    expect(saveProvider).not.toHaveBeenCalled();
  });

  it('shows a failure as plain text and lets the user skip the test', async () => {
    testProvider.mockResolvedValue(
      JSON.stringify({ ok: false, message: '<b>401</b> bad key', network: false }),
    );
    await render();
    typeKey('sk-wrong');
    click('onboarding-submit');
    await flush();
    const failed = byTestId('onboarding-failed');
    expect(failed?.textContent).toContain('<b>401</b> bad key');
    expect(failed?.querySelector('b')).toBeNull();
    expect(byTestId('onboarding-proxy')).toBeNull();
    // The key field takes the focus back to fix and retry.
    expect(document.activeElement).toBe(byTestId('onboarding-key'));
    click('onboarding-skip');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('ignores a test answer that arrives after Back', async () => {
    let answer: (text: string) => void = () => undefined;
    testProvider.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await render();
    typeKey('sk-slow');
    click('onboarding-submit');
    await flush();
    expect(byTestId('onboarding-testing')).not.toBeNull();
    click('onboarding-back');
    expect(onBack).toHaveBeenCalledTimes(1);
    answer(JSON.stringify({ ok: true, network: false }));
    await flush();
    expect(byTestId('onboarding-connected')).toBeNull();
  });

  it('opens only the fixed key page of the chosen provider', async () => {
    await render();
    click('onboarding-get-key');
    expect(openExternal).toHaveBeenCalledWith('https://platform.deepseek.com/api_keys');
  });

  it('tests a provider that already has a key without saving it again', async () => {
    providerSettings.mockResolvedValue(
      settings([{ id: 'deepseek', kind: 'builtin', hasCredential: true }]),
    );
    testProvider.mockResolvedValue(JSON.stringify({ ok: true, network: false }));
    await render();
    expect(byTestId('onboarding-tile-family-deepseek')?.dataset.connected).toBe('true');
    expect(byTestId('onboarding-submit')?.textContent).toBe('Test connection');
    click('onboarding-submit');
    await flush();
    expect(saveProvider).not.toHaveBeenCalled();
    expect(testProvider).toHaveBeenCalledWith('deepseek');
  });
});
