// The start page's pure parts (B1.1.1, B1.2.3, B1.6.2): recent pages, the address bar's
// suggestions and the containment of a single file opened from outside the workspace.
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

const { containedFile, FileGrants, within } = await import('./file-grants.js');
const { BrowserRecents, parseRecents, recordable, remember, KEPT_RECENTS } =
  await import('./recents.js');
const { matchScore, rankSuggestions } = await import('./suggestions.js');

describe('recent pages', () => {
  it('keeps one entry per address, newest first, and a known title', () => {
    let list = remember([], { url: 'http://localhost:5173/', title: 'Vite' });
    list = remember(list, { url: 'https://example.com/', title: 'Example' });
    list = remember(list, { url: 'http://localhost:5173/', title: '' });
    expect(list).toEqual([
      { url: 'http://localhost:5173/', title: 'Vite' },
      { url: 'https://example.com/', title: 'Example' },
    ]);
    const many = Array.from({ length: 80 }, (_, i) => ({
      url: `https://a.test/${String(i)}`,
      title: '',
    }));
    expect(many.reduce<typeof list>((acc, entry) => remember(acc, entry), [])).toHaveLength(
      KEPT_RECENTS,
    );
  });

  it('records web pages and workspace files only, never credentials', () => {
    expect(recordable('https://example.com/a')).toBe(true);
    expect(recordable('./site/index.html')).toBe(true);
    expect(recordable('https://me:secret@example.com/')).toBe(false);
    expect(recordable('piarc-browse://0123456789abcdef/index.html')).toBe(false);
    expect(recordable('about:blank')).toBe(false);
    expect(recordable('data:text/html,hi')).toBe(false);
  });

  it('reads a saved file and drops malformed entries', () => {
    const parsed = parseRecents({
      version: 1,
      workspaces: {
        '/w': [
          { url: 'https://a.test/', title: 'A' },
          { url: 7 },
          { url: 'file:///etc/hosts', title: '' },
        ],
        '/x': 'nope',
      },
    });
    expect([...parsed.keys()]).toEqual(['/w']);
    expect(parsed.get('/w')).toEqual([{ url: 'https://a.test/', title: 'A' }]);
    expect(parseRecents(null).size).toBe(0);
  });

  it('writes the file atomically and reads it back', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'piarc-recents-'));
    try {
      const file = path.join(dir, 'browser', 'recents.json');
      const recents = new BrowserRecents(file);
      recents.record('/w', 'http://localhost:5173/', 'Vite app');
      recents.record('/w', 'https://example.com/', 'Example');
      recents.record('/other', 'https://other.test/', 'Other');
      await expect.poll(() => recents.list('/w', 8)).toHaveLength(2);
      await recents.flush();
      const saved: unknown = JSON.parse(await readFile(file, 'utf8'));
      expect(saved).toMatchObject({ version: 1 });
      const again = new BrowserRecents(file);
      expect(await again.list('/w', 1)).toEqual([
        { url: 'https://example.com/', title: 'Example' },
      ]);
      expect(await again.list('/nobody', 8)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('address bar suggestions', () => {
  const sources = {
    history: [
      { url: 'https://docs.example.com/guide', title: 'Guide to Widgets' },
      { url: 'http://localhost:5173/', title: 'Vite App' },
      { url: 'https://news.test/', title: 'Local news' },
    ],
    tabs: [{ url: 'https://example.com/', title: 'Example Domain' }],
    services: [{ url: 'http://localhost:5173/', title: 'npm run dev' }],
  };

  it('scores address prefixes over title words over address parts over substrings', () => {
    expect(matchScore('docs', sources.history[0] ?? { url: '', title: '' })).toBe(4);
    expect(matchScore('widg', sources.history[0] ?? { url: '', title: '' })).toBe(3);
    expect(matchScore('exam', sources.history[0] ?? { url: '', title: '' })).toBe(2);
    expect(matchScore('ampl', sources.history[0] ?? { url: '', title: '' })).toBe(1);
    expect(matchScore('zzz', sources.history[0] ?? { url: '', title: '' })).toBe(0);
  });

  it('ranks matches, prefers tabs and services, and lists an address once', () => {
    const ranked = rankSuggestions('local', sources, 8);
    expect(ranked.map((s) => `${s.kind} ${s.url}`)).toEqual([
      'server http://localhost:5173/',
      'history https://news.test/',
    ]);
    expect(rankSuggestions('exam', sources, 8)[0]).toEqual({
      url: 'https://example.com/',
      title: 'Example Domain',
      kind: 'tab',
    });
    expect(rankSuggestions('nothing-matches', sources, 8)).toEqual([]);
  });

  it('offers tabs, services and recent pages for an empty field, up to the limit', () => {
    const ranked = rankSuggestions('  ', sources, 3);
    expect(ranked.map((s) => s.kind)).toEqual(['tab', 'server', 'history']);
    expect(ranked).toHaveLength(3);
  });
});

describe('a single HTML file from outside the workspace', () => {
  let root = '';
  let outside = '';
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'piarc-grant-'));
    outside = await mkdtemp(path.join(tmpdir(), 'piarc-other-'));
    await mkdir(path.join(root, 'site 页面', 'img'), { recursive: true });
    await writeFile(path.join(root, 'site 页面', 'index.html'), '<title>Outside</title>');
    await writeFile(path.join(root, 'site 页面', 'img', 'a.png'), 'png');
    await writeFile(path.join(root, 'secret.txt'), 'secret');
    await writeFile(path.join(outside, 'leak.txt'), 'leak');
    await symlink(path.join(outside, 'leak.txt'), path.join(root, 'site 页面', 'link.txt'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('knows what is inside a directory', () => {
    expect(within('/a/b', '/a/b/c.html')).toBe(true);
    expect(within('/a/b', '/a/b')).toBe(false);
    expect(within('/a/b', '/a/bc/x')).toBe(false);
    expect(within('/a/b', '/a/x')).toBe(false);
  });

  it('serves the directory of the granted file and nothing around it', async () => {
    const grants = new FileGrants();
    const url = await grants.grant('tab-1', path.join(root, 'site 页面', 'index.html'));
    const parsed = new URL(url);
    expect(parsed.protocol).toBe('piarc-browse:');
    expect(grants.owns(parsed.hostname)).toBe(true);
    const site = await import('node:fs/promises').then((fs) =>
      fs.realpath(path.join(root, 'site 页面')),
    );
    expect(await containedFile(site, 'img/a.png')).toBe(path.join(site, 'img', 'a.png'));
    // A link to a file elsewhere stays outside.
    expect(await containedFile(site, 'link.txt')).toBeUndefined();
    const page = await grants.serve(parsed.hostname, parsed.pathname, 'GET');
    expect(page?.status).toBe(200);
    expect(page?.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await page?.text()).toBe('<title>Outside</title>');
    expect((await grants.serve(parsed.hostname, '/img/a.png', 'GET'))?.status).toBe(200);
    expect((await grants.serve(parsed.hostname, '/../secret.txt', 'GET'))?.status).toBe(403);
    expect((await grants.serve(parsed.hostname, '/%2e%2e/secret.txt', 'GET'))?.status).toBe(403);
    expect((await grants.serve(parsed.hostname, '/link.txt', 'GET'))?.status).toBe(404);
    expect((await grants.serve(parsed.hostname, '/.env', 'GET'))?.status).toBe(403);
    expect(await grants.serve('0123456789abcdef', '/index.html', 'GET')).toBeUndefined();
    // Closing the tab ends the grant.
    grants.revoke('tab-1');
    expect(grants.owns(parsed.hostname)).toBe(false);
    expect(await grants.serve(parsed.hostname, parsed.pathname, 'GET')).toBeUndefined();
  });
});
