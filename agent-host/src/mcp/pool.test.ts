// T36: the workspace pool against the independent stdio fixture server
// (`packages/testkit/src/mcp-echo-server.ts`): one process for two sessions (A02), idle
// disconnect on an injected clock and reconnect (A03), the process group the server runs in and
// the escalation for a server that ignores its shutdown (A11's Agent Host side), list_changed,
// retries and servers that may not run.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { McpServerDefinition, McpServersResult, McpStatus } from '@piarc/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { CoreBridge } from '../runtime/core-bridge.js';
import { McpPool, type PoolClock } from './pool.js';

const ECHO = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/testkit/src/mcp-echo-server.ts',
);
const WORKSPACE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

class ManualClock implements PoolClock {
  #now = 0;
  #timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  now(): number {
    return this.#now;
  }
  after(ms: number, run: () => void): () => void {
    const timer = { at: this.#now + ms, run, cancelled: false };
    this.#timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }
  advance(ms: number): void {
    this.#now += ms;
    const due = this.#timers.filter((t) => !t.cancelled && t.at <= this.#now);
    this.#timers = this.#timers.filter((t) => !due.includes(t));
    for (const timer of due) timer.run();
  }
}

function server(
  name: string,
  env: Record<string, string> = {},
  command = process.execPath,
): McpServerDefinition {
  return {
    name,
    scope: 'project',
    source: '/ws/.mcp.json',
    transport: 'stdio',
    availability: 'ready',
    stdio: { command, args: [ECHO, name], env },
  };
}

function fakeCore(config: () => McpServersResult): CoreBridge {
  const bridge: CoreBridge = new CoreBridge((message) => {
    const { id, method } = message as { id: number; method: string };
    queueMicrotask(() => {
      if (method === 'mcp/servers') {
        bridge.handleResponse({ jsonrpc: '2.0', id, result: config() });
      } else {
        bridge.handleResponse({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: 'not here',
            data: { kind: 'methodNotFound', retryable: false },
          },
        });
      }
    });
  });
  return bridge;
}

function config(servers: McpServerDefinition[], idleTimeoutMs = 60_000): McpServersResult {
  return { servers, env: { PATH: process.env.PATH ?? '' }, idleTimeoutMs, deferThreshold: 30 };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function textOf(result: { content: unknown[] }): string {
  return result.content.map((block) => (block as { text?: string }).text ?? '').join('');
}

const pools: McpPool[] = [];

function makePool(
  servers: () => McpServersResult,
  clock = new ManualClock(),
): {
  pool: McpPool;
  clock: ManualClock;
  statuses: McpStatus[];
} {
  const statuses: McpStatus[] = [];
  const pool = new McpPool({
    workspace: WORKSPACE,
    bridge: fakeCore(servers),
    log: () => undefined,
    notify: (status) => statuses.push(status),
    clock,
  });
  pools.push(pool);
  return { pool, clock, statuses };
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});

