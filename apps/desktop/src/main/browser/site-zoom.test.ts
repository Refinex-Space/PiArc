import { describe, expect, it } from 'vitest';

import { nextZoom, SiteZoom, siteOf, ZOOM_LIMITS } from './site-zoom.js';

function memoryStore(initial?: string) {
  const writes: string[] = [];
  return {
    writes,
    store: {
      read: () => Promise.resolve(initial),
      write: (text: string) => {
        writes.push(text);
        return Promise.resolve();
      },
    },
  };
}

describe('site zoom (B1.3.9)', () => {
  it('steps through the zoom levels and resets', () => {
    expect(nextZoom(100, 'in')).toBe(110);
    expect(nextZoom(100, 'out')).toBe(90);
    expect(nextZoom(500, 'in')).toBe(500);
    expect(nextZoom(25, 'out')).toBe(25);
    expect(nextZoom(123, 'in')).toBe(110);
    expect(nextZoom(150, 'reset')).toBe(100);
  });

  it('keys web pages by host and port only', () => {
    expect(siteOf('https://Example.com/a?b')).toBe('example.com');
    expect(siteOf('http://localhost:5173/x')).toBe('localhost:5173');
    expect(siteOf('piarc-browse://token/index.html')).toBeUndefined();
    expect(siteOf('about:blank')).toBeUndefined();
    expect(siteOf('nonsense')).toBeUndefined();
  });

  it('remembers a site per partition and saves only persistent ones', async () => {
    const { store, writes } = memoryStore();
    const zoom = new SiteZoom(store);
    await zoom.load();
    zoom.set('p1', 'https://example.com/a', 150, true);
    zoom.set('m1', 'https://example.com/a', 67, false);
    expect(zoom.get('p1', 'https://example.com/other')).toBe(150);
    expect(zoom.get('m1', 'https://example.com/')).toBe(67);
    expect(zoom.get('p2', 'https://example.com/')).toBe(100);
    await zoom.flushed();
    expect(JSON.parse(writes.at(-1) ?? '{}')).toEqual({
      version: 1,
      partitions: { p1: { 'example.com': 150 } },
    });
    // Back to 100 forgets the site.
    zoom.set('p1', 'https://example.com/', 100, true);
    await zoom.flushed();
    expect(JSON.parse(writes.at(-1) ?? '{}')).toEqual({ version: 1, partitions: {} });
  });

  it('forgets a partition when its browsing data is cleared', async () => {
    const { store, writes } = memoryStore();
    const zoom = new SiteZoom(store);
    await zoom.load();
    zoom.set('p1', 'https://a.example/', 150, true);
    zoom.set('p2', 'https://a.example/', 200, true);
    zoom.forget('p1');
    await zoom.flushed();
    expect(zoom.get('p1', 'https://a.example/')).toBe(100);
    expect(JSON.parse(writes.at(-1) ?? '{}')).toEqual({
      version: 1,
      partitions: { p2: { 'a.example': 200 } },
    });
  });

  it('loads a saved file and ignores invalid entries', async () => {
    const saved = JSON.stringify({
      version: 1,
      partitions: { p1: { 'a.test': 200, 'b.test': 9999, 'c.test': 'x' }, bad: 3 },
    });
    const zoom = new SiteZoom(memoryStore(saved).store);
    await zoom.load();
    expect(zoom.get('p1', 'http://a.test/')).toBe(200);
    expect(zoom.get('p1', 'http://b.test/')).toBe(100);
    expect(zoom.get('p1', 'http://c.test/')).toBe(100);
  });

  it('keeps at most the limit of sites per partition, dropping the oldest', async () => {
    const { store } = memoryStore();
    const zoom = new SiteZoom(store);
    await zoom.load();
    for (let i = 0; i <= ZOOM_LIMITS.sites; i += 1) {
      zoom.set('p', `https://s${String(i)}.example/`, 125, true);
    }
    expect(zoom.get('p', 'https://s0.example/')).toBe(100);
    expect(zoom.get('p', `https://s${String(ZOOM_LIMITS.sites)}.example/`)).toBe(125);
  });
});
