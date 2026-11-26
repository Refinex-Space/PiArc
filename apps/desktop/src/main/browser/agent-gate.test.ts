import { describe, expect, it } from 'vitest';

import {
  AgentGate,
  hostKey,
  localName,
  privateHost,
  type GateDeps,
  type GatedPage,
  type GateRun,
} from './agent-gate.js';

const AGENT: GatedPage = { sessionId: 's', space: 'agent-1', agentControlled: true };

function fixture(answers: Record<string, unknown> = {}, ports: readonly number[] = []) {
  const asked: Record<string, unknown>[] = [];
  const run: GateRun = {
    callSessionId: 's',
    toolCallId: 'call-1',
    allowedHosts: new Set(),
    blockedHosts: new Set(),
  };
  const pages = new Map<number, GatedPage>([
    [1, AGENT],
    [2, { sessionId: 's', space: 'user', agentControlled: false }],
  ]);
  let current: GateRun | undefined = run;
  const deps: GateDeps = {
    pageOf: (id) => pages.get(id),
    agentPagesOn: (host) => (host === 'app.example.com' ? [AGENT] : []),
    runFor: () => current,
    allowedPorts: () => new Set([5173, ...ports]),
    askCore: (json) => {
      const request = JSON.parse(json) as Record<string, unknown>;
      asked.push(request);
      const answer = answers[String(request.host)] ?? { allowed: false };
      return Promise.resolve(JSON.stringify(answer));
    },
    localNames: () => ['*.test', '*.local'],
  };
  return {
    gate: new AgentGate(deps),
    run,
    asked,
    endRun: () => {
      current = undefined;
    },
  };
}

const request = (url: string, resourceType = 'mainFrame', webContentsId = 1) => ({
  url,
  resourceType,
  webContentsId,
  referrer: '',
});

describe('host helpers', () => {
  it('keys local addresses with their port and sites by host', () => {
    const names = ['*.test'];
    expect(hostKey(new URL('http://localhost:5173/a'), names)).toEqual({
      key: 'localhost:5173',
      local: true,
    });
    expect(hostKey(new URL('https://shop.test/'), names)).toEqual({
      key: 'shop.test:443',
      local: true,
    });
    expect(hostKey(new URL('https://Example.com/x'), names)).toEqual({
      key: 'example.com',
      local: false,
    });
    expect(localName('api.dev.local', ['*.local'])).toBe(true);
    expect(localName('local.example.com', ['*.local'])).toBe(false);
  });

  it.each([
    ['10.0.0.8', true],
    ['172.20.1.1', true],
    ['172.32.1.1', false],
    ['192.168.1.20', true],
    ['100.64.0.1', true],
    ['8.8.8.8', false],
    ['[fd12::1]', true],
    ['example.com', false],
  ])('privateHost(%s) is %s', (host, expected) => {
    expect(privateHost(host)).toBe(expected);
  });
});

