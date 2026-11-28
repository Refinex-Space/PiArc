import { describe, expect, it } from 'vitest';

import { modelId, modelPrice } from './usage-ipc.js';

describe('usage IPC validation', () => {
  it('accepts the four rates and nothing else', () => {
    expect(modelPrice({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
    expect(modelPrice(null)).toBeNull();
    expect(() => modelPrice({ input: -1, output: 1, cacheRead: 1, cacheWrite: 1 })).toThrow();
    expect(() =>
      modelPrice({ input: Number.NaN, output: 1, cacheRead: 1, cacheWrite: 1 }),
    ).toThrow();
    expect(() => modelPrice({ input: 1, output: 1, cacheRead: 1 })).toThrow();
    expect(() =>
      modelPrice({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1, tiers: [] }),
    ).toThrow();
    expect(() => modelPrice([1, 2, 3, 4])).toThrow();
  });

  it('takes ids of 1-256 printable characters', () => {
    expect(modelId('claude-sonnet-4-5', 'model')).toBe('claude-sonnet-4-5');
    expect(() => modelId('', 'model')).toThrow();
    expect(() => modelId('a\nb', 'model')).toThrow();
    expect(() => modelId('x'.repeat(257), 'model')).toThrow();
  });
});
