import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';

import type { CoreIo } from '../tools/core-io.js';
import { createToolResultBudget, headAndTail, TOOL_RESULT_LIMITS } from './tool-results.js';

type Handler = (event: unknown) => Promise<unknown>;

/** The budget's handlers, with spills recorded instead of sent to Core. */
function budget(): {
  on: (name: string) => Handler;
  spills: { name: string; length: number }[];
} {
  const spills: { name: string; length: number }[] = [];
  const io = {
    spill: (name: string, content: string) => {
      spills.push({ name, length: content.length });
      return Promise.resolve(`~/data/sessions/s/tmp/tool-results/${name}.txt`);
    },
  } as unknown as CoreIo;
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  void createToolResultBudget({ io, isExempt: (tool) => tool === 'Read' })(pi);
  return {
    spills,
    on: (name) => {
      const handler = handlers.get(name);
      if (handler === undefined) throw new Error(`no ${name} handler`);
      return handler;
    },
  };
}

function result(id: string, text: string, toolName = 'Grep'): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName,
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 0,
  };
}

function texts(messages: readonly AgentMessage[]): string[] {
  return messages.map((m) =>
    m.role === 'toolResult'
      ? m.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('')
      : m.role,
  );
}

describe('tool result budget', () => {
  it('spills a result over 50K characters and keeps a preview with the path', async () => {
    const { on, spills } = budget();
    const text = `${'a'.repeat(30_000)}${'z'.repeat(30_000)}`;
    const changed = (await on('tool_result')({
      toolName: 'Grep',
      toolCallId: 'toolu_1',
      content: [
        { type: 'text', text },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
    })) as { content: { type: string; text?: string }[] };
    expect(spills).toEqual([{ name: 'toolu_1', length: 60_000 }]);
    const preview = changed.content[0]?.text ?? '';
    expect(preview).toContain('60000 characters');
    expect(preview).toContain('~/data/sessions/s/tmp/tool-results/toolu_1.txt');
    expect(preview).toContain('a'.repeat(1000));
    expect(preview).toContain('z'.repeat(1000));
    expect(preview).toContain('58000 characters left out');
    expect(preview.length).toBeLessThan(TOOL_RESULT_LIMITS.previewChars + 600);
    expect(changed.content[1]?.type).toBe('image');
  });

  it('leaves short results and Read alone', async () => {
    const { on, spills } = budget();
    const handler = on('tool_result');
    await expect(
      handler({
        toolName: 'Bash',
        toolCallId: 'a',
        content: [{ type: 'text', text: 'x'.repeat(50_000) }],
      }),
    ).resolves.toBeUndefined();
    await expect(
      handler({
        toolName: 'Read',
        toolCallId: 'b',
        content: [{ type: 'text', text: 'x'.repeat(60_000) }],
      }),
    ).resolves.toBeUndefined();
    expect(spills).toEqual([]);
  });

  it('fits the results of one response into 200K characters, largest first, the same way each request', async () => {
    const { on, spills } = budget();
    const context = on('context');
    const messages: AgentMessage[] = [
      { role: 'user', content: 'go', timestamp: 0 },
      { role: 'assistant' } as AgentMessage,
      result('c1', 'a'.repeat(45_000)),
      result('c2', 'b'.repeat(49_000)),
      result('c3', 'c'.repeat(48_000)),
      result('c4', 'd'.repeat(47_000)),
      result('c5', 'e'.repeat(46_000), 'Read'),
      { role: 'assistant' } as AgentMessage,
      result('c6', 'f'.repeat(49_000)),
    ];
    const first = (await context({ messages })) as { messages: AgentMessage[] };
    // 235K in the first run: the largest non-Read result (c2) is enough to get under 200K.
    expect(spills.map((s) => s.name)).toEqual(['c2']);
    const shown = texts(first.messages);
    expect(shown[3]).toContain('49000 characters');
    expect(shown[2]).toBe('a'.repeat(45_000));
    expect(shown[8]).toBe('f'.repeat(49_000));
    // The next request gets the same text and spills nothing again.
    const second = (await context({ messages })) as { messages: AgentMessage[] };
    expect(texts(second.messages)).toEqual(shown);
    expect(spills).toHaveLength(1);
  });

  it('previews never cut a surrogate pair', () => {
    const text = `${'x'.repeat(999)}🙂${'y'.repeat(5000)}🙂${'z'.repeat(999)}`;
    const preview = headAndTail(text, 2000);
    expect(preview.startsWith('x'.repeat(999))).toBe(true);
    expect(preview).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    expect(preview.endsWith('z'.repeat(999))).toBe(true);
  });
});