describe('AgentGate (B2.6)', () => {
  it('leaves the user pages and other schemes alone', () => {
    const { gate } = fixture();
    expect(gate.check(request('https://anything.example/', 'mainFrame', 2))).toEqual({
      allow: true,
    });
    expect(gate.check(request('data:text/plain,x', 'image'))).toEqual({ allow: true });
  });

  it('lets local ports the user opened through without a card', () => {
    const { gate, asked } = fixture();
    expect(gate.check(request('http://localhost:5173/src/main.ts', 'script'))).toEqual({
      allow: true,
    });
    expect(asked).toEqual([]);
  });

  it('refuses unallowed subresources and records them for the result', () => {
    const { gate, run, asked } = fixture();
    expect(gate.check(request('https://cdn.example.net/app.js', 'script'))).toEqual({
      allow: false,
      reason: 'invalid',
    });
    expect(gate.check(request('http://127.0.0.1:9229/json', 'xhr'))).toMatchObject({
      allow: false,
    });
    expect([...run.blockedHosts]).toEqual(['cdn.example.net', '127.0.0.1:9229']);
    expect(asked).toEqual([]);
  });

  it('asks Core for a document and keeps a session answer for every waiting host', async () => {
    const { gate, run, asked } = fixture({ 'example.com': { allowed: true, scope: 'session' } });
    void gate.check(request('https://cdn.example.net/a.css', 'stylesheet'));
    const verdict = await gate.check(request('https://example.com/shop', 'mainFrame'));
    expect(verdict).toEqual({ allow: true });
    expect(asked).toEqual([
      {
        sessionId: 's',
        toolCallId: 'call-1',
        url: 'https://example.com/shop',
        host: 'example.com',
        pending: ['cdn.example.net'],
      },
    ]);
    expect(run.blockedHosts.size).toBe(0);
    // Allowed for the session: no further question, also for the subresource host.
    expect(gate.check(request('https://cdn.example.net/b.css', 'stylesheet'))).toEqual({
      allow: true,
    });
    expect(gate.check(request('https://example.com/next', 'mainFrame'))).toEqual({ allow: true });
    expect(asked).toHaveLength(1);
  });

  it('keeps a run answer to the run, marks private hosts sensitive and asks once at a time', async () => {
    const { gate, run, asked } = fixture({ '192.168.1.20': { allowed: true, scope: 'run' } });
    const [a, b] = [
      gate.check(request('http://192.168.1.20/', 'mainFrame')),
      gate.check(request('http://192.168.1.20/other', 'subFrame')),
    ];
    expect(await a).toEqual({ allow: true });
    expect(await b).toEqual({ allow: true });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ sensitive: true });
    expect([...run.allowedHosts]).toEqual(['192.168.1.20']);
  });

  it('refuses a document when Core refuses, and without a run asks nothing', async () => {
    const { gate, run, asked, endRun } = fixture();
    expect(await gate.check(request('https://evil.example/', 'mainFrame'))).toMatchObject({
      allow: false,
    });
    expect(run.blockedHosts.has('evil.example')).toBe(true);
    endRun();
    expect(gate.check(request('https://other.example/', 'mainFrame'))).toMatchObject({
      allow: false,
    });
    expect(asked).toHaveLength(1);
  });

  it('judges a request without a page by the agent page showing its site', () => {
    const { gate } = fixture();
    const sw = {
      url: 'https://tracker.example/beacon',
      resourceType: 'ping',
      referrer: 'https://app.example.com/sw.js',
    };
    expect(gate.check(sw)).toMatchObject({ allow: false });
    expect(gate.check({ ...sw, referrer: 'https://unrelated.example/' })).toEqual({ allow: true });
  });

  it('requestAccess asks one card for the listed hosts', async () => {
    const { gate, run, asked } = fixture({ 'cdn.example.net': { allowed: true, scope: 'run' } });
    expect(await gate.requestAccess('s', run, ['cdn.example.net', 'fonts.example.org'])).toBe(true);
    expect(asked[0]).toMatchObject({ host: 'cdn.example.net', pending: ['fonts.example.org'] });
    expect([...run.allowedHosts].sort()).toEqual(['cdn.example.net', 'fonts.example.org']);
  });

  it('lets the session’s listening and declared ports through and asks for others (B2.6.2)', async () => {
    // 4100 listens in a background task's tree, 3000 is declared by a launch configuration.
    const { gate, asked } = fixture({}, [4100, 3000]);
    expect(gate.check(request('http://127.0.0.1:4100/'))).toEqual({ allow: true });
    expect(gate.check(request('http://localhost:3000/app.js', 'script'))).toEqual({ allow: true });
    expect(gate.check(request('ws://[::1]:4100/hmr', 'webSocket'))).toEqual({ allow: true });
    expect(asked).toEqual([]);
    // A port nobody in the session owns: the document asks, a subresource is refused.
    expect(await gate.check(request('http://localhost:9229/'))).toMatchObject({ allow: false });
    expect(asked[0]).toMatchObject({ host: 'localhost:9229', local: true });
    expect(gate.check(request('http://localhost:9230/x.js', 'script'))).toMatchObject({
      allow: false,
    });
  });
});
