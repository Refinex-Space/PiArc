import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import { discoverModels, modelIds, testProvider, tidyMessage } from './checks.js';

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('modelIds', () => {
  it('reads OpenAI, Anthropic and Ollama lists, sorted and unique', () => {
    expect(modelIds({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }] })).toEqual(['a', 'b']);
    expect(modelIds({ models: [{ name: 'qwen3:8b' }] })).toEqual(['qwen3:8b']);
    expect(modelIds(['x', 3, { id: '' }, { id: 'bad\u0007' }])).toEqual(['x']);
    expect(modelIds({ error: 'nope' })).toEqual([]);
  });
});

describe('discoverModels', () => {
  const store = new InMemoryCredentialStore();

  it('sends the typed key the way the protocol wants it', async () => {
    const fetchImpl = vi.fn(() => json({ data: [{ id: 'm1' }] }));
    const result = await discoverModels(
      { api: 'openai-completions', baseUrl: 'https://relay.example/v1/', key: 'sk-1' },
      store,
      fetchImpl,
    );
    expect(result).toEqual({ models: ['m1'] });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://relay.example/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-1' }) as unknown,
      }),
    );
  });

  it('tries the second Anthropic path when the first is not there', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => json({}, 404))
      .mockImplementationOnce(() => json({ data: [{ id: 'claude-x' }] }));
    const result = await discoverModels(
      { api: 'anthropic-messages', baseUrl: 'https://relay.example/anthropic', key: 'k' },
      store,
      fetchImpl,
    );
    expect(result.models).toEqual(['claude-x']);
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([
      'https://relay.example/anthropic/v1/models',
      'https://relay.example/anthropic/models',
    ]);
    const headers = fetchImpl.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('k');
  });

  it('uses a stored key only for the address and protocol it was saved for', async () => {
    const saved = new InMemoryCredentialStore();
    await saved.modify('relay', () =>
      Promise.resolve({
        type: 'api_key',
        key: 'stored-key',
        env: {
          PIARC_BOUND_BASE_URL: 'https://relay.example/v1',
          PIARC_BOUND_API: 'openai-completions',
        },
      }),
    );
    const fetchImpl = vi.fn(() => json({ data: [] }));
    await discoverModels(
      { api: 'openai-completions', baseUrl: 'https://relay.example/v1', storedKeyOf: 'relay' },
      saved,
      fetchImpl,
    );
    await discoverModels(
      { api: 'openai-completions', baseUrl: 'https://elsewhere.example/v1', storedKeyOf: 'relay' },
      saved,
      fetchImpl,
    );
    const sent = fetchImpl.mock.calls.map(
      (c) => (c as unknown as [string, RequestInit])[1].headers as Record<string, string>,
    );
    expect(sent[0]?.Authorization).toBe('Bearer stored-key');
    expect(sent[1]?.Authorization).toBeUndefined();
  });

  it('says why the list could not be had', async () => {
    await expect(
      discoverModels({ api: 'openai-completions', baseUrl: 'https://x.example' }, store, () =>
        json({}, 401),
      ),
    ).rejects.toMatchObject({ kind: 'permissionDenied' });
    const unreachable = new TypeError('fetch failed', {
      cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
    });
    await expect(
      discoverModels({ api: 'openai-completions', baseUrl: 'http://127.0.0.1:9' }, store, () =>
        Promise.reject(unreachable),
      ),
    ).rejects.toMatchObject({
      message: 'fetch failed (ECONNREFUSED)',
      details: { reason: 'network' },
    });
  });
});

describe('testProvider', () => {
  const runtime = (reply: () => Promise<unknown>, models = [{ id: 'm1', provider: 'p' }]) =>
    ({
      getAvailable: () => Promise.resolve(models),
      completeSimple: reply,
    }) as unknown as ModelRuntime;

  it('reports the model asked and how long it took', async () => {
    const result = await testProvider(
      runtime(() => Promise.resolve({ stopReason: 'stop', content: [] })),
      { provider: 'p' },
    );
    expect(result).toMatchObject({ ok: true, model: 'm1' });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a failed request, a provider out of reach and no model at all', async () => {
    expect(
      await testProvider(
        runtime(() => Promise.resolve({ stopReason: 'error', errorMessage: '401 Unauthorized' })),
        { provider: 'p' },
      ),
    ).toEqual({ ok: false, model: 'm1', message: '401 Unauthorized' });
    expect(
      await testProvider(
        runtime(() => Promise.resolve({ stopReason: 'error', errorMessage: 'fetch failed' })),
        { provider: 'p' },
      ),
    ).toMatchObject({ ok: false, network: true });
    expect(
      await testProvider(
        runtime(() => Promise.resolve({}), []),
        { provider: 'p' },
      ),
    ).toMatchObject({ ok: false });
  });
});

describe('tidyMessage', () => {
  it('keeps the message of a JSON error body and cuts long text', () => {
    expect(
      tidyMessage('404: {"code":"not_found","message":"not_found: no endpoint","violations":[]}'),
    ).toBe('404: not_found: no endpoint');
    expect(tidyMessage('401 Unauthorized: {"error":{"message":"invalid key"}}')).toBe(
      '401: invalid key',
    );
    expect(tidyMessage('500: {not json')).toBe('500: {not json');
    expect(tidyMessage('x'.repeat(400))).toHaveLength(300);
  });
});
