import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

const { HOST_CSP, hostFile } = await import('./host-session.js');

const root = path.resolve('/app/.vite/renderer/browser_host');

describe('hostFile (B2.2.1)', () => {
  it('maps the host origin into the bundle', () => {
    expect(hostFile(root, 'piarc-browser-host://host/index.html')).toBe(
      path.join(root, 'index.html'),
    );
    expect(hostFile(root, 'piarc-browser-host://host/')).toBe(path.join(root, 'index.html'));
    expect(hostFile(root, 'piarc-browser-host://host/assets/host-1.js')).toBe(
      path.join(root, 'assets', 'host-1.js'),
    );
  });

  it.each([
    'piarc-browser-host://host/../main_window/index.html',
    'piarc-browser-host://host/%2e%2e/main_window/index.html',
    'piarc-browser-host://host/a/%2e%2e%2f%2e%2e%2fmain_window/index.html',
  ])('never leaves the bundle for %s', (url) => {
    const file = hostFile(root, url);
    expect(file === null || file.startsWith(`${root}${path.sep}`)).toBe(true);
  });

  it.each([
    'piarc-browser-host://host/a%00b.js',
    'piarc-browser-host://other/index.html',
    'app://piarc/index.html',
    'not a url',
    'piarc-browser-host://host/%E0%A4%A',
  ])('refuses %s', (url) => {
    expect(hostFile(root, url)).toBeNull();
  });
});

describe('HOST_CSP', () => {
  it('allows scripts only from the host and no connections', () => {
    expect(HOST_CSP).toContain("default-src 'none'");
    expect(HOST_CSP).toContain("script-src piarc-browser-host: 'unsafe-eval'");
    expect(HOST_CSP).toContain("connect-src 'none'");
    expect(HOST_CSP).not.toContain('http');
  });
});
