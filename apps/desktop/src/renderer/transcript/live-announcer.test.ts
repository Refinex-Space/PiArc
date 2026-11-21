// T43-A04: a reply streamed at 100 tokens a second updates the live region once per interval,
// not per token, and the turn's result is announced once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LIVE_ANNOUNCE } from './constants.js';
import { ThrottledAnnouncer, type AnnouncerClock } from './live-announcer.js';

const clock: AnnouncerClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ThrottledAnnouncer', () => {
  it('updates once per interval while 100 tokens a second stream, then the result once', () => {
    const published: { at: number; text: string }[] = [];
    const start = Date.now();
    const announcer = new ThrottledAnnouncer(
      (text) => published.push({ at: Date.now() - start, text }),
      clock,
    );
    const seconds = 20;
    // One progress update per token (10 ms apart), each with a different word count.
    for (let token = 1; token <= seconds * 100; token++) {
      announcer.progress(`Writing the reply: ${String(token)} words so far`);
      vi.advanceTimersByTime(10);
    }
    announcer.result('Reply: done.');
    vi.advanceTimersByTime(LIVE_ANNOUNCE.intervalMs * 2);
    const progress = published.filter((p) => p.text.startsWith('Writing'));
    // The first at once, then one at the end of each interval: 0, 5, 10, 15 and 20 s.
    expect(progress.length).toBe(Math.floor((seconds * 1000) / LIVE_ANNOUNCE.intervalMs) + 1);
    for (let i = 1; i < progress.length; i++) {
      expect((progress[i]?.at ?? 0) - (progress[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(
        LIVE_ANNOUNCE.intervalMs,
      );
    }
    expect(published.filter((p) => p.text === 'Reply: done.')).toHaveLength(1);
    expect(published.at(-1)?.text).toBe('Reply: done.');
  });

  it('does not repeat the same text', () => {
    const published: string[] = [];
    const announcer = new ThrottledAnnouncer((text) => published.push(text), clock, 1000);
    announcer.progress('Running Read a.ts');
    announcer.progress('Running Read a.ts');
    vi.advanceTimersByTime(5000);
    announcer.progress('Running Read a.ts');
    vi.advanceTimersByTime(5000);
    expect(published).toEqual(['Running Read a.ts']);
  });

  it('drops progress still waiting when the result comes', () => {
    const published: string[] = [];
    const announcer = new ThrottledAnnouncer((text) => published.push(text), clock, 1000);
    announcer.progress('Running Read a.ts');
    vi.advanceTimersByTime(200);
    announcer.progress('Running Grep TODO');
    announcer.result('Done.');
    vi.advanceTimersByTime(5000);
    expect(published).toEqual(['Running Read a.ts', 'Done.']);
  });
});
