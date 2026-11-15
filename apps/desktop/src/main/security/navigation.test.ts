import { describe, expect, it } from 'vitest';

import { APP_ORIGIN } from '../app-scheme.js';
import { isTrustedUrl, originForLog } from './navigation.js';

describe('isTrustedUrl', () => {
  const trusted = [APP_ORIGIN];

  it('allows pages of the app origin', () => {
    expect(isTrustedUrl('app://piarc/index.html', trusted)).toBe(true);
    expect(isTrustedUrl('app://piarc/other.html?x=1#y', trusted)).toBe(true);
  });

  it('blocks other origins, including look-alike prefixes', () => {
    for (const url of [
      'https://example.com/',
      'http://localhost:5173/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hi',
      'about:blank',
      'app://piarcx/index.html',
      'app://piarc.evil.com/index.html',
      'app://other/index.html',
      'not a url',
    ]) {
      expect(isTrustedUrl(url, trusted), url).toBe(false);
    }
  });
});

describe('originForLog', () => {
  it('drops paths and queries', () => {
    expect(originForLog('https://example.com/path?token=secret')).toBe('https://example.com');
    expect(originForLog('javascript:alert(document.cookie)')).toBe('javascript:');
    expect(originForLog('file:///Users/someone/secret.txt')).toBe('file:');
    expect(originForLog('::')).toBe('<invalid url>');
  });
});
