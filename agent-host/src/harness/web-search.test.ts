import type { Api, Model } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { WebSearchBackendResult, WebSearchResult } from '@piarc/protocol';
import { describe, expect, it, vi } from 'vitest';

import { nativeSearch, nativeSearchKnown } from '../providers/web-search.js';
import type { CoreIo } from '../tools/core-io.js';
import { DEFAULT_PROFILE } from '../tools/profile.js';
import type { AuxiliaryModel, AuxiliaryRequest } from './auxiliary.js';
import { NATIVE_SEARCH_SYSTEM, NO_SEARCH_BACKEND } from './prompts/web-search.js';
import { createWebSearchTool } from './web-search.js';

const anthropic = {
  provider: 'anthropic',
  id: 'claude-x',
  name: 'Claude X',
  api: 'anthropic-messages',
} as unknown as Model<Api>;
const other = { ...anthropic, provider: 'openai', api: 'openai-responses' } as Model<Api>;

/** The raw stream events of a native search with two results and one citation. */
const events = [
  { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 's1' } },
  {
    type: 'content_block_start',
    index: 1,
    content_block: {
      type: 'web_search_tool_result',
      tool_use_id: 's1',
      content: [
        { type: 'web_search_result', url: 'https://tokio.rs/', title: 'Tokio' },
        { type: 'web_search_result', url: 'https://example.com/t', title: '' },
      ],
    },
  },
  {
    type: 'content_block_delta',
    index: 2,
    delta: {
      type: 'citations_delta',
      citation: {
        type: 'web_search_result_location',
        url: 'https://tokio.rs/',
        cited_text: 'An async runtime',
      },
    },
  },
];

describe('native web search (T38)', () => {
  it('adds the provider tool to the request and reads its result blocks', () => {
    expect(nativeSearchKnown(anthropic)).toBe(true);
    expect(nativeSearchKnown(other)).toBe(false);
    const search = nativeSearch(anthropic, {
      allowedDomains: ['tokio.rs'],
      blockedDomains: ['x.io'],
    });
    expect(search).toBeDefined();
    if (search === undefined) return;
    expect(search.onPayload({ model: 'claude-x', messages: [] })).toEqual({
      model: 'claude-x',
      messages: [],
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 1,
          allowed_domains: ['tokio.rs'],
        },
      ],
    });
    for (const event of events) search.onEvent(event);
    expect(search.outcome()).toEqual({
      searched: true,
      sources: [
        { title: 'Tokio', url: 'https://tokio.rs/', snippet: 'An async runtime' },
        { title: 'https://example.com/t', url: 'https://example.com/t' },
      ],
    });
    const failed = nativeSearch(anthropic, { allowedDomains: [], blockedDomains: [] });
    failed?.onEvent({
      type: 'content_block_start',
      content_block: {
        type: 'web_search_tool_result',
        content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' },
      },
    });
    expect(failed?.outcome()).toEqual({ searched: true, sources: [], error: 'max_uses_exceeded' });
  });
});

function setup(options: {
  model: Model<Api>;
  native: boolean;
  backend?: WebSearchBackendResult;
  found?: WebSearchResult;
  streamed?: readonly unknown[];
}) {
  const complete = vi.fn((request: AuxiliaryRequest) => {
    request.onPayload?.({ messages: [] });
    for (const event of options.streamed ?? []) request.onProviderStreamEvent?.(event);
    return Promise.resolve({
      text: 'Tokio is a runtime.',
      usage: {} as never,
      model: { provider: 'anthropic', id: 'claude-x' },
    });
  });
  const searchBackend = vi.fn(() =>
    Promise.resolve(options.backend ?? { unavailable: 'notConfigured' as const }),
  );
  const webSearch = vi.fn(() =>
    Promise.resolve(options.found ?? { backend: 'brave', results: [] }),
  );
  const definition = createWebSearchTool(DEFAULT_PROFILE.WebSearch, {
    io: { searchBackend, webSearch } as unknown as CoreIo,
    auxiliary: { complete } as unknown as AuxiliaryModel,
    session: () => ({ model: options.model }) as unknown as AgentSession,
    native: () => options.native,
  });
  const run = (params: Record<string, unknown>) =>
    definition.execute(
      'call-1',
      params,
      new AbortController().signal,
      undefined,
      undefined as never,
    );
  return { run, complete, searchBackend, webSearch };
}

describe('WebSearch (T38)', () => {
  it('searches natively with the session model when it can, never through Core', async () => {
    const t = setup({ model: anthropic, native: true, streamed: events });
    const result = await t.run({ query: 'tokio runtime', blocked_domains: ['example.com'] });
    const request = t.complete.mock.calls[0]?.[0];
    expect(request?.system).toBe(NATIVE_SEARCH_SYSTEM);
    expect(request?.model).toBe(anthropic);
    expect(request?.purpose).toBe('webSearch');
    expect(t.webSearch).not.toHaveBeenCalled();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('1. Tokio\n   https://tokio.rs/\n   An async runtime');
    expect(text).not.toContain('example.com');
    expect(text).toContain('Sources');
    expect(result.details).toEqual({
      webSearch: {
        query: 'tokio runtime',
        backend: 'native',
        sources: [{ title: 'Tokio', url: 'https://tokio.rs/', snippet: 'An async runtime' }],
      },
    });
  });

  it('fails when the provider did not search', async () => {
    const t = setup({ model: anthropic, native: true, streamed: [] });
    await expect(t.run({ query: 'tokio' })).rejects.toThrow('did not search');
  });

  it('uses the third-party backend through Core otherwise', async () => {
    const t = setup({
      model: other,
      native: false,
      backend: { backend: { id: 'brave', name: 'Brave Search' } },
      found: { backend: 'brave', results: [{ title: 'Docs', url: 'https://docs.rs/tokio' }] },
    });
    const result = await t.run({ query: 'tokio', allowed_domains: ['docs.rs'] });
    expect(t.complete).not.toHaveBeenCalled();
    expect(t.webSearch).toHaveBeenCalledWith(
      'tokio',
      { allowedDomains: ['docs.rs'], blockedDomains: [] },
      { tool: 'WebSearch', toolCallId: 'call-1' },
      expect.any(AbortSignal),
    );
    expect((result.content[0] as { text: string }).text).toContain(
      'Brave Search results for "tokio"',
    );
    expect(result.details).toMatchObject({ webSearch: { backend: 'brave' } });
  });

  it('says why when there is no backend', async () => {
    const t = setup({ model: other, native: false });
    await expect(t.run({ query: 'tokio' })).rejects.toThrow(NO_SEARCH_BACKEND);
  });
});
