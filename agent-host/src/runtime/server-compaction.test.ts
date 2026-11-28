// Exercise the pinned Anthropic serializer and SSE adapter without an external request,
// then reopen Pi's real JSONL and check the next request and all previously written bytes.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { completeSimple } from '@earendil-works/pi-ai/compat';
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, UserMessage } from '@earendil-works/pi-ai';
import { SessionManager, type ExtensionAPI, convertToLlm } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import { ServerCompaction } from '../harness/server-compaction.js';

const model = getBuiltinModel('anthropic', 'claude-sonnet-4-6');
const text = 'The earlier exchange is summarized here.';
const question = (content: string): UserMessage => ({ role: 'user', content, timestamp: 1234 });

function source() {
  const events = [
    {
      type: 'message_start',
      message: { id: 'msg-test', model: model.id, usage: { input_tokens: 1200, output_tokens: 0 } },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'compaction', content: null } },
    { type: 'content_block_delta', index: 0, delta: { type: 'compaction_delta', content: text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ];
  return new Response(
    events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

function harness(edit: 'compact' | 'clearTools', block = false) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const strategy = new ServerCompaction();
  strategy.select(model, edit, true);
  const after = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const fallback = vi.fn(() => {
    strategy.select(model, edit, true);
  });
  strategy.install(
    {
      on: (key: string, cb: (event: unknown, ctx: unknown) => Promise<unknown>) =>
        handlers.set(key, cb),
    } as unknown as ExtensionAPI,
    fallback,
    () => Promise.resolve(block ? { block: 'held' } : undefined),
    after,
  );
  async function emit(key: string, event: unknown) {
    return handlers.get(key)?.(event, { model });
  }
  return {
    strategy,
    after,
    fallback,
    emit,
    async run(messages: AgentMessage[]) {
      const transformed = (await emit('context', { messages })) as
        { messages: AgentMessage[] } | undefined;
      let wire = '';
      let beta = '';
      const response = await completeSimple(
        model,
        { messages: convertToLlm(transformed?.messages ?? messages) },
        {
          apiKey: 'fixture',
          maxRetries: 0,
          onPayload: (payload) => emit('before_provider_request', { payload }),
          onProviderStreamEvent: async (data) => {
            await emit('provider_stream_event', {
              provider: model.provider,
              api: model.api,
              model: model.id,
              data,
            });
          },
          fetch: async (input, init) => {
            const request = new Request(input, init);
            wire = await request.text();
            beta = request.headers.get('anthropic-beta') ?? '';
            return source();
          },
        },
      );
      expect(response.stopReason).toBe('stop');
      const replaced = (await emit('message_end', { message: response })) as
        { message: AssistantMessage } | undefined;
      return { response: replaced?.message ?? response, body: JSON.parse(wire) as unknown, beta };
    },
  };
}

describe('Anthropic server context management', () => {
  it('restores the server block in its original response and appends to the original JSONL after restart', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'piarc-server-compact-'));
    try {
      const manager = SessionManager.create(dir, dir);
      manager.appendMessage(question('First question'));
      const first = harness('compact');
      const one = await first.run(manager.buildSessionContext().messages);
      expect(one.beta.split(',')).toContain('compact-2026-01-12');
      expect(one.body).toMatchObject({
        context_management: { edits: [{ type: 'compact_20260112' }] },
      });
      manager.appendMessage(one.response);
      expect(first.after).toHaveBeenCalledWith(text);
      const file = manager.getSessionFile();
      if (!file) throw new Error('missing session file');
      const prefix = readFileSync(file);
      const resumed = SessionManager.open(file, dir, dir);
      resumed.appendMessage(question('Next question'));
      const two = await harness('compact').run(resumed.buildSessionContext().messages);
      expect(two.body).toMatchObject({
        messages: [
          { role: 'user' },
          {
            role: 'assistant',
            content: [
              { type: 'compaction', content: text },
              { type: 'text', text: 'Answer' },
            ],
          },
          { role: 'user' },
        ],
      });
      resumed.appendMessage(two.response);
      expect(readFileSync(file).subarray(0, prefix.length)).toEqual(prefix);
      expect(prefix.toString()).toContain('First question');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('negotiates tool clearing and lets PreCompact suppress it on one request', async () => {
    const enabled = await harness('clearTools').run([question('Work')]);
    expect(enabled.beta.split(',')).toContain('context-management-2025-06-27');
    expect(enabled.body).toMatchObject({
      context_management: { edits: [{ type: 'clear_tool_uses_20250919' }] },
    });
    const held = await harness('clearTools', true).run([question('Hold')]);
    expect(held.body).not.toHaveProperty('context_management');
  });
  it('falls back without losing the reply when the server could not produce a summary', async () => {
    const h = harness('compact');
    for (const data of [
      { type: 'message_start', message: { id: 'null-summary' } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'compaction', content: null },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'compaction_delta', content: null } },
      { type: 'content_block_stop', index: 0 },
    ])
      await h.emit('provider_stream_event', { data, api: model.api, provider: model.provider });
    expect(
      await h.emit('message_end', {
        message: { role: 'assistant', responseId: 'null-summary', stopReason: 'stop' },
      }),
    ).toBeUndefined();
    expect(h.fallback).toHaveBeenCalledOnce();
    expect(h.after).not.toHaveBeenCalled();
  });
  it('falls back once on error and ignores an incompatible endpoint or model', async () => {
    const h = harness('compact');
    await h.emit('message_end', {
      message: {
        role: 'assistant',
        stopReason: 'error',
        content: [],
        errorMessage: 'rejected context_management',
      },
    });
    expect(h.fallback).toHaveBeenCalledOnce();
    expect(h.strategy.fallback).toBe(true);
    expect(h.strategy.select(model, 'compact', true)).toBe('client');
    expect(h.strategy.select({ ...model, provider: 'other' }, 'compact', true)).toBe('client');
    expect(h.strategy.select({ ...model, id: 'claude-haiku-4-5' }, 'compact', true)).toBe('client');
    expect(h.strategy.select(model, 'compact', true)).toBe('anthropic-server');
    expect(h.strategy.select(model, 'compact', false)).toBe('client');
    expect(h.strategy.select(model, undefined, true)).toBe('client');
  });
});
