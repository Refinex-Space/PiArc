import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

const { insideRoot, relativePath, WorkspaceFiles } = await import('./workspace-files.js');

describe('relativePath', () => {
  it.each([
    ['/index.html', 'index.html'],
    ['/', 'index.html'],
    ['/docs/', 'docs/index.html'],
    ['/assets/app%20main.js', 'assets/app main.js'],
    ['/中文/页面.html', '中文/页面.html'],
    ['/.well', undefined],
  ])('%s → %s', (input, expected) => {
    expect(relativePath(input)).toBe(expected);
  });

  it.each([
    '/.env',
    '/.git/config',
    '/a/../../etc/passwd',
    '/%2e%2e/x',
    '/a%5cb',
    '/x%00y',
    '/%E0%A4%A',
  ])('THR-16 refuses %s', (input) => {
    expect(relativePath(input)).toBeUndefined();
  });
});

describe('insideRoot', () => {
  const root = path.resolve('/work/site');
  const home = path.resolve('/Users/me');

  it('maps paths inside the root', () => {
    expect(insideRoot(path.join(root, 'index.html'), root, home)).toBe('index.html');
    expect(insideRoot('./docs/a.html', root, home)).toBe('docs/a.html');
    expect(insideRoot('docs/../b.html', root, home)).toBe('b.html');
  });

  it('refuses paths outside the root', () => {
    expect(insideRoot('../other/a.html', root, home)).toBeUndefined();
    expect(insideRoot('/etc/passwd', root, home)).toBeUndefined();
    expect(insideRoot('~/secret.html', root, home)).toBeUndefined();
  });
});

describe('WorkspaceFiles', () => {
  it('gives each session one token and finds the session again', () => {
    const files = new WorkspaceFiles({ projectFiles: () => Promise.resolve('{}') });
    const a = files.url('s-1', 'docs/index.html');
    const b = files.url('s-1', 'a b.html');
    expect(new URL(a).hostname).toBe(new URL(b).hostname);
    expect(b.endsWith('/a%20b.html')).toBe(true);
    expect(files.sessionOf(a)).toBe('s-1');
    expect(files.sessionOf('piarc-browse://unknown/x')).toBeUndefined();
  });
});
