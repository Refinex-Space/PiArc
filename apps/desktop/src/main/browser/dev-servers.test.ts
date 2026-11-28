import { describe, expect, it } from 'vitest';

import type { DevServerState, ListeningPort } from '@piarc/protocol';

import { AgentBridge, parseClientEvent } from './agent-bridge.js';
import {
  DevServers,
  FAILURE_LOG_LINES,
  parseLaunchView,
  parseServerState,
  type DevServerEvents,
} from './dev-servers.js';

const port = (n: number, kind: ListeningPort['kind'] = 'command'): ListeningPort => ({
  port: n,
  taskId: `bg-${String(n).padStart(12, '0')}`,
  kind,
  title: 'npm run dev',
});

const server = (status: DevServerState['status'], taskId = 'bg-000000000001'): DevServerState => ({
  name: 'web',
  status,
  startedBy: 'user',
  port: 5173,
  url: 'http://localhost:5173/',
  taskId,
  ...(status === 'failed' ? { failure: 'exited' as const, exitCode: 1, log: ['boom'] } : {}),
});

function record() {
  const seen: string[] = [];
  const events: DevServerEvents = {
    changed: (id) => seen.push(`changed ${id}`),
    announce: (id, n) => seen.push(`announce ${id} ${String(n)}`),
    failed: (id, s) => seen.push(`failed ${id} ${s.name}`),
  };
  return { seen, servers: new DevServers(events) };
}

describe('DevServers', () => {
  it('allows listening and declared ports of the session only', () => {
    const { servers } = record();
    servers.ports('s1', '/w', [port(5173), port(9229, 'terminal')], [3000]);
    expect([...servers.allowedPorts('s1')].sort()).toEqual([3000, 5173, 9229]);
    expect(servers.allowedPorts('s2').size).toBe(0);
    servers.ports('s1', '/w', [], [3000]);
    expect([...servers.allowedPorts('s1')]).toEqual([3000]);
  });

  it('announces a port once per session, also after it went away and came back', () => {
    const { seen, servers } = record();
    servers.ports('s1', '/w', [port(5173)], []);
    servers.ports('s1', '/w', [port(5173), port(8080)], []);
    servers.ports('s1', '/w', [], []);
    servers.ports('s1', '/w', [port(5173)], []);
    servers.ports('s2', '/w', [port(5173)], []);
    expect(seen.filter((line) => line.startsWith('announce'))).toEqual([
      'announce s1 5173',
      'announce s1 8080',
      'announce s2 5173',
    ]);
  });

  it('reports a failure once per failed start', () => {
    const { seen, servers } = record();
    servers.servers('s1', '/w', [server('starting')]);
    servers.servers('s1', '/w', [server('failed')]);
    servers.servers('s1', '/w', [server('failed')]);
    servers.servers('s1', '/w', [server('starting', 'bg-000000000002')]);
    servers.servers('s1', '/w', [server('failed', 'bg-000000000002')]);
    expect(seen.filter((line) => line.startsWith('failed'))).toEqual([
      'failed s1 web',
      'failed s1 web',
    ]);
    expect(servers.services('s1').servers[0]?.status).toBe('failed');
  });
});

describe('parsing', () => {
  it('reads server states and keeps the last log lines', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${String(i)}`);
    const parsed = parseServerState({ ...server('failed'), log: lines });
    expect(parsed?.log).toHaveLength(FAILURE_LOG_LINES);
    expect(parsed?.log?.[0]).toBe('line 10');
    expect(parseServerState({ ...server('ready'), status: 'odd' })).toBeUndefined();
    expect(parseServerState({ ...server('ready'), port: 70_000 })).toBeUndefined();
    expect(parseServerState({ ...server('failed'), log: [1] })).toBeUndefined();
  });

  it('reads a launch view', () => {
    const view = {
      configs: [
        {
          name: 'web',
          source: 'piarc',
          command: 'npm run dev',
          cwd: '/w',
          port: 5173,
          url: 'http://localhost:5173/',
          fingerprint: 'ab',
          autoPort: true,
        },
      ],
      autoVerify: true,
      issues: [{ file: '.piarc/launch.json', line: 3, column: 5, message: 'bad' }],
      trusted: false,
    };
    expect(parseLaunchView(view)).toEqual({ ...view, servers: [] });
    expect(parseLaunchView({ ...view, trusted: 'yes' })).toBeUndefined();
    expect(parseLaunchView({ ...view, configs: [{ name: 'x' }] })).toBeUndefined();
  });

  it('reads ports and servers events of core/browser', () => {
    expect(
      parseClientEvent({
        type: 'ports',
        sessionId: 's1',
        workspace: '/w',
        ports: [port(5173)],
        declared: [3000],
      }),
    ).toEqual({
      type: 'ports',
      sessionId: 's1',
      workspace: '/w',
      ports: [port(5173)],
      declared: [3000],
    });
    expect(
      parseClientEvent({ type: 'ports', sessionId: 's1', workspace: '/w', ports: [{ port: 0 }] }),
    ).toBeUndefined();
    expect(
      parseClientEvent({
        type: 'servers',
        sessionId: 's1',
        workspace: '/w',
        servers: [server('ready')],
      }),
    ).toEqual({ type: 'servers', sessionId: 's1', workspace: '/w', servers: [server('ready')] });
    expect(parseClientEvent({ type: 'servers', sessionId: 's1' })).toBeUndefined();
  });

  it('hands the events to the services sink', () => {
    const { seen, servers } = record();
    const bridge = new AgentBridge(
      { attachBrowserClient: () => undefined, answerBrowserRun: () => true },
      { run: () => Promise.resolve(undefined), cancel: () => undefined },
      servers,
    );
    const payload = new TextEncoder().encode(
      JSON.stringify([
        { type: 'ports', sessionId: 's1', workspace: '/w', ports: [port(4000)], declared: [] },
        { type: 'servers', sessionId: 's1', workspace: '/w', servers: [server('failed')] },
        { type: 'bogus' },
      ]),
    );
    bridge.deliver({ route: 'core/browser', seq: 1, payload });
    expect(servers.allowedPorts('s1').has(4000)).toBe(true);
    expect(seen).toContain('announce s1 4000');
    expect(seen).toContain('failed s1 web');
  });
});
