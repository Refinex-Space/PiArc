// PiArc addition (ADR-0092): the `servers()` and `startServer(name)` helpers, the bindings
// adapter's checks of their answers, and their help entries.

import { afterEach, describe, expect, test } from 'vitest';

import type {
  BrowserHostApi,
  BrowserHostRequest,
  BrowserServersResult,
} from '../../shared/browser-host.js';
import { createEgoBindings } from '../bindings.js';
import { FakeBindings, installBindings } from '../testing.js';
import { helperContext, servers, startServer } from './helpers.js';
import { help } from './help-runtime.js';
import { resetSink } from './output-sink.js';
import { PUBLIC_API_SCHEMA } from './public-api-schema.js';

afterEach(() => {
  resetSink();
});

const LISTED: BrowserServersResult = {
  trusted: true,
  servers: [
    {
      name: 'web',
      status: 'idle',
      url: 'http://localhost:5173/',
      port: 5173,
      command: 'npm run dev',
      cwd: '/w',
      source: 'piarc',
    },
  ],
  listening: [
    { port: 9229, url: 'http://localhost:9229/', title: 'node --inspect', kind: 'terminal' },
  ],
  problems: ['.claude/launch.json:3:7 expected a string'],
};

async function withEgo(ego: FakeBindings, fn: () => Promise<void>): Promise<void> {
  const restore = installBindings(ego);
  try {
    await fn();
  } finally {
    restore();
  }
}

/** A host API answering each op from a table. */
function hostApi(answers: Partial<Record<BrowserHostRequest['op'], unknown>>) {
  const requests: BrowserHostRequest[] = [];
  const api: BrowserHostApi = {
    call: (request) => {
      requests.push(request);
      const answer = answers[request.op];
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer ?? null);
    },
    onCdp: () => undefined,
    onRun: () => undefined,
    finish: () => undefined,
  };
  return { api, requests };
}

describe('servers() and startServer()', () => {
  test('are helpers with help entries', () => {
    const context = helperContext();
    expect(typeof context.servers).toBe('function');
    expect(typeof context.startServer).toBe('function');
    const names = PUBLIC_API_SCHEMA.map((entry) => entry.name);
    expect(names).toContain('servers');
    expect(names).toContain('startServer');
    expect(JSON.stringify(help('startServer'))).toMatch(/asks the user/);
  });

  test('list the configurations and start one by name', async () => {
    const ego = new FakeBindings({
      servers: () => Promise.resolve(LISTED),
      startServer: (name) =>
        Promise.resolve({ name, status: 'ready', url: 'http://localhost:5173/', port: 5173 }),
    });
    await withEgo(ego, async () => {
      expect(await servers()).toEqual(LISTED);
      expect(await startServer('web')).toMatchObject({ status: 'ready', port: 5173 });
    });
    expect(ego.calls).toEqual([['servers'], ['startServer', 'web']]);
  });

  test('startServer checks the name before asking anyone', async () => {
    const ego = new FakeBindings({});
    await withEgo(ego, async () => {
      for (const name of [undefined, '', '  ', 3]) {
        await expect(startServer(name)).rejects.toThrow(/startServer expects the name/);
      }
    });
    expect(ego.calls).toEqual([]);
  });

  test('a refusal reaches the script as an error with its code', async () => {
    const ego = new FakeBindings({
      startServer: () =>
        Promise.resolve({ error: 'the user refused', error_code: 'PIARC_SERVER_REFUSED' }),
    });
    await withEgo(ego, async () => {
      await expect(startServer('web')).rejects.toMatchObject({
        error_code: 'PIARC_SERVER_REFUSED',
      });
    });
  });
});

describe('the bindings adapter', () => {
  test('maps the ops and checks their answers', async () => {
    const { api, requests } = hostApi({
      servers: LISTED,
      startServer: {
        name: 'web',
        status: 'failed',
        url: 'http://localhost:5173/',
        port: 5173,
        failure: 'exited',
        exitCode: 1,
        log: ['Error: listen EADDRINUSE'],
      },
    });
    const ego = createEgoBindings(api);
    expect(await ego.servers()).toEqual(LISTED);
    expect(await ego.startServer('web')).toEqual({
      name: 'web',
      status: 'failed',
      url: 'http://localhost:5173/',
      port: 5173,
      failure: 'exited',
      exitCode: 1,
      log: ['Error: listen EADDRINUSE'],
    });
    expect(requests).toEqual([{ op: 'servers' }, { op: 'startServer', name: 'web' }]);
  });

  test('refuses malformed answers', async () => {
    const ego = createEgoBindings(
      hostApi({
        servers: {
          trusted: true,
          servers: [{ name: 'web', status: 'odd' }],
          listening: [],
          problems: [],
        },
        startServer: { name: 'web' },
      }).api,
    );
    expect(await ego.servers()).toMatchObject({ error_code: 'EGO_INVALID_RESULT_PAYLOAD' });
    expect(await ego.startServer('web')).toMatchObject({
      error_code: 'EGO_INVALID_RESULT_PAYLOAD',
    });
  });
});
