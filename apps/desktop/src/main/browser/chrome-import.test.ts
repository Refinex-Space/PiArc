import { describe, expect, it } from 'vitest';

import { Translator } from '../../shared/i18n/index.js';
import {
  ChromeImports,
  confirmationText,
  covered,
  importedHost,
  importedSites,
  parseImport,
  sitesArg,
  workspaceArg,
  type ChromeImportDeps,
  type CookieJar,
  type ImportCore,
} from './chrome-import.js';

const VALUE = 'imported-secret-value';

const answer = JSON.stringify({
  cookies: [
    {
      site: 'github.com',
      url: 'https://github.com/',
      name: '_gh_sess',
      value: VALUE,
      domain: '.github.com',
      path: '/',
      secure: true,
      httpOnly: true,
      expirationDate: 1_900_000_000,
      sameSite: 'lax',
    },
    {
      site: 'github.com',
      url: 'https://github.com/',
      name: 'refused',
      value: 'x',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'strict',
    },
  ],
  sites: [
    {
      site: 'github.com',
      imported: 2,
      skipped: [{ reason: 'appBound', count: 3 }],
    },
  ],
});

interface Recorded {
  readonly calls: string[];
  readonly set: Record<string, unknown>[];
  readonly removed: string[];
  readonly shown: { message: string; detail: string }[];
}

function fixture(options: { confirm?: boolean; storage?: 'persist' | 'session' } = {}) {
  const recorded: Recorded = { calls: [], set: [], removed: [], shown: [] };
  let imports = ['github.com'];
  const core: ImportCore = {
    chromeProfiles: () => {
      recorded.calls.push('profiles');
      return Promise.resolve(
        JSON.stringify({ chrome: true, profiles: [{ id: 'Default', name: '个人' }] }),
      );
    },
    chromeSites: () => Promise.resolve('{"sites":[]}'),
    chromeImport: (json: string) => {
      recorded.calls.push(`import ${json}`);
      return Promise.resolve(answer);
    },
    browserImports: () => {
      recorded.calls.push('imports');
      return Promise.resolve(JSON.stringify({ imports: imports.map((site) => ({ site })) }));
    },
    forgetBrowserImport: (_workspace: string, site: string) => {
      recorded.calls.push(`forget ${site}`);
      imports = imports.filter((s) => s !== site);
      return Promise.resolve('{"forgot":true}');
    },
  };
  const jar: CookieJar = {
    cookies: {
      set: (details) => {
        if (details.name === 'refused')
          return Promise.reject(new Error(`bad ${details.value ?? ''}`));
        recorded.set.push({ ...details });
        return Promise.resolve();
      },
      get: () =>
        Promise.resolve([
          { name: 'a', value: 'v', domain: '.github.com', path: '/', secure: true },
          { name: 'b', value: 'v', domain: 'github.com', path: '/x', secure: false },
          { name: 'c', value: 'v', domain: 'gist.github.com', path: '/', secure: true },
        ] as Electron.Cookie[]),
      remove: (url: string, name: string) => {
        recorded.removed.push(`${url} ${name}`);
        return Promise.resolve();
      },
      flushStore: () => Promise.resolve(),
    },
    clearStorageData: () => {
      recorded.calls.push('clearStorage');
      return Promise.resolve();
    },
    clearCache: () => Promise.resolve(),
    clearAuthCache: () => Promise.resolve(),
  };
  const deps: ChromeImportDeps = {
    core,
    storage: () => options.storage ?? 'persist',
    translator: () => new Translator('en'),
    confirm: {
      ask: (_window, text) => {
        recorded.shown.push(text);
        return Promise.resolve(options.confirm ?? true);
      },
    },
    platform: 'darwin',
    partition: () => jar,
  };
  return { imports: new ChromeImports(deps), recorded };
}

