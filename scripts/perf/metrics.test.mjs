// T44-A01: every row of architecture chapter 11's budget table has a measured metric or an
// exclusion with its reason, and every metric names a row that exists.
import { describe, expect, it } from 'vitest';

import { chapter11Rows, readChapter11Rows } from './chapter11.mjs';
import { EXCLUDED, METRICS } from './metrics.mjs';

/**
 * Rows with neither a metric nor an exclusion, and metrics or exclusions naming no row.
 * @param {readonly string[]} rows
 */
function coverage(rows) {
  const covers = (/** @type {string} */ row, /** @type {string} */ name) => row.startsWith(name);
  return {
    unmeasured: rows.filter(
      (row) =>
        !METRICS.some((m) => covers(row, m.row)) && !EXCLUDED.some((e) => covers(row, e.row)),
    ),
    stale: [...METRICS.map((m) => m.row), ...EXCLUDED.map((e) => e.row)].filter(
      (name) => !rows.some((row) => covers(row, name)),
    ),
  };
}

describe('chapter 11 coverage', () => {
  it('measures every row of the budget table or says why not', async () => {
    const rows = await readChapter11Rows();
    expect(rows.length).toBeGreaterThan(15);
    expect(coverage(rows)).toEqual({ unmeasured: [], stale: [] });
  });

  it('fails when chapter 11 gains a row without a measurement', () => {
    const markdown = [
      '## 11. 性能预算与非功能需求',
      '',
      '| 指标 | 预算 | M0 实测 macOS | M0 实测 Windows | 测量方式 |',
      '|---|---|---|---|---|',
      '| 冷启动到可交互窗口（侧栏已加载） | ≤ 1.0 s | | | |',
      '| 新的指标 | ≤ 1 | | | |',
      '',
    ].join('\n');
    expect(coverage(chapter11Rows(markdown)).unmeasured).toEqual(['新的指标']);
  });

  it('has unique metric ids, each in at least one lane', () => {
    const ids = METRICS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const metric of METRICS) expect(metric.lanes.length, metric.id).toBeGreaterThan(0);
  });
});
