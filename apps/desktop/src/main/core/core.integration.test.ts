// The short correctness run of the S2 event channel that `npm run verify` includes (T04):
// the real Core module (development build, `npm run build:core`) delivers batches to the
// main process's router, which posts them on Node MessagePorts standing in for windows.
// The Electron form of the same checks runs in L4 (e2e/core-events.e2e.ts); performance is
// measured by scripts/bench/s2-event-channel.mjs and never asserted here.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MessageChannel, type MessagePort } from 'node:worker_threads';

import { afterEach, describe, expect, it } from 'vitest';

import type { EventBatch, EventPortMessage } from '../../shared/ipc.js';
import { hasTestingExports, loadCoreModule, type TestingCore } from './load.js';
import type { CoreRuntime } from './native/piarc-core.js';
import { resolveCoreModulePath } from './native-path.js';
import { EventRouter } from './router.js';

const desktopDir = path.join(import.meta.dirname, '..', '..', '..');
const modulePath = resolveCoreModulePath({
  isPackaged: false,
  appPath: desktopDir,
  platform: process.platform,
  arch: process.arch,
});

function loadTestingCore(onEvents: (batches: EventBatch[]) => void): TestingCore {
  if (!existsSync(modulePath)) {
    throw new Error(`${modulePath} is missing. Run \`npm run build:core\` first.`);
  }
  const runtime: CoreRuntime = loadCoreModule(modulePath).CoreRuntime.create({}, onEvents);
  if (!hasTestingExports(runtime)) {
    throw new Error(`${modulePath} is not a development build of Core`);
  }
  return runtime;
}

const running: { core: TestingCore; ports: MessagePort[] }[] = [];

afterEach(async () => {
  for (const { core, ports } of running.splice(0)) {
    await core.shutdown();
    for (const port of ports) {
      port.close();
    }
  }
});

/** What one stand-in window received. */
class Receiver {
  readonly batchSeqs = new Map<string, number[]>();
  readonly events = new Map<string, unknown[]>();
  readonly bytes = new Map<string, number[]>();
  #waiters: (() => void)[] = [];

  constructor(port: MessagePort) {
    port.on('message', (message: EventPortMessage) => {
      for (const batch of message.batches) {
        const events: unknown = JSON.parse(Buffer.from(batch.payload).toString('utf8'));
        if (!Array.isArray(events)) {
          throw new Error(`payload of ${batch.route} is not an array`);
        }
        this.#list(this.batchSeqs, batch.route).push(batch.seq);
        this.#list(this.bytes, batch.route).push(batch.payload.byteLength);
        this.#list(this.events, batch.route).push(...(events as unknown[]));
      }
      for (const wake of this.#waiters.splice(0)) {
        wake();
      }
    });
  }

  count(route: string): number {
    return this.events.get(route)?.length ?? 0;
  }

  async waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for events');
      }
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  }

  /** The demo events of `route` are numbered 1..=count and its batches 1..=n. */
  expectContiguous(route: string, count: number): void {
    const seqs = (this.events.get(route) ?? []).map((event) =>
      typeof event === 'object' && event !== null && 'seq' in event ? event.seq : undefined,
    );
    expect(seqs).toEqual(Array.from({ length: count }, (_, i) => i + 1));
    const batches = this.batchSeqs.get(route) ?? [];
    expect(batches).toEqual(Array.from({ length: batches.length }, (_, i) => i + 1));
  }

  #list<T>(map: Map<string, T[]>, route: string): T[] {
    let list = map.get(route);
    if (list === undefined) {
      list = [];
      map.set(route, list);
    }
    return list;
  }
}

/** Starts Core with a router and one stand-in window per entry of `routes`. */
function startChannel(routes: readonly (readonly string[])[]) {
  const router = new EventRouter();
  const deliveries: number[] = [];
  const core = loadTestingCore((batches) => {
    deliveries.push(performance.now());
    router.forward(batches);
  });
  const ports: MessagePort[] = [];
  const receivers = routes.map((subscribed, index) => {
    const { port1, port2 } = new MessageChannel();
    ports.push(port1, port2);
    router.connect(index + 1, port1);
    for (const route of subscribed) {
      router.subscribe(index + 1, route);
    }
    return new Receiver(port2);
  });
  running.push({ core, ports });
  return { core, router, receivers, deliveries };
}

