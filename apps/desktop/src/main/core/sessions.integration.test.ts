// T14-A12: the session layer through the NAPI module (the development build that
// `npm run build:core` writes): a workspace and its Agent Host, then create, prompt, fork,
// close, resume and the transcript window, with every result and error crossing the boundary.
// The Agent Host is the bundle `scripts/dev/build-agent-host.mjs` writes, run on this Node; the
// model is the strict mock provider (`piarc-mock-provider`, started with `cargo run`).
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { EventBatch } from '../../shared/ipc.js';
import { loadCoreModule } from './load.js';
import type { CoreRuntime } from './native/piarc-core.testing.js';
import { resolveCoreModulePath } from './native-path.js';

const desktopDir = path.join(import.meta.dirname, '..', '..', '..');
const repoRoot = path.join(desktopDir, '..', '..');
const bundleDir = path.join(repoRoot, 'agent-host', 'dist', 'bundle');
const modulePath = resolveCoreModulePath({
  isPackaged: false,
  appPath: desktopDir,
  platform: process.platform,
  arch: process.arch,
});

type CreateForTests = (
  options: Parameters<typeof CoreRuntime.createForTests>[0],
  onEvents: (batches: EventBatch[]) => void,
) => CoreRuntime;

/** `CoreRuntime.createForTests` of the development build (in-memory vault key). */
function createForTests(): CreateForTests {
  const runtime: unknown = loadCoreModule(modulePath).CoreRuntime;
  if (
    typeof runtime !== 'function' ||
    !('createForTests' in runtime) ||
    typeof runtime.createForTests !== 'function'
  ) {
    throw new Error(`${modulePath} is not a development build of Core`);
  }
  const create = runtime.createForTests as CreateForTests;
  return (options, onEvents) => create.call(runtime, options, onEvents);
}

interface Mock {
  child: ChildProcessByStdio<Writable, Readable, null>;
  origin: string;
}

async function startMock(): Promise<Mock> {
  const scenarios = path.join(
    repoRoot,
    'crates',
    'piarc-testkit',
    'tests',
    'sessions',
    'scenarios',
  );
  const child = spawn(
    'cargo',
    [
      'run',
      '-q',
      '-p',
      'piarc-testkit',
      '--bin',
      'piarc-mock-provider',
      '--',
      '--port',
      '0',
      '--scenarios',
      scenarios,
    ],
    { cwd: repoRoot, stdio: ['pipe', 'pipe', 'inherit'] },
  );
  const lines = createInterface({ input: child.stdout });
  const port = await new Promise<string>((resolve, reject) => {
    lines.once('line', resolve);
    child.once('exit', (code) => {
      reject(new Error(`the mock exited with ${String(code)} before printing its port`));
    });
  });
  lines.close();
  return { child, origin: `http://127.0.0.1:${port}` };
}

/** Every event Core delivered, decoded, with a way to wait for one. */
class Events {
  readonly all: { route: string; event: Record<string, unknown> }[] = [];
  #waiters: (() => void)[] = [];

  readonly listener = (batches: EventBatch[]): void => {
    for (const batch of batches) {
      const events: unknown = JSON.parse(new TextDecoder().decode(batch.payload));
      if (Array.isArray(events)) {
        for (const event of events) {
          if (typeof event === 'object' && event !== null) {
            this.all.push({ route: batch.route, event: event as Record<string, unknown> });
          }
        }
      }
    }
    for (const wake of this.#waiters.splice(0)) {
      wake();
    }
  };

  async until(match: (route: string, event: Record<string, unknown>) => boolean): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (!this.all.some((e) => match(e.route, e.event))) {
      if (Date.now() > deadline) {
        throw new Error(`no matching event; got ${JSON.stringify(this.all.slice(-5))}`);
      }
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
        setTimeout(resolve, 1000);
      });
    }
  }
}

function json(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null) {
    throw new Error(`not a JSON object: ${text}`);
  }
  return value as Record<string, unknown>;
}

const completed =
  (id: string, turnId: unknown) => (route: string, event: Record<string, unknown>) =>
    route === `session/${id}` &&
    event.method === 'turn/completed' &&
    (event.params as Record<string, unknown>).turnId === turnId;

describe('Core sessions over NAPI (T14)', () => {
  let mock: Mock;
  let root: string;

  beforeAll(async () => {
    if (!existsSync(modulePath)) {
      throw new Error(`${modulePath} is missing. Run \`npm run build:core\` first.`);
    }
    const built = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'dev', 'build-agent-host.mjs')],
      {
        cwd: repoRoot,
        stdio: 'inherit',
      },
    );
    expect(built.status).toBe(0);
    mock = await startMock();
    root = mkdtempSync(path.join(tmpdir(), 'piarc napi sessions 中文 '));
  }, 300_000);

  afterAll(async () => {
    mock.child.stdin.end();
    await new Promise((resolve) => mock.child.once('exit', resolve));
    rmSync(root, { recursive: true, force: true });
  });

  it('opens a workspace and creates, prompts, forks, closes and resumes sessions', async () => {
    const dataDir = path.join(root, 'data');
    const workspace = path.join(root, 'work space 工作区');
    mkdirSync(path.join(dataDir, 'pi'), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(
      path.join(dataDir, 'pi', 'models.json'),
      JSON.stringify({
        providers: {
          'piarc-mock': {
            baseUrl: mock.origin,
            api: 'anthropic-messages',
            apiKey: 'piarc-mock-test-key',
            models: [
              {
                id: 'mock-large',
                name: 'mock-large',
                reasoning: false,
                input: ['text'],
                contextWindow: 200000,
                maxTokens: 4096,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
    );
    const events = new Events();
    const core = createForTests()(
      {
        dataDir,
        cacheDir: path.join(root, 'cache'),
        agentHost: {
          node: process.execPath,
          bundle: path.join(bundleDir, 'agent-host.mjs'),
          piPackageDir: path.join(bundleDir, 'pi-assets'),
        },
      },
      events.listener,
    );
    try {
      expect(json(await core.openWorkspace(workspace))).toMatchObject({
        host: 'ready',
        open: true,
      });
      const created = json(
        await core.createSession(workspace, {
          model: { provider: 'piarc-mock', id: 'mock-large' },
        }),
      );
      const id = String(created.sessionId);
      const accepted = json(await core.prompt(id, 'Question one. [[piarc-scenario:chat]]'));
      await events.until(completed(id, accepted.turnId));

      const copy = String(json(await core.forkSession(id, null)).sessionId);
      expect(copy).not.toBe(id);
      const window = json(await core.transcriptWindow(copy, 0, 50));
      expect(window).toMatchObject({ start: 0, total: 2 });

      json(await core.closeSession(copy));
      json(await core.closeSession(id));
      // A closed session refuses requests with a structured error.
      await expect(core.prompt(id, 'Too late.')).rejects.toMatchObject({
        data: { kind: 'sessionNotFound' },
      });
      // Argument errors are thrown synchronously.
      expect(() => core.resumeSession('not/an/id')).toThrow(/sessionId/);

      const resumed = json(await core.resumeSession(id));
      expect(resumed).toMatchObject({ sessionId: id, restoredMessages: 3 });
      const again = json(await core.prompt(id, 'Question two.'));
      await events.until(completed(id, again.turnId));
      expect(events.all.some((e) => e.route === 'core/sessions')).toBe(true);
      expect(events.all.some((e) => e.route === 'core/workspaces')).toBe(true);
      await core.closeWorkspace(workspace);
    } finally {
      await core.shutdown();
    }
  }, 120_000);
});