describe('Chrome import in the main process', () => {
  it('THR-17 the page gets counts only: confirms natively, imports through Core, writes the cookies', async () => {
    const { imports, recorded } = fixture();
    const outcome = await imports.import(null, '/w', 'Default', ['github.com']);
    expect(recorded.shown).toHaveLength(1);
    expect(recorded.shown[0]?.message).toBe('Import sign-ins for 1 site from Chrome?');
    expect(recorded.shown[0]?.detail).toContain('“个人”');
    expect(recorded.shown[0]?.detail).toContain('• github.com');
    expect(recorded.shown[0]?.detail).toContain('“Allow”, not “Always Allow”');
    expect(recorded.calls).toContain(
      `import ${JSON.stringify({ workspace: '/w', profile: 'Default', sites: ['github.com'] })}`,
    );
    expect(recorded.set).toEqual([
      {
        url: 'https://github.com/',
        name: '_gh_sess',
        value: VALUE,
        domain: '.github.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
        expirationDate: 1_900_000_000,
      },
    ]);
    expect(outcome).toEqual({
      status: 'imported',
      sites: [
        {
          site: 'github.com',
          imported: 1,
          skipped: [
            { reason: 'appBound', count: 3 },
            { reason: 'rejected', count: 1 },
          ],
        },
      ],
    });
    // What the page receives never holds a value, not even a refused cookie's error text.
    expect(JSON.stringify(outcome)).not.toContain(VALUE);
    expect(JSON.stringify(outcome)).not.toContain('bad x');
  });

  it('imports nothing when the user cancels or browsing data is cleared at quit', async () => {
    const cancelled = fixture({ confirm: false });
    expect(await cancelled.imports.import(null, '/w', 'Default', ['github.com'])).toEqual({
      status: 'cancelled',
    });
    expect(cancelled.recorded.calls.some((c) => c.startsWith('import'))).toBe(false);
    const session = fixture({ storage: 'session' });
    expect(await session.imports.import(null, '/w', 'Default', ['github.com'])).toEqual({
      status: 'unavailable',
    });
    expect(session.recorded.shown).toHaveLength(0);
  });

  it('removes a site: its cookies first, then the record', async () => {
    const { imports, recorded } = fixture();
    expect(await imports.covers('/w', 'api.github.com')).toBe(true);
    await imports.forget('/w', 'github.com');
    expect(recorded.removed).toEqual(['https://github.com/ a', 'http://github.com/x b']);
    expect(recorded.calls.at(-1)).toBe('forget github.com');
    // The cache was dropped: Core is asked again.
    expect(await imports.covers('/w', 'github.com')).toBe(false);
  });

  it('clearing a workspace forgets its imports', async () => {
    const { imports, recorded } = fixture();
    await imports.clearWorkspace('/w');
    expect(recorded.calls).toContain('clearStorage');
    expect(recorded.calls).toContain('forget github.com');
  });

  it('the keychain advice is for macOS only', () => {
    const t = new Translator('zh-CN');
    expect(confirmationText(t, 'Work', ['a.test'], 'win32').detail).not.toContain('钥匙串');
    expect(confirmationText(t, 'Work', ['a.test'], 'darwin').detail).toContain('始终允许');
  });
});

describe('imported hosts', () => {
  it.each([
    ['github.com', 'github.com', true],
    ['api.github.com', 'github.com', true],
    ['API.GitHub.com.', 'github.com', true],
    ['notgithub.com', 'github.com', false],
    ['github.com', 'gist.github.com', false],
    ['[::1]', '::1', true],
  ])('covered(%s, %s) is %s', (host, site, expected) => {
    expect(covered(host, site)).toBe(expected);
  });

  it('checks any of the sites', () => {
    expect(importedHost('a.example.test', ['github.com', 'example.test'])).toBe(true);
    expect(importedHost('example.org', ['github.com'])).toBe(false);
    expect(importedSites('{"imports":[{"site":"a.test"},{"site":"../x"},{}]}')).toEqual(['a.test']);
  });
});

describe('arguments', () => {
  const absolute = (p: string) => p.startsWith('/');

  it('accepts site lists of 1 to 50 site names', () => {
    expect(sitesArg(['github.com', 'github.com', '127.0.0.1'])).toEqual([
      'github.com',
      '127.0.0.1',
    ]);
    for (const bad of [[], ['.github.com'], ['a b'], 'github.com', [1], Array(51).fill('a.test')]) {
      expect(() => sitesArg(bad)).toThrow(TypeError);
    }
  });

  it('accepts absolute workspaces only', () => {
    expect(workspaceArg('/工作区 a', absolute)).toBe('/工作区 a');
    for (const bad of ['relative', '', '/a\nb', 3, null]) {
      expect(() => workspaceArg(bad, absolute)).toThrow(TypeError);
    }
  });

  it('refuses malformed Core answers', () => {
    expect(parseImport('{"cookies":[{"site":"a.test"}],"sites":[]}')).toBeUndefined();
    expect(parseImport('{"cookies":[]}')).toBeUndefined();
    expect(parseImport(answer)?.cookies).toHaveLength(2);
  });
});
