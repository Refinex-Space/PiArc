import { describe, expect, it } from 'vitest';

import { loopbackHost, navigable, requestVerdict } from './request-rules.js';

const denied = new Set([4100]);

describe('requestVerdict', () => {
  it.each([
    'https://example.com/',
    'http://localhost:5173/src/main.tsx',
    'ws://localhost:5173/',
    'wss://example.com/socket',
    'http://192.168.1.2:8000/',
    'data:image/png;base64,AAAA',
    'blob:https://example.com/0d3e',
    'about:blank',
    'piarc-browse://token/index.html',
    'http://localhost:4101/',
  ])('allows %s', (url) => {
    expect(requestVerdict(url, denied)).toEqual({ allow: true });
  });

  it.each([
    ['file:///etc/passwd', 'scheme'],
    ['app://piarc/index.html', 'scheme'],
    ['piarc://open?path=/x', 'scheme'],
    ['chrome://settings', 'scheme'],
    ['devtools://devtools/bundled/inspector.html', 'scheme'],
    ['ftp://example.com/', 'scheme'],
    ['http://169.254.169.254/latest/meta-data/', 'linkLocal'],
    ['http://[fe80::1]/', 'linkLocal'],
    ['http://localhost:4100/', 'piarcPort'],
    ['ws://127.0.0.1:4100/', 'piarcPort'],
    ['http://app.localhost:4100/', 'piarcPort'],
    ['http://[::1]:4100/', 'piarcPort'],
    ['not a url', 'invalid'],
  ])('THR-16 refuses %s (%s)', (url, reason) => {
    expect(requestVerdict(url, denied)).toEqual({ allow: false, reason });
  });
});

describe('loopbackHost', () => {
  it('knows names and literals of this machine', () => {
    for (const host of [
      'localhost',
      'LOCALHOST.',
      'a.localhost',
      '127.0.0.1',
      '127.9.9.9',
      '::1',
    ]) {
      expect(loopbackHost(host), host).toBe(true);
    }
    for (const host of ['localhost.example.com', '10.0.0.1', 'example.com']) {
      expect(loopbackHost(host), host).toBe(false);
    }
  });
});

describe('navigable', () => {
  it('lets the main frame load web pages and workspace files only', () => {
    expect(navigable('https://example.com')).toBe(true);
    expect(navigable('piarc-browse://t/a.html')).toBe(true);
    for (const url of ['file:///x', 'javascript:alert(1)', 'data:text/html,x', 'app://piarc/']) {
      expect(navigable(url), url).toBe(false);
    }
  });
});
