import { describe, expect, it } from 'vitest';

import { originOf } from './origin.js';

describe('originOf', () => {
  it('gives app-scheme URLs the tuple origin Chromium uses', () => {
    expect(originOf('app://piarc/index.html')).toBe('app://piarc');
    expect(originOf('app://piarc/a/b?c#d')).toBe('app://piarc');
    expect(originOf('app://piarc.evil.com/index.html')).toBe('app://piarc.evil.com');
  });

  it('keeps the origin of special schemes', () => {
    expect(originOf('https://example.com/a')).toBe('https://example.com');
    expect(originOf('http://localhost:5173/')).toBe('http://localhost:5173');
  });

  it('returns null for opaque origins and invalid input', () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hi',
      'about:blank',
      'piarc://open',
      'app:index.html',
      '::',
    ]) {
      expect(originOf(url), url).toBe('null');
    }
  });
});
