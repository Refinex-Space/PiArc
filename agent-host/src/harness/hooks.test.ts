import { DEFAULT_MAX_FRAME_BYTES } from '@piarc/protocol';
import { describe, expect, it } from 'vitest';

import { fitFrame, parseHookResult } from './hooks.js';

describe('hooks/run results', () => {
  it('accepts the merged decision and refuses malformed members', () => {
    expect(
      parseHookResult({
        block: 'Run the tests.',
        context: 'ctx',
        feedback: 'lint',
        updatedOutput: ['x'],
        instructions: 'Keep the API.',
        stop: { reason: 'budget' },
      }),
    ).toEqual({
      block: 'Run the tests.',
      context: 'ctx',
      feedback: 'lint',
      updatedOutput: ['x'],
      instructions: 'Keep the API.',
      stop: { reason: 'budget' },
    });
    expect(parseHookResult({})).toEqual({});
    expect(parseHookResult({ stop: {} })).toEqual({ stop: {} });
    expect(parseHookResult({ block: true })).toBeUndefined();
    expect(parseHookResult({ stop: 'now' })).toBeUndefined();
    expect(parseHookResult(null)).toBeUndefined();
  });
});

describe('hook input in one AHP frame', () => {
  it('keeps small inputs and cuts the long strings of a large one', () => {
    const small = { sessionId: 's', event: 'postToolUse', input: { tool_input: { content: 'x' } } };
    expect(fitFrame(small)).toBe(small);
    const content = '文'.repeat(DEFAULT_MAX_FRAME_BYTES / 2);
    const fitted = fitFrame({
      sessionId: 's',
      event: 'postToolUse',
      input: { tool_name: 'Write', tool_input: { path: '/w/a.txt', content } },
    });
    const input = fitted?.input as {
      tool_name: string;
      tool_input: { path: string; content: string };
    };
    expect(input.tool_name).toBe('Write');
    expect(input.tool_input.path).toBe('/w/a.txt');
    expect(input.tool_input.content.startsWith('文'.repeat(16 * 1024))).toBe(true);
    expect(input.tool_input.content).toContain('[PiArc cut');
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThan(DEFAULT_MAX_FRAME_BYTES);
  });

  it('gives up when even cut strings do not fit', () => {
    const many = Object.fromEntries(
      Array.from({ length: 200 }, (_, n) => [`k${String(n)}`, 'x'.repeat(64 * 1024)]),
    );
    expect(fitFrame({ sessionId: 's', event: 'stop', input: { many } })).toBeDefined();
    const keys = Object.fromEntries(
      Array.from({ length: 200_000 }, (_, n) => [`key-${String(n)}-${'k'.repeat(40)}`, 1]),
    );
    expect(fitFrame({ sessionId: 's', event: 'stop', input: keys })).toBeUndefined();
  });
});
