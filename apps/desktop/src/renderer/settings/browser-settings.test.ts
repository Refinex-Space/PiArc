import { describe, expect, it } from 'vitest';

import { pointerOf, preferencesFrom } from '../../shared/preferences.js';
import { isLocalLink } from '../browser/local-links.js';
import {
  agentSites,
  browserDomain,
  parseImports,
  parseOutcome,
  parseProfiles,
  parseSites,
  splitNames,
  visibleSites,
} from './browser-settings.js';

describe('browser settings page data', () => {
  it('parses Core answers and drops malformed entries', () => {
    expect(
      parseProfiles('{"chrome":true,"profiles":[{"id":"Default","name":"个人"},{"name":"x"}]}'),
    ).toEqual({ chrome: true, profiles: [{ id: 'Default', name: '个人' }] });
    expect(parseProfiles('{"profiles":[]}').chrome).toBe(false);
    expect(parseSites('{"sites":[{"site":"a.test","count":3},{"count":1}]}')).toEqual([
      { site: 'a.test', count: 3 },
    ]);
    expect(
      parseImports(
        '{"imports":[{"site":"github.com","count":2,"profile":"Work","importedAt":5},{}]}',
      ),
    ).toEqual([{ site: 'github.com', count: 2, profile: 'Work', importedAt: 5 }]);
  });

  it('reads the import outcome without values', () => {
    expect(parseOutcome('{"status":"cancelled"}')).toEqual({ status: 'cancelled' });
    expect(parseOutcome('{"status":"unavailable"}')).toEqual({ status: 'unavailable' });
    expect(
      parseOutcome(
        '{"status":"imported","sites":[{"site":"a.test","imported":1,"skipped":[{"reason":"appBound","count":2}]}]}',
      ),
    ).toEqual({
      status: 'imported',
      sites: [{ site: 'a.test', imported: 1, skipped: [{ reason: 'appBound', count: 2 }] }],
    });
    expect(() => parseOutcome('{"status":"other"}')).toThrow();
  });

  it('filters sites by search and by the page host', () => {
    const sites = [
      { site: 'github.com', count: 2 },
      { site: 'gist.github.com', count: 1 },
      { site: 'gitlab.com', count: 1 },
    ];
    expect(visibleSites(sites, 'git').map((s) => s.site)).toEqual([
      'github.com',
      'gist.github.com',
      'gitlab.com',
    ]);
    expect(visibleSites(sites, '', 'gist.github.com').map((s) => s.site)).toEqual([
      'github.com',
      'gist.github.com',
    ]);
    expect(visibleSites(sites, 'lab', 'github.com')).toEqual([]);
  });

  it('lists the user file Browser(domain:…) allow rules only', () => {
    const view = {
      sources: [
        {
          id: 'user',
          rules: [
            { behavior: 'allow', rule: 'Browser(domain:docs.rs)' },
            { behavior: 'deny', rule: 'Browser(domain:evil.test)' },
            { behavior: 'allow', rule: 'WebFetch(domain:docs.rs)' },
          ],
        },
        { id: 'project', rules: [{ behavior: 'allow', rule: 'Browser(domain:x.test)' }] },
      ],
    };
    expect(agentSites(view)).toEqual(['Browser(domain:docs.rs)']);
    expect(browserDomain('Browser(domain:*.example.com)')).toBe('*.example.com');
    expect(browserDomain('Browser')).toBeUndefined();
  });

  it('splits local names', () => {
    expect(splitNames(' *.Test, dev.local\n*.test ')).toEqual(['*.test', 'dev.local']);
  });
});

describe('browser preferences', () => {
  it('reads the user file with defaults', () => {
    expect(preferencesFrom({}).browser).toEqual({
      agentEnabled: true,
      revealOnAgentUse: true,
      storage: 'persist',
      localHostnames: ['*.localhost', '*.test', '*.local'],
      openLocalLinks: true,
      searchEngine: 'google',
      downloadDirectory: null,
      devtoolsDock: 'bottom',
      approvalTimeout: 120,
    });
    const read = preferencesFrom({
      browser: {
        agentEnabled: false,
        storage: 'session',
        localHostnames: ['*.dev', 'BAD NAME'],
        searchEngine: 'nope',
        downloadDirectory: 'relative/dir',
        devtoolsDock: 'right',
        approvalTimeout: 5000,
      },
    }).browser;
    expect(read.agentEnabled).toBe(false);
    expect(read.storage).toBe('session');
    expect(read.localHostnames).toEqual(['*.dev']);
    expect(read.searchEngine).toBe('google');
    expect(read.downloadDirectory).toBeNull();
    expect(read.devtoolsDock).toBe('right');
    expect(read.approvalTimeout).toBe(600);
  });

  it('validates changes and writes defaults as removals', () => {
    expect(pointerOf({ key: 'browser.agentEnabled', value: false })).toEqual({
      pointer: '/browser/agentEnabled',
      value: false,
    });
    expect(pointerOf({ key: 'browser.agentEnabled', value: true })).toEqual({
      pointer: '/browser/agentEnabled',
      value: null,
    });
    expect(pointerOf({ key: 'browser.approvalTimeout', value: 9 })).toBeUndefined();
    expect(pointerOf({ key: 'browser.approvalTimeout', value: 30 })).toEqual({
      pointer: '/browser/approvalTimeout',
      value: 30,
    });
    expect(pointerOf({ key: 'browser.storage', value: 'session' })).toEqual({
      pointer: '/browser/storage',
      value: 'session',
    });
    expect(pointerOf({ key: 'browser.localHostnames', value: ['*.Dev', '*.dev'] })).toEqual({
      pointer: '/browser/localHostnames',
      value: ['*.dev'],
    });
    expect(pointerOf({ key: 'browser.localHostnames', value: ['a b'] })).toBeUndefined();
    expect(pointerOf({ key: 'browser.downloadDirectory', value: 'C:\\Downloads' })).toEqual({
      pointer: '/browser/downloadDirectory',
      value: 'C:\\Downloads',
    });
    expect(pointerOf({ key: 'browser.downloadDirectory', value: 'rel' })).toBeUndefined();
    expect(pointerOf({ key: 'browser.devtoolsDock', value: 'left' })).toBeUndefined();
    expect(pointerOf({ key: 'browser.searchEngine', value: 'baidu' })).toEqual({
      pointer: '/browser/searchEngine',
      value: 'baidu',
    });
    expect(pointerOf({ key: 'browser.unknown', value: 1 })).toBeUndefined();
  });
});

describe('local links', () => {
  it.each([
    ['http://localhost:5173/', true],
    ['https://app.localhost/x', true],
    ['http://127.0.0.1:8080', true],
    ['http://[::1]:3000/', true],
    ['http://shop.test/', true],
    ['https://example.com/', false],
    ['http://user:pw@localhost/', false],
    ['file:///etc/passwd', false],
    ['not a url', false],
  ])('%s is local: %s', (href, expected) => {
    expect(isLocalLink(href, ['*.test', '*.local'])).toBe(expected);
  });
});
