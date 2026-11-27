import { describe, expect, it } from 'vitest';

import { PROMPTED_LIMIT, promptHost, remembered } from './chrome-prompt.js';

describe('the pages that offer the Chrome sign-in import', () => {
  it('names the host of a site on the web', () => {
    expect(promptHost('https://github.com/piarc', [])).toBe('github.com');
    expect(promptHost('http://news.example.org/a?b', [])).toBe('news.example.org');
  });

  it('skips this machine, local development names and addresses', () => {
    for (const url of [
      'http://localhost:5173/',
      'http://app.localhost/',
      'http://127.0.0.1:8080/',
      'http://[::1]:3000/',
      'http://192.168.1.20/',
      'https://shop.test/',
      'http://printer.local/',
    ]) {
      expect(promptHost(url, ['*.test', '*.local']), url).toBeUndefined();
    }
  });

  it('skips pages that are not http(s) and addresses that do not parse', () => {
    for (const url of ['', 'about:blank', 'piarc-browse://0123/index.html', 'file:///a', 'x']) {
      expect(promptHost(url, []), url).toBeUndefined();
    }
  });
});

describe('remembering the workspaces that were asked', () => {
  it('adds a workspace once, newest last', () => {
    expect(remembered(['/a'], '/b')).toEqual(['/a', '/b']);
    expect(remembered(['/a', '/b'], '/a')).toEqual(['/b', '/a']);
  });

  it('keeps at most the newest ones', () => {
    const many = Array.from({ length: PROMPTED_LIMIT }, (_, i) => `/w${String(i)}`);
    const next = remembered(many, '/new');
    expect(next).toHaveLength(PROMPTED_LIMIT);
    expect(next[0]).toBe('/w1');
    expect(next.at(-1)).toBe('/new');
  });
});
