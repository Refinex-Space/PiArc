import { describe, expect, it } from 'vitest';

import { APP_ORIGIN } from '../app-scheme.js';
import type { WebContents } from 'electron';

import { guardWebContents, isTrustedUrl, originForLog } from './navigation.js';

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

describe('guardWebContents', () => {
  it('THR-13 cancels main-frame, subframe and redirect navigations away from the app origin', () => {
    const listeners = new Map<string, (event: { url: string; preventDefault(): void }) => void>();
    const contents = {
      on: (name: string, listener: (event: { url: string; preventDefault(): void }) => void) => {
        listeners.set(name, listener);
      },
      setWindowOpenHandler: () => undefined,
    } as unknown as WebContents;
    guardWebContents(contents, [APP_ORIGIN]);
    for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
      const listener = listeners.get(name);
      expect(listener, name).toBeDefined();
      const outcome = (url: string) => {
        let prevented = false;
        listener?.({
          url,
          preventDefault: () => {
            prevented = true;
          },
        });
        return prevented;
      };
      expect(outcome('https://example.com/'), name).toBe(true);
      expect(outcome('app://piarc/index.html#/settings'), name).toBe(false);
    }
  });
});
