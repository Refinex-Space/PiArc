import type { MarketEntry } from '@piarc/protocol';
import { describe, expect, it } from 'vitest';

import { routeOf } from '../SkillsPage.js';
import { actionOf, parseDetail, parseEvents, parsePage } from './market-data.js';

const entry = (over: Partial<MarketEntry> = {}): MarketEntry => ({
  name: 'pi-tools',
  version: '1.2.0',
  description: '',
  publisher: '',
  downloadsMonthly: 0,
  updated: 0,
  kinds: [],
  kindsFromManifest: false,
  insecure: false,
  deprecated: false,
  installing: false,
  ...over,
});

describe('market answers', () => {
  it('keeps well-formed entries and drops the rest', () => {
    const page = parsePage(
      JSON.stringify({
        entries: [
          {
            name: '@scope/a',
            version: '1.0.0',
            kinds: ['skill', 'bogus', 'theme'],
            downloadsMonthly: 'many',
            installed: { id: '@scope/a', enabled: true, scope: 'elsewhere', update: '1.1.0' },
          },
          { name: 'no-version' },
          7,
        ],
        total: 2,
        counts: { all: 2, extension: 1, skill: 'x' },
        status: { state: 'weird', problem: { code: 'proxy', message: 'refused' }, syncedAt: 5 },
        live: 'yes',
      }),
    );
    expect(page.entries).toHaveLength(1);
    const first = page.entries[0];
    expect(first?.kinds).toEqual(['skill', 'theme']);
    expect(first?.downloadsMonthly).toBe(0);
    expect(first?.installed).toEqual({ id: '@scope/a', enabled: true, update: '1.1.0' });
    expect(page.counts).toEqual({ all: 2, extension: 1, skill: 0, prompt: 0 });
    expect(page.status).toMatchObject({ state: 'idle', syncedAt: 5, problem: { code: 'proxy' } });
    expect(page.live).toBe(false);
    expect(() => parsePage('{"entries":3}')).toThrow();
  });

  it('reads a package’s details and refuses a shape without an entry', () => {
    const detail = parseDetail(
      JSON.stringify({
        entry: { name: 'pi-tools', version: '1.2.0' },
        keywords: ['pi-package', 3],
        license: 'MIT',
        npmUrl: 'https://www.npmjs.com/package/pi-tools',
        repositoryUrl: 42,
        foreignDependencies: ['evil'],
        readmeTooLarge: true,
      }),
    );
    expect(detail.keywords).toEqual(['pi-package']);
    expect(detail.license).toBe('MIT');
    expect(detail.repositoryUrl).toBeUndefined();
    expect(detail.foreignDependencies).toEqual(['evil']);
    expect(detail.readmeTooLarge).toBe(true);
    expect(() => parseDetail('{"entry":{}}')).toThrow();
  });

  it('turns `core/market` batches into what the page re-reads', () => {
    const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    expect(parseEvents(bytes([{ type: 'kinds', names: ['a'] }]))).toEqual({
      refresh: true,
      installs: [],
    });
    const changes = parseEvents(
      bytes([
        { type: 'sync', status: { state: 'syncing', done: 2, total: 21 } },
        { type: 'install', name: 'a', state: 'failed', problem: { code: 'x', message: 'm' } },
        { type: 'unknown' },
      ]),
    );
    expect(changes.status).toMatchObject({ state: 'syncing', done: 2, total: 21 });
    expect(changes.installs).toEqual([
      { name: 'a', state: 'failed', problem: { code: 'x', message: 'm' } },
    ]);
    expect(parseEvents(new TextEncoder().encode('not json'))).toEqual({
      refresh: false,
      installs: [],
    });
  });
});

describe('the entry’s button', () => {
  const installed = (over: Partial<NonNullable<MarketEntry['installed']>>) =>
    entry({ installed: { id: 'pi-tools', enabled: false, ...over } });

  it('follows install, update, turn on, add here and on', () => {
    expect(actionOf(entry(), '/w')).toEqual({ kind: 'install' });
    expect(
      actionOf(entry({ installing: true, installed: { id: 'x', enabled: true } }), '/w'),
    ).toEqual({ kind: 'installing' });
    expect(actionOf(installed({ update: '1.3.0', scope: 'user', enabled: true }), '/w')).toEqual({
      kind: 'update',
      version: '1.3.0',
      id: 'pi-tools',
    });
    expect(actionOf(installed({ scope: 'user' }), '/w')).toEqual({
      kind: 'enable',
      id: 'pi-tools',
      scope: 'user',
    });
    expect(actionOf(installed({ scope: 'project' }), '/w')).toEqual({
      kind: 'enable',
      id: 'pi-tools',
      scope: 'project',
    });
    // Installed but declared neither for the user nor for this project.
    expect(actionOf(installed({}), '/w')).toEqual({ kind: 'addHere', id: 'pi-tools' });
    expect(actionOf(installed({}), null)).toEqual({
      kind: 'enable',
      id: 'pi-tools',
      scope: 'user',
    });
    expect(actionOf(installed({ scope: 'user', enabled: true }), '/w')).toEqual({
      kind: 'enabled',
    });
  });
});

describe('the page address', () => {
  it('reads the view and the package', () => {
    expect(routeOf('#/settings/skills')).toEqual({ view: 'installed' });
    expect(routeOf('#/settings/skills?view=market')).toEqual({ view: 'market' });
    expect(routeOf('#/settings/skills?view=market&package=%40scope%2Fpi-tools')).toEqual({
      view: 'market',
      pkg: '@scope/pi-tools',
    });
    expect(routeOf('#/settings/skills?view=other&package=x')).toEqual({ view: 'installed' });
  });
});
