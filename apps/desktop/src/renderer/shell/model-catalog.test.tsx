// @vitest-environment happy-dom
import { act, isValidElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeIpcError } from '../../shared/ipc-error.js';
import type { MenuItem } from './Menu.js';
import { ProviderMark } from './icons.js';
import {
  keyOf,
  modelChoiceItems,
  parseCatalog,
  useModelCatalog,
  type ModelChoice,
} from './model-catalog.js';

const CATALOG = JSON.stringify({
  models: [
    {
      provider: 'mock',
      id: 'm',
      name: 'Mock',
      vision: false,
      efforts: ['low'],
      contextWindow: 1000,
      maxOutput: 100,
      toolReliability: 'verified',
      promptCache: false,
    },
  ],
});

/** What the page receives when Core refused (`page-errors.ts`). */
const coreError = (kind: string) =>
  new Error(
    `Error invoking remote method 'piarc:session.models': Error: ${encodeIpcError(kind, 'x')}`,
  );

let seen: { catalog: boolean; failure: string | undefined } = {
  catalog: false,
  failure: undefined,
};

function Probe({ again }: { readonly again: number }) {
  const { catalog, failure } = useModelCatalog('s1', true, again);
  seen = { catalog: catalog !== undefined, failure };
  return null;
}

const sessionModels = vi.fn<(id: string) => Promise<string>>();
let render: (again: number) => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('piarc', { onAppEvent: () => () => undefined, sessionModels });
  const root = createRoot(document.createElement('div'));
  render = (again) => {
    act(() => {
      root.render(<Probe again={again} />);
    });
  };
});

afterEach(() => {
  vi.useRealTimers();
  sessionModels.mockReset();
});

const settle = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('the model catalog of a session', () => {
  it('waits out a session still opening in its Agent Host without showing a failure', async () => {
    sessionModels
      .mockRejectedValueOnce(coreError('sessionNotFound'))
      .mockRejectedValueOnce(coreError('sessionNotFound'))
      .mockResolvedValue(CATALOG);
    render(0);
    await settle();
    expect(seen).toEqual({ catalog: false, failure: undefined });
    await settle(250);
    expect(seen.failure).toBeUndefined();
    await settle(500);
    expect(seen).toEqual({ catalog: true, failure: undefined });
    expect(sessionModels).toHaveBeenCalledTimes(3);
  });

  it('shows a lasting failure, and clears it when asked again after the session moved on', async () => {
    sessionModels.mockRejectedValueOnce(coreError('permissionDenied')).mockResolvedValue(CATALOG);
    render(0);
    await settle();
    expect(seen.failure).toBe('Not allowed: x');
    render(1);
    await settle();
    expect(seen).toEqual({ catalog: true, failure: undefined });
  });
});

const model = (provider: string, id: string, name = id) => ({
  provider,
  id,
  name,
  vision: false,
  efforts: ['off'],
  contextWindow: 128_000,
  maxOutput: 8_192,
  toolReliability: 'verified',
  promptCache: false,
});

const directory = (models: unknown[], extra: Record<string, unknown> = {}) =>
  parseCatalog(JSON.stringify({ models, providers: [], ...extra }));

const labels = (items: readonly MenuItem[]) => items.map((item) => item.label);

describe('parseCatalog', () => {
  it('keeps the providers’ display names from the catalog and the sign-in list', () => {
    const catalog = directory([model('openai', 'gpt')], {
      providers: [{ id: 'openai', name: 'OpenAI' }],
      loginProviders: [
        { id: 'github-copilot', name: 'GitHub Copilot', label: 'Sign in', signedIn: true },
      ],
    });
    expect(catalog.providerNames).toEqual({ openai: 'OpenAI', 'github-copilot': 'GitHub Copilot' });
  });
});

describe('modelChoiceItems', () => {
  it('lists the models directly when they all come from one provider', () => {
    const catalog = directory([model('relay', 'a'), model('relay', 'b')]);
    const items = modelChoiceItems(catalog, () => false, vi.fn());
    expect(labels(items)).toEqual(['a', 'b']);
    expect(items.every((item) => item.submenu === undefined)).toBe(true);
    expect(items[0]?.hint).toBe('relay/a');
  });

  it('groups the models under one row per provider, in the catalog’s order', () => {
    const catalog = directory(
      [
        model('deepseek', 'deepseek-chat', 'DeepSeek Chat'),
        model('openai', 'gpt-5'),
        model('deepseek', 'deepseek-reasoner', 'DeepSeek Reasoner'),
      ],
      { providers: [{ id: 'openai', name: 'OpenAI' }] },
    );
    const chosen: ModelChoice[] = [];
    const items = modelChoiceItems(
      catalog,
      (m) => keyOf(m) === 'openai/gpt-5',
      (m) => chosen.push(m),
    );
    // A provider without a catalog name (a custom endpoint) shows its id.
    expect(labels(items)).toEqual(['deepseek', 'OpenAI']);
    const [deepseek, openai] = items;
    expect(deepseek?.testId).toBe('model-provider-deepseek');
    expect(deepseek?.searchable).toBe(true);
    expect(labels(deepseek?.submenu ?? [])).toEqual(['DeepSeek Chat', 'DeepSeek Reasoner']);
    // Inside its provider a model shows its id only when its name differs.
    expect(deepseek?.submenu?.[0]?.hint).toBe('deepseek-chat');
    expect(openai?.submenu?.[0]?.hint).toBeUndefined();
    // The current model's provider is marked and names it.
    expect(deepseek?.selected).toBeUndefined();
    expect(openai).toMatchObject({ selected: true, hint: 'gpt-5' });
    expect(openai?.submenu?.[0]).toMatchObject({
      testId: 'model-option-openai/gpt-5',
      selected: true,
    });
    deepseek?.submenu?.[1]?.run?.();
    expect(chosen.map(keyOf)).toEqual(['deepseek/deepseek-reasoner']);
  });

  it('has no rows without a catalog', () => {
    expect(modelChoiceItems(undefined, () => false, vi.fn())).toEqual([]);
  });
});

/** The provider a row's mark (ADR-0107) draws, or undefined when the row has none. */
function markOf(item: MenuItem | undefined): unknown {
  const icon = item?.icon;
  if (!isValidElement<{ provider: unknown }>(icon)) return undefined;
  expect(icon.type).toBe(ProviderMark);
  return icon.props.provider;
}

describe('modelChoiceItems marks', () => {
  it('leads each provider row with its mark and leaves the submenu rows plain', () => {
    const catalog = directory([model('deepseek', 'chat'), model('openai', 'gpt')], {
      providers: [{ id: 'openai', name: 'OpenAI' }],
    });
    const items = modelChoiceItems(catalog, () => false, vi.fn());
    expect(items.map(markOf)).toEqual([
      { id: 'deepseek', name: undefined },
      { id: 'openai', name: 'OpenAI' },
    ]);
    expect(items[0]?.submenu?.map((m) => m.icon)).toEqual([undefined]);
  });

  it("marks a single provider's model rows", () => {
    const items = modelChoiceItems(
      directory([model('deepseek-test', 'flash')]),
      () => false,
      vi.fn(),
    );
    expect(markOf(items[0])).toEqual({ id: 'deepseek-test', name: undefined });
  });
});