describe('Core event channel (Node host)', () => {
  it('delivers every event of two streams to the subscribed window, in order', async () => {
    const { core, receivers, deliveries } = startChannel([['stream-a'], ['stream-b']]);
    const perStream = 20_000;
    const a = core.startDemoSource({
      route: 'stream-a',
      eventsPerSecond: 8_000,
      maxEvents: perStream,
      padBytes: 64,
    });
    const b = core.startDemoSource({
      route: 'stream-b',
      eventsPerSecond: 8_000,
      maxEvents: perStream,
      padBytes: 64,
    });
    const [first, second] = receivers;
    if (first === undefined || second === undefined) {
      throw new Error('two receivers expected');
    }
    await first.waitFor(() => first.count('stream-a') === perStream);
    await second.waitFor(() => second.count('stream-b') === perStream);
    expect([await core.stopDemoSource(a), await core.stopDemoSource(b)]).toEqual([
      { id: a, emitted: perStream },
      { id: b, emitted: perStream },
    ]);
    first.expectContiguous('stream-a', perStream);
    second.expectContiguous('stream-b', perStream);
    expect([...first.events.keys()]).toEqual(['stream-a']);
    expect([...second.events.keys()]).toEqual(['stream-b']);
    const stats = core.eventStats();
    expect(stats).toMatchObject({ queued: 2 * perStream, delivered: 2 * perStream, lost: 0 });

    // T04-A02: about one callback per 16 ms at most, several events per batch.
    const seconds = ((deliveries.at(-1) ?? 0) - (deliveries[0] ?? 0)) / 1000;
    const perSecond = (deliveries.length - 1) / seconds;
    expect(perSecond).toBeLessThanOrEqual((1000 / 16) * 1.1);
    expect(stats.delivered / stats.batches).toBeGreaterThan(1);
    console.info(
      `[S2 short run] ${String(stats.delivered)} events, ${String(deliveries.length)} callbacks ` +
        `(${perSecond.toFixed(1)}/s), ${(stats.delivered / stats.batches).toFixed(1)} events per batch`,
    );
  }, 30_000);

  it('never calls onEvents after shutdown resolved, and refuses requests', async () => {
    const { core, receivers, deliveries } = startChannel([['endless']]);
    core.startDemoSource({ route: 'endless', eventsPerSecond: 5_000 });
    const receiver = receivers[0];
    if (receiver === undefined) {
      throw new Error('receiver expected');
    }
    await receiver.waitFor(() => receiver.count('endless') > 500);
    await core.shutdown();
    expect(core.state).toBe('stopped');
    const callbacks = deliveries.length;
    const stats = core.eventStats();
    expect(stats.delivered).toBe(stats.queued);
    expect(stats.lost).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(deliveries.length).toBe(callbacks);
    expect(() => {
      core.echo('endless', 'late');
    }).toThrow(expect.objectContaining({ data: { kind: 'shuttingDown', retryable: false } }));
    await core.shutdown();
  }, 30_000);

  it('turns a panic into an internalError and keeps working', async () => {
    const { core, receivers } = startChannel([['after-panic', 'core/errors']]);
    let thrown: unknown;
    try {
      core.triggerPanic();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({
      code: -32603,
      data: { kind: 'internalError', retryable: false },
    });
    expect(core.state).toBe('running');
    core.echo('after-panic', 'still alive');
    core.spawnPanickingTask();
    const receiver = receivers[0];
    if (receiver === undefined) {
      throw new Error('receiver expected');
    }
    await receiver.waitFor(
      () => receiver.count('after-panic') === 1 && receiver.count('core/errors') === 1,
    );
    expect(receiver.events.get('after-panic')).toEqual([{ echo: 'still alive' }]);
    expect(receiver.events.get('core/errors')?.[0]).toMatchObject({
      code: -32603,
      data: { kind: 'internalError', retryable: false },
    });
  }, 30_000);

  it('forwards a batch above 1 MiB intact', async () => {
    const { core, receivers } = startChannel([['large']]);
    const pad = 1536 * 1024;
    core.startDemoSource({ route: 'large', eventsPerSecond: 4, maxEvents: 3, padBytes: pad });
    const receiver = receivers[0];
    if (receiver === undefined) {
      throw new Error('receiver expected');
    }
    await receiver.waitFor(() => receiver.count('large') === 3);
    receiver.expectContiguous('large', 3);
    for (const size of receiver.bytes.get('large') ?? []) {
      expect(size).toBeGreaterThan(1024 * 1024);
    }
    for (const event of receiver.events.get('large') ?? []) {
      expect(event).toMatchObject({ pad: 'x'.repeat(pad) });
    }
  }, 30_000);
});

describe('Core and process exit', () => {
  /** Runs a Node child that loads Core, streams events, then optionally shuts down. */
  function runChild(
    shutdown: boolean,
  ): Promise<{ code: number | null; output: string; exited: boolean }> {
    const script = `
      const { CoreRuntime } = require(${JSON.stringify(modulePath)});
      let events = 0;
      const core = CoreRuntime.create({}, (batches) => { events += batches.length; });
      core.startDemoSource({ route: 'exit', eventsPerSecond: 2000 });
      setTimeout(() => {
        ${shutdown ? "core.shutdown().then(() => console.log('stopped', core.state, events > 0));" : ''}
      }, 300);
    `;
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
      const timer = setTimeout(
        () => {
          child.kill();
          resolve({ code: null, output, exited: false });
        },
        shutdown ? 15_000 : 2_000,
      );
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, output, exited: true });
      });
    });
  }

  it('lets the process exit once shutdown released the listener', async () => {
    if (!existsSync(modulePath)) {
      throw new Error(`${modulePath} is missing. Run \`npm run build:core\` first.`);
    }
    const result = await runChild(true);
    expect(result).toMatchObject({ exited: true, code: 0 });
    expect(result.output).toContain('stopped stopped true');
  }, 30_000);

  it('keeps the process alive while Core runs without shutdown (the listener holds it)', async () => {
    if (!existsSync(modulePath)) {
      throw new Error(`${modulePath} is missing. Run \`npm run build:core\` first.`);
    }
    const result = await runChild(false);
    expect(result.exited).toBe(false);
  }, 30_000);
});