describe('the workspace MCP pool', () => {
  it('runs one process for two sessions and routes each call to its caller (A02)', async () => {
    const { pool } = makePool(() => config([server('shared')]));
    await pool.refresh();
    pool.attach('session-a', WORKSPACE);
    pool.attach('session-b', WORKSPACE);
    const [a, b] = await Promise.all([
      pool.call('session-a', 'shared', 'echo', { text: 'from A' }, {}),
      pool.call('session-b', 'shared', 'echo', { text: 'from B' }, {}),
    ]);
    const status = pool.statusOf('shared');
    expect(status.state).toBe('connected');
    expect(status.sessions).toBe(2);
    const pid = status.pid ?? -1;
    expect(textOf(a)).toBe(`shared echoes "from A" from ${WORKSPACE} (pid ${String(pid)})`);
    expect(textOf(b)).toBe(`shared echoes "from B" from ${WORKSPACE} (pid ${String(pid)})`);
    if (process.platform !== 'win32') {
      // Not detached: the server is in this process's group, which Core ends with the Agent Host.
      const who = JSON.parse(textOf(await pool.call('session-a', 'shared', 'whoami', {}, {}))) as {
        pgid: string;
      };
      const ours = execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)])
        .toString()
        .trim();
      expect(who.pgid).toBe(ours);
    }
  });

  it('disconnects a server nobody used for the idle time and reconnects on the next call (A03)', async () => {
    const { pool, clock } = makePool(() => config([server('idle')], 1_000));
    await pool.refresh();
    pool.attach('session-a', WORKSPACE);
    await pool.call('session-a', 'idle', 'echo', { text: 'one' }, {});
    const first = pool.statusOf('idle').pid ?? -1;
    expect(alive(first)).toBe(true);
    clock.advance(999);
    expect(pool.statusOf('idle').state).toBe('connected');
    clock.advance(1);
    await until(() => pool.statusOf('idle').state === 'idle', 'the idle disconnect');
    await until(() => !alive(first), 'the server process to exit');
    // The tools stay known while disconnected.
    expect(pool.statusOf('idle').tools).toBe(3);
    const again = await pool.call('session-a', 'idle', 'echo', { text: 'two' }, {});
    const second = pool.statusOf('idle').pid ?? -1;
    expect(second).not.toBe(first);
    expect(textOf(again)).toContain(`(pid ${String(second)})`);
  });

  it('a session reopened under the same id keeps the server process (I111)', async () => {
    // Rewind and branch switches close and reopen the Pi session: the lease goes back and is
    // taken again before the idle time, so the connection stays.
    const { pool, clock } = makePool(() => config([server('kept')], 1_000));
    await pool.refresh();
    pool.attach('session-a', WORKSPACE);
    await pool.call('session-a', 'kept', 'echo', { text: 'before' }, {});
    const pid = pool.statusOf('kept').pid ?? -1;
    await pool.detach('session-a');
    clock.advance(500);
    pool.attach('session-a', WORKSPACE);
    clock.advance(999);
    const after = await pool.call('session-a', 'kept', 'echo', { text: 'after' }, {});
    expect(pool.statusOf('kept').pid).toBe(pid);
    expect(textOf(after)).toContain(`(pid ${String(pid)})`);
    expect(alive(pid)).toBe(true);
  });

  it('a call in flight keeps the server connected past the idle time', async () => {
    const { pool, clock } = makePool(() => config([server('busy')], 1_000));
    await pool.refresh();
    pool.attach('session-a', WORKSPACE);
    await pool.connected('busy');
    const pending = pool.call('session-a', 'busy', 'echo', { text: 'slow' }, {});
    clock.advance(5_000);
    await pending;
    expect(pool.statusOf('busy').state).toBe('connected');
  });

  it('kills a server that ignores the end of stdin and SIGTERM when it closes', async () => {
    const { pool } = makePool(() => config([server('stubborn', { MCP_ECHO_STUBBORN: '1' })]));
    await pool.refresh();
    pool.attach('session-a', WORKSPACE);
    await pool.connected('stubborn');
    const pid = pool.statusOf('stubborn').pid ?? -1;
    expect(alive(pid)).toBe(true);
    await pool.close();
    await until(() => !alive(pid), 'the stubborn server to be killed');
  });

  it('lists the tools again after list_changed and tells the sessions', async () => {
    const { pool } = makePool(() => config([server('growing')]));
    const changes: string[] = [];
    pool.onChange((change) => {
      if (change.tools) changes.push(change.server);
    });
    await pool.refresh();
    pool.attach('session-a', WORKSPACE);
    await pool.connected('growing');
    changes.length = 0;
    await pool.call('session-a', 'growing', 'add_tool', { name: 'later' }, {});
    await until(() => pool.statusOf('growing').tools === 4, 'the new tool');
    expect(changes).toContain('growing');
    expect(pool.server('growing')?.tools.map((t) => t.name)).toContain('later');
  });

  it('retries a failed server with backoff while a session needs it', async () => {
    const missing = server('missing', {}, path.join(WORKSPACE, 'no-such-program'));
    const { pool, clock } = makePool(() => config([missing]));
    await pool.refresh();
    pool.attach('session-a', WORKSPACE);
    await until(() => pool.statusOf('missing').state === 'failed', 'the first failure');
    expect(pool.statusOf('missing').error).toMatch(/ENOENT|not found|no-such-program/);
    clock.advance(1_000);
    await until(() => pool.statusOf('missing').state === 'failed', 'the retry');
    await expect(pool.call('session-a', 'missing', 'echo', {}, {})).rejects.toThrow(
      /failed to connect/,
    );
  });

  it('lists servers that may not run without starting them', async () => {
    const { pool } = makePool(() =>
      config([
        { ...server('off'), availability: 'disabled', reason: 'turned off for this workspace' },
        {
          name: 'old',
          scope: 'user',
          source: 's',
          transport: 'sse',
          availability: 'unsupported',
          reason: 'SSE',
        },
        {
          name: 'repo',
          scope: 'project',
          source: 's',
          transport: 'stdio',
          availability: 'untrusted',
        },
      ]),
    );
    await pool.refresh();
    pool.attach('session-a', WORKSPACE);
    expect(pool.servers()).toHaveLength(0);
    const states = pool.status().servers.map((s) => [s.name, s.state, s.error ?? null]);
    expect(states).toEqual([
      ['off', 'disabled', 'turned off for this workspace'],
      ['old', 'unsupported', 'SSE'],
      ['repo', 'untrusted', null],
    ]);
  });

  it('applies a new configuration: removed servers close, changed ones restart', async () => {
    let servers = [server('keep'), server('drop')];
    const { pool } = makePool(() => config(servers));
    await pool.refresh();
    pool.attach('session-a', WORKSPACE);
    await Promise.all([pool.connected('keep'), pool.connected('drop')]);
    const dropped = pool.statusOf('drop').pid ?? -1;
    const kept = pool.statusOf('keep').pid ?? -1;
    servers = [server('keep')];
    await pool.refresh();
    await until(() => !alive(dropped), 'the removed server to exit');
    expect(pool.statusOf('keep').pid).toBe(kept);
    servers = [server('keep', { CHANGED: '1' })];
    await pool.refresh();
    await until(() => !alive(kept), 'the changed server to restart');
    expect(() => pool.statusOf('drop')).toThrow(/no MCP server/);
  });

  it('gives inline servers to their subagent only and closes them when it ends', async () => {
    const { pool } = makePool(() => config([server('shared')]));
    await pool.refresh();
    pool.attach('child', WORKSPACE);
    pool.addTemporary('child', [{ ...server('scratch'), scope: 'subagent' }]);
    const result = await pool.call('child', 'scratch', 'echo', { text: 'x' }, {});
    expect(textOf(result)).toContain('scratch echoes');
    const pid = pool.server('scratch', 'child')?.pid ?? -1;
    expect(pool.status().servers.map((s) => s.name)).toEqual(['shared']);
    await pool.detach('child');
    await until(() => !alive(pid), 'the inline server to exit');
    await expect(pool.call('other', 'scratch', 'echo', {}, {})).rejects.toThrow(/not configured/);
  });
});

