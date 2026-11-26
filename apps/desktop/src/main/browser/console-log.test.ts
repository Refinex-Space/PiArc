import { describe, expect, it } from 'vitest';

import { CONSOLE_LIMITS, ConsoleLog } from './console-log.js';

describe('console log (B1.4.3)', () => {
  it('numbers entries and answers those after a sequence number', () => {
    const log = new ConsoleLog(() => 1000);
    log.add('info', 'hello', 'http://localhost:5173/main.js', 3);
    log.add('error', 'Uncaught TypeError: x is undefined', 'http://localhost:5173/a.js', 9);
    expect(log.summary()).toEqual({ last: 2, count: 2, errors: 1, warnings: 0 });
    expect(log.after(1)).toEqual([
      {
        seq: 2,
        level: 'error',
        text: 'Uncaught TypeError: x is undefined',
        source: 'http://localhost:5173/a.js',
        line: 9,
        at: 1000,
      },
    ]);
  });

  it('keeps the newest entries and bounds each text', () => {
    const log = new ConsoleLog(() => 0);
    for (let i = 0; i < CONSOLE_LIMITS.entries + 5; i += 1)
      log.add('warning', `w${String(i)}`, '', 0);
    const all = log.after(0);
    expect(all).toHaveLength(CONSOLE_LIMITS.entries);
    expect(all[0]?.seq).toBe(6);
    expect(log.summary().warnings).toBe(CONSOLE_LIMITS.entries);
    log.add('info', 'x'.repeat(CONSOLE_LIMITS.text + 10), 'y'.repeat(5000), 1);
    const last = log.after(log.summary().last - 1)[0];
    expect(last?.text.length).toBe(CONSOLE_LIMITS.text + 1);
    expect(last?.text.endsWith('…')).toBe(true);
    expect(last?.source.length).toBeLessThanOrEqual(CONSOLE_LIMITS.source + 1);
  });

  it('clears but keeps counting', () => {
    const log = new ConsoleLog(() => 0);
    log.add('debug', 'a', '', 0);
    log.clear();
    expect(log.after(0)).toEqual([]);
    log.add('info', 'b', '', 0);
    expect(log.summary()).toEqual({ last: 2, count: 1, errors: 0, warnings: 0 });
  });

  it('drops lone surrogates so the text crosses IPC intact', () => {
    const log = new ConsoleLog(() => 0);
    log.add('info', 'a\ud800b', '', 0);
    expect(log.after(0)[0]?.text).toBe('a�b');
  });
});
