import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LIVE_RELOAD, LiveReload } from './live-reload.js';

function fixture() {
  const watched = new Map<string, () => void>();
  const closed: string[] = [];
  const reloads: string[] = [];
  const live = new LiveReload({
    resolve: (sessionId, relative) => Promise.resolve(`/work/${sessionId}/${relative}`),
    watch: (file, onChange) => {
      watched.set(file, onChange);
      return {
        close: () => {
          closed.push(file);
          watched.delete(file);
        },
      };
    },
    reload: (sessionId) => {
      reloads.push(sessionId);
    },
  });
  return { live, watched, closed, reloads };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

describe('workspace live reload (B1.6.1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reloads the session once, 300 ms after the last change of a served file', async () => {
    const f = fixture();
    f.live.served('s1', 'site/index.html');
    f.live.served('s1', 'site/style.css');
    f.live.served('s1', 'site/index.html');
    await settle();
    expect([...f.watched.keys()].sort()).toEqual([
      '/work/s1/site/index.html',
      '/work/s1/site/style.css',
    ]);
    f.watched.get('/work/s1/site/style.css')?.();
    await vi.advanceTimersByTimeAsync(LIVE_RELOAD.delayMs - 50);
    f.watched.get('/work/s1/site/index.html')?.();
    await vi.advanceTimersByTimeAsync(LIVE_RELOAD.delayMs - 1);
    expect(f.reloads).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.reloads).toEqual(['s1']);
  });

  it('watches a changed file again when the reload serves it (editors replace files)', async () => {
    const f = fixture();
    f.live.served('s1', 'a.html');
    await settle();
    f.watched.get('/work/s1/a.html')?.();
    expect(f.closed).toEqual(['/work/s1/a.html']);
    f.live.served('s1', 'a.html');
    await settle();
    expect(f.watched.has('/work/s1/a.html')).toBe(true);
  });

  it('keeps sessions apart, bounds the watched files and forgets a session', async () => {
    const f = fixture();
    for (let i = 0; i <= LIVE_RELOAD.files; i += 1) f.live.served('s1', `f${String(i)}.js`);
    f.live.served('s2', 'b.html');
    await settle();
    expect([...f.watched.keys()].filter((k) => k.startsWith('/work/s1/'))).toHaveLength(
      LIVE_RELOAD.files,
    );
    expect(f.watched.has('/work/s1/f0.js')).toBe(false);
    f.watched.get('/work/s2/b.html')?.();
    await vi.advanceTimersByTimeAsync(LIVE_RELOAD.delayMs);
    expect(f.reloads).toEqual(['s2']);
    f.live.forget('s1');
    expect([...f.watched.keys()].some((k) => k.startsWith('/work/s1/'))).toBe(false);
  });

  it('does not watch a file it cannot resolve', async () => {
    const f = fixture();
    const live = new LiveReload({
      resolve: () => Promise.resolve(undefined),
      watch: () => {
        throw new Error('not called');
      },
      reload: () => undefined,
    });
    live.served('s1', 'gone.html');
    await settle();
    expect(f.watched.size).toBe(0);
  });
});
