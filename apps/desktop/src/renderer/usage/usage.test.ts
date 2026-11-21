import { describe, expect, it } from 'vitest';

import { parseRates } from './UsagePage.js';
import { formatCost, parseSessionUsage, parseUsageReport, totalTokens } from './usage.js';

describe('usage', () => {
  it('reads a report and keeps unknown costs unknown', () => {
    const report = parseUsageReport(
      JSON.stringify({
        tokens: { requests: 2, input: 10, output: 5, cacheRead: 1, cacheWrite: 0, reasoning: 0 },
        partial: true,
        cost: 0.25,
        models: [
          {
            provider: 'p',
            model: 'a',
            tokens: { requests: 1, input: 5 },
            cost: 0.25,
            priceSource: 'catalog',
            price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          },
          { provider: 'p', model: 'free', tokens: {}, priceSource: 'unknown' },
          { model: 'no provider' },
        ],
        sessions: [{ sessionId: 's', tokens: {}, models: [], subagents: [{ sessionId: 'c' }] }, 7],
      }),
    );
    expect(report.models.map((m) => m.model)).toEqual(['a', 'free']);
    expect(report.models[1]?.cost).toBeUndefined();
    expect(report.models[0]?.price?.input).toBe(3);
    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]?.subagents?.[0]?.sessionId).toBe('c');
    expect(report.partial).toBe(true);
    expect(totalTokens(report.tokens)).toBe(16);
    expect(() => parseSessionUsage('[]')).toThrow();
  });

  it('writes cents above a dollar and four significant digits below', () => {
    expect(formatCost(12.345, 'en')).toBe('$12.35');
    expect(formatCost(0.0012345, 'en')).toBe('$0.001235');
    expect(formatCost(0, 'en')).toBe('$0.00');
  });

  it('accepts typed prices of 0 or more only', () => {
    expect(parseRates({ input: '3', output: '15', cacheRead: '0.3', cacheWrite: '3.75' })).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
    expect(parseRates({ input: '', output: '1', cacheRead: '1', cacheWrite: '1' })).toBeUndefined();
    expect(
      parseRates({ input: '-1', output: '1', cacheRead: '1', cacheWrite: '1' }),
    ).toBeUndefined();
    expect(
      parseRates({ input: 'x', output: '1', cacheRead: '1', cacheWrite: '1' }),
    ).toBeUndefined();
  });
});