/** An event listener that drops every batch. */
function ignore(): void {
  // The state requests under test emit no events the test needs.
}

describe('Core state over a data directory (T13)', () => {
  it('opens the layout and answers trust and index requests as JSON', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'piarc state 中文 '));
    const dataDir = path.join(root, 'data');
    const cacheDir = path.join(root, 'cache');
    const workspace = path.join(root, 'ws');
    mkdirSync(workspace);
    const core = loadCoreModule(modulePath).CoreRuntime.create({ dataDir, cacheDir }, ignore);
    try {
      expect(statSync(path.join(dataDir, 'core.sqlite')).isFile()).toBe(true);
      expect(statSync(path.join(dataDir, 'pi', 'sessions')).isDirectory()).toBe(true);
      expect(statSync(cacheDir).isDirectory()).toBe(true);

      const before: unknown = JSON.parse(await core.projectTrust(workspace));
      expect(before).toMatchObject({ kind: 'notGit', trusted: false, items: [] });
      const decided: unknown = JSON.parse(await core.decideProjectTrust(workspace, true));
      expect(decided).toMatchObject({ trusted: true, decision: 'trusted' });
      const revoked: unknown = JSON.parse(await core.revokeProjectTrust(workspace));
      expect(revoked).toMatchObject({ trusted: false });
      // Argument errors are thrown synchronously, as by every export.
      let thrown: unknown;
      try {
        void core.projectTrust('relative/path');
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ data: { kind: 'invalidParams' } });

      const report: unknown = JSON.parse(await core.rebuildSessionIndex());
      expect(report).toMatchObject({ files: 0, removed: 0 });
    } finally {
      await core.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a data directory without a cache directory', () => {
    expect(() =>
      loadCoreModule(modulePath).CoreRuntime.create({ dataDir: '/tmp/x' }, ignore),
    ).toThrow(/dataDir and cacheDir go together/);
  });
});
