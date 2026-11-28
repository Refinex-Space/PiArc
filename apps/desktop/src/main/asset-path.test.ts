import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { contentTypeFor, resolveAssetPath } from './asset-path.js';

const root = path.resolve('bundle root', '渲染');

describe('resolveAssetPath', () => {
  it('serves the isolated diagram runtime only on its dedicated document origin', () => {
    expect(resolveAssetPath(root, 'app://piarc/markdown-diagram/index.html')).toBeNull();
    expect(resolveAssetPath(root, 'app://piarc/MARKDOWN-DIAGRAM%2Fengine.js')).toBeNull();
  });
  it('maps the root and nested paths into the bundle', () => {
    expect(resolveAssetPath(root, 'app://piarc/')).toBe(path.join(root, 'index.html'));
    expect(resolveAssetPath(root, 'app://piarc/index.html')).toBe(path.join(root, 'index.html'));
    expect(resolveAssetPath(root, 'app://piarc/assets/index-1.js')).toBe(
      path.join(root, 'assets', 'index-1.js'),
    );
  });

  it('decodes percent-encoded names and ignores query and fragment', () => {
    expect(resolveAssetPath(root, 'app://piarc/a%20b/%E5%9B%BE.png?v=1#x')).toBe(
      path.join(root, 'a b', '图.png'),
    );
  });

  it('rejects other schemes and hosts', () => {
    expect(resolveAssetPath(root, 'file:///etc/passwd')).toBeNull();
    expect(resolveAssetPath(root, 'https://piarc/index.html')).toBeNull();
    expect(resolveAssetPath(root, 'app://other/index.html')).toBeNull();
    expect(resolveAssetPath(root, 'app://piarc.evil/index.html')).toBeNull();
    expect(resolveAssetPath(root, 'not a url')).toBeNull();
  });

  it('rejects paths that leave the bundle', () => {
    for (const url of [
      'app://piarc/..%2F..%2Fsecret.txt',
      'app://piarc/%2E%2E/%2E%2E/secret.txt',
      'app://piarc/assets/..%2F..%2F..%2Fsecret.txt',
      'app://piarc/..%5C..%5Csecret.txt',
      'app://piarc/%00.html',
      'app://piarc/%E0%A4%A',
    ]) {
      const resolved = resolveAssetPath(root, url);
      if (resolved !== null) {
        // Some inputs normalise to a harmless path inside the bundle; none may escape it.
        expect(path.relative(root, resolved).startsWith('..'), url).toBe(false);
        expect(path.isAbsolute(path.relative(root, resolved)), url).toBe(false);
      }
    }
    expect(resolveAssetPath(root, 'app://piarc/..%2F..%2Fsecret.txt')).toBeNull();
    expect(resolveAssetPath(root, 'app://piarc/%00.html')).toBeNull();
    expect(resolveAssetPath(root, 'app://piarc/%E0%A4%A')).toBeNull();
  });

  it.runIf(process.platform === 'win32')('rejects backslash traversal on Windows', () => {
    expect(resolveAssetPath(root, 'app://piarc/..%5C..%5Csecret.txt')).toBeNull();
  });
});

describe('contentTypeFor', () => {
  it('returns the type of known bundle files and octet-stream otherwise', () => {
    expect(contentTypeFor('index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor(path.join('assets', 'INDEX.JS'))).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('style.css')).toBe('text/css; charset=utf-8');
    expect(contentTypeFor('archive.bin')).toBe('application/octet-stream');
  });
});
