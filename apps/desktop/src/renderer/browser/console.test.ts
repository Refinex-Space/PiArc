import { describe, expect, it } from 'vitest';

import type { BrowserConsoleEntry } from '../../shared/browser.js';
import { CONSOLE_ATTACH_LIMITS, consoleText, matchesFilter } from './console.js';

function entry(
  seq: number,
  level: BrowserConsoleEntry['level'],
  text: string,
): BrowserConsoleEntry {
  return { seq, level, text, source: 'http://localhost:5173/app.js', line: seq, at: 0 };
}

describe('console drawer (B1.4.3)', () => {
  const entries = [
    entry(1, 'debug', 'starting'),
    entry(2, 'info', 'ready'),
    entry(3, 'warning', 'slow request'),
    entry(4, 'error', 'Uncaught TypeError: boom'),
  ];

  it('filters by level (info includes debug) and by text or source', () => {
    const seqs = (filter: Parameters<typeof matchesFilter>[1], text = '') =>
      entries.filter((e) => matchesFilter(e, filter, text)).map((e) => e.seq);
    expect(seqs('all')).toEqual([1, 2, 3, 4]);
    expect(seqs('error')).toEqual([4]);
    expect(seqs('warning')).toEqual([3]);
    expect(seqs('info')).toEqual([1, 2]);
    expect(seqs('all', 'BOOM')).toEqual([4]);
    expect(seqs('all', 'app.js')).toEqual([1, 2, 3, 4]);
  });

  it('writes one line per message with its source', () => {
    expect(consoleText(entries.slice(2))).toBe(
      '[warning] slow request (http://localhost:5173/app.js:3)\n' +
        '[error] Uncaught TypeError: boom (http://localhost:5173/app.js:4)',
    );
  });

  it('keeps the newest messages within the limits', () => {
    const many = Array.from({ length: CONSOLE_ATTACH_LIMITS.entries + 50 }, (_, i) =>
      entry(i + 1, 'info', `m${String(i + 1)}`),
    );
    const lines = consoleText(many).split('\n');
    expect(lines).toHaveLength(CONSOLE_ATTACH_LIMITS.entries);
    expect(lines.at(-1)).toContain(`m${String(CONSOLE_ATTACH_LIMITS.entries + 50)}`);
    const long = [entry(1, 'info', 'a'.repeat(20_000)), entry(2, 'info', 'b'.repeat(20_000))];
    const text = consoleText(long);
    expect(text.startsWith('[info] b')).toBe(true);
    expect(text).not.toContain('aaaa');
  });
});