it('routes a nested form and URL request from a real stdio server back to their owning calls', async () => {
  const data = config([server('alpha', { MCP_ECHO_ELICIT: '1' })]);
  const seen: unknown[] = [];
  const bridge = new CoreBridge((message) => {
    const p = message as { id: number; method: string; params: { request?: { mode: string } } };
    const result =
      p.method === 'mcp/servers'
        ? data
        : p.params.request?.mode === 'form'
          ? { action: 'accept', content: { release: 'Local' } }
          : { action: 'decline' };
    if (p.method === 'mcp/elicit') seen.push(p.params);
    queueMicrotask(() => bridge.handleResponse({ jsonrpc: '2.0', id: p.id, result }));
  });
  const pool = new McpPool({
    workspace: WORKSPACE,
    bridge,
    log: () => undefined,
    notify: () => undefined,
  });
  pools.push(pool);
  await pool.refresh();
  pool.attach('one', WORKSPACE);
  pool.attach('two', WORKSPACE);
  const first = await pool.call('one', 'alpha', 'elicit', { mode: 'form' }, { toolCallId: 'c1' });
  const second = await pool.call('two', 'alpha', 'elicit', { mode: 'url' }, { toolCallId: 'c2' });
  expect(textOf(first)).toContain('"release":"Local"');
  expect(textOf(second)).toContain('"action":"decline"');
  expect(seen).toMatchObject([
    {
      sessionId: 'one',
      toolCallId: 'c1',
      server: 'alpha',
      serverTool: 'elicit',
      request: { mode: 'form' },
    },
    {
      sessionId: 'two',
      toolCallId: 'c2',
      server: 'alpha',
      serverTool: 'elicit',
      request: { mode: 'url' },
    },
  ]);
});
