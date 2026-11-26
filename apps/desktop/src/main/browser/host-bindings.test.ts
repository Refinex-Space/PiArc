// The script host's `servers` and `startServer` bindings (ADR-0092): dispatched to the ports
// with the run's session, names checked like any untrusted input, results mapped for the SDK.
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

const { HostBindings } = await import('./host-bindings.js');
const { serverInfo, serversResult } = await import('./start-page.js');

type Bindings = InstanceType<typeof HostBindings>;
type Ports = ConstructorParameters<typeof HostBindings>[1];
type Run = Parameters<Bindings['call']>[0];

const run = {
  runId: 'run-1',
  caller: { sessionId: 'main', touched: new Set<string>() },
  callSessionId: 'child',
  toolCallId: 'call-1',
} as unknown as Run;

function fixture() {
  const started: { sessionId: string; call: string; name: string }[] = [];
  const ports = {
    servers: (r: Run) =>
      Promise.resolve({
        trusted: true,
        servers: [],
        listening: [],
        problems: [r.caller.sessionId],
      }),
    startServer: (r: Run, name: string) => {
      started.push({ sessionId: r.caller.sessionId, call: r.toolCallId, name });
      return Promise.resolve(serverInfo(undefined, undefined, name));
    },
  } as unknown as Ports;
  const spaces = {} as unknown as ConstructorParameters<typeof HostBindings>[0];
  return { bindings: new HostBindings(spaces, ports), started };
}

describe('servers and startServer bindings', () => {
  it('answer for the run’s main session and call', async () => {
    const { bindings, started } = fixture();
    expect(await bindings.call(run, { op: 'servers' })).toMatchObject({ problems: ['main'] });
    expect(await bindings.call(run, { op: 'startServer', name: 'web' })).toMatchObject({
      name: 'web',
      status: 'idle',
    });
    expect(started).toEqual([{ sessionId: 'main', call: 'call-1', name: 'web' }]);
  });

  it('refuse a missing or overlong name', async () => {
    const { bindings, started } = fixture();
    for (const name of [undefined, 7, 'x'.repeat(201)]) {
      expect(await bindings.call(run, { op: 'startServer', name })).toMatchObject({
        error_code: 'EGO_INVALID_ARGUMENT',
      });
    }
    expect(started).toEqual([]);
  });
});

describe('serversResult', () => {
  it('lists every configuration with the session’s state and the listening ports', () => {
    const result = serversResult(
      {
        configs: [
          {
            name: 'web',
            source: 'piarc',
            command: 'npm run dev',
            cwd: '/w',
            port: 5173,
            url: 'http://localhost:5173/',
            fingerprint: 'f',
          },
          {
            name: 'api',
            source: 'claude',
            command: 'node api.js',
            cwd: '/w/api',
            port: 4000,
            url: 'http://localhost:4000/',
            fingerprint: 'g',
          },
        ],
        autoVerify: true,
        trusted: true,
        issues: [{ file: '.piarc/launch.json', line: 2, column: 4, message: 'unknown key' }],
      },
      {
        ports: [{ port: 5174, taskId: 'bg-000000000001', kind: 'devServer', title: 'web' }],
        declared: [5173, 4000],
        servers: [
          {
            name: 'web',
            status: 'ready',
            startedBy: 'agent',
            port: 5174,
            url: 'http://localhost:5174/',
            taskId: 'bg-000000000001',
          },
        ],
      },
    );
    expect(result.servers).toEqual([
      {
        name: 'web',
        status: 'ready',
        url: 'http://localhost:5174/',
        port: 5174,
        command: 'npm run dev',
        cwd: '/w',
        source: 'piarc',
        startedBy: 'agent',
      },
      {
        name: 'api',
        status: 'idle',
        url: 'http://localhost:4000/',
        port: 4000,
        command: 'node api.js',
        cwd: '/w/api',
        source: 'claude',
      },
    ]);
    expect(result.listening).toEqual([
      { port: 5174, url: 'http://localhost:5174/', title: 'web', kind: 'devServer' },
    ]);
    expect(result.problems).toEqual(['.piarc/launch.json:2:4 unknown key']);
  });
});
