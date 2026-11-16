// S6 (T12): the packaged app starts its bundled Agent Host the way production does (bundled
// Node, PI_PACKAGE_DIR, minimal environment; on macOS under sandbox-exec with the permissive
// profile) and holds one mock conversation through Core's `agentHostProbe` test export.
// The conversation exercises the delegated Bash, Grep and Glob tools and an MCP server that
// the bundled `npx` starts from a local package (packages/testkit/src/mcp-probe-server/); the
// server reports which node runs it, worker_threads, git, writes inside and outside the
// writable directories, and loading a native module.
//
// Only the `packaged` project runs this file (playwright.config.ts): the `dev` form runs
// Electron from node_modules, which has no Resources/agent-host/.
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startMock } from './agent-host.js';
import { expectTestHooks } from './core.js';
import { expect, test } from './fixtures.js';

const repoRoot = path.join(import.meta.dirname, '..', '..', '..');
const isMac = process.platform === 'darwin';

interface ProbeItem {
  type?: string;
  tool?: string;
  status?: string;
  output?: unknown;
}

interface ProbeReport {
  piVersion: string;
  pid: number | null;
  sessionId: string;
  turn: { status?: string };
  items: ProbeItem[];
  methods: string[];
  toolIo: { method: string; tool: string | null; error: string | null }[];
}

interface Attempt {
  ok: boolean;
  value?: unknown;
  error?: string;
}

interface McpProbe {
  execPath: string;
  nodeVersion: string;
  env: { tmpdir: string | null; npmCache: string | null; piPackageDir: string | null };
  worker: Attempt;
  gitVersion: Attempt;
  gitStatus: Attempt;
  writeInside: Attempt;
  writeOutside: Attempt;
  nativeModule: Attempt;
}

/** A native module from the repository's node_modules, standing in for one npx downloaded. */
function nativeModuleFixture(): string {
  const os = process.platform === 'win32' ? 'win32' : 'darwin';
  return path.join(
    repoRoot,
    'node_modules',
    '@earendil-works',
    'pi-tui',
    'native',
    os,
    'prebuilds',
    `${os}-${process.arch}`,
    `${os}-platform.node`,
  );
}

test('the bundled Agent Host holds a mock conversation with tools and an npx MCP server', async ({
  app,
}, testInfo) => {
  test.setTimeout(180_000);
  await expectTestHooks(app);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'piarc s6 探针-')));
  const workspace = path.join(root, 'ws 工作区');
  const dataDir = path.join(root, 'data');
  const outside = path.join(root, 'outside.txt');
  const inside = path.join(workspace, 'written-by-mcp.txt');
  const native = path.join(workspace, 'native', path.basename(nativeModuleFixture()));
  await mkdir(path.join(dataDir, 'pi'), { recursive: true });
  await mkdir(path.dirname(native), { recursive: true });
  await copyFile(nativeModuleFixture(), native);
  await writeFile(path.join(workspace, 'notes.txt'), 'the needle is here\n');
  expect(spawnSync('git', ['init', '-q', workspace]).status).toBe(0);

  const probeArgs = { workspace, inside, outside, native };
  const scenario = path.join(root, 'scenario.json');
  await writeFile(
    scenario,
    JSON.stringify({
      id: 's6-probe',
      steps: [
        {
          tool_calls: [{ name: 'Bash', input: { command: 'printf bash-ok; git status --short' } }],
        },
        { tool_calls: [{ name: 'Grep', input: { pattern: 'needle', path: '.' } }] },
        { tool_calls: [{ name: 'Glob', input: { pattern: '**/*.txt' } }] },
        { tool_calls: [{ name: 'mcp__probe__probe', input: probeArgs }] },
        { text: 'Probe finished.' },
      ],
    }),
  );
  const mock = await startMock(scenario);
  try {
    const model = (id: string): Record<string, unknown> => ({
      id,
      name: id,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 4096,
    });
    await writeFile(
      path.join(dataDir, 'pi', 'models.json'),
      JSON.stringify({
        providers: {
          'piarc-mock': {
            baseUrl: mock.baseUrl,
            api: 'anthropic-messages',
            apiKey: 'piarc-mock-test-key',
            models: [model('mock-large')],
          },
        },
      }),
    );
    await writeFile(path.join(dataDir, 'pi', 'settings.json'), '{}');
    // MCP servers arrive as registry tarballs that npm extracts into its cache; `npx <folder>`
    // would instead link the folder and chmod its bin in place, outside the writable
    // directories. So the fixture is packed with the bundled npm first.
    const resourcesDir = await app.evaluate(() => process.resourcesPath);
    const agentHostDir = path.join(resourcesDir, 'agent-host');
    const serverDir = path.join(repoRoot, 'packages', 'testkit', 'src', 'mcp-probe-server');
    const npmCli = isMac
      ? path.join(agentHostDir, 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : path.join(agentHostDir, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const bundledNodePath = isMac
      ? path.join(agentHostDir, 'node', 'bin', 'node')
      : path.join(agentHostDir, 'node', 'node.exe');
    const packed = spawnSync(
      bundledNodePath,
      [npmCli, 'pack', serverDir, '--pack-destination', root, '--silent'],
      { encoding: 'utf8' },
    );
    expect(packed.status, packed.stderr).toBe(0);
    const tarball = path.join(root, packed.stdout.trim());
    await writeFile(
      path.join(dataDir, 'pi', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          probe: {
            command: 'npx',
            args: ['-y', '--package', tarball, 'piarc-mcp-probe-server'],
            exposure: 'direct',
          },
        },
      }),
    );

    const json = await app.evaluate(
      async (_electron, options) => {
        const hooks = globalThis.__piarcTestHooks;
        if (hooks === undefined) {
          throw new Error('no Core test hooks');
        }
        return hooks.core.agentHostProbe(options);
      },
      {
        resourcesDir,
        workspace,
        dataDir,
        provider: 'piarc-mock',
        model: 'mock-large',
        prompt: 'Probe the sandbox. [[piarc-scenario:s6-probe]]',
        timeoutMs: 150_000,
      },
    );
    await writeFile(testInfo.outputPath('probe-report.json'), json, 'utf8');
    const report = JSON.parse(json) as ProbeReport;

    // One completed conversation through every tool.
    expect(report.turn.status).toBe('completed');
    const tools = report.items
      .filter((item) => item.type === 'dynamicToolCall')
      .map((item) => `${String(item.tool)}:${String(item.status)}`);
    expect(tools).toEqual([
      'Bash:completed',
      'Grep:completed',
      'Glob:completed',
      'mcp__probe__probe:completed',
    ]);
    const bash = report.items.find((item) => item.tool === 'Bash');
    expect(String(bash?.output)).toContain('bash-ok');
    expect(String(report.items.find((item) => item.tool === 'Grep')?.output)).toContain('needle');
    expect(String(report.items.find((item) => item.tool === 'Glob')?.output)).toContain(
      'notes.txt',
    );
    expect(report.toolIo.filter((call) => call.error !== null)).toEqual([]);
    expect(report.toolIo.map((call) => call.method)).toEqual(
      expect.arrayContaining(['exec/run', 'fs/grep', 'fs/glob']),
    );

    // The MCP server ran on the bundled node, started by the bundled npx.
    const mcpItem = report.items.find((item) => item.tool === 'mcp__probe__probe');
    const probe = JSON.parse(String(mcpItem?.output)) as McpProbe;
    await writeFile(testInfo.outputPath('mcp-probe.json'), JSON.stringify(probe, null, 2));
    const bundledNode = await realpath(bundledNodePath);
    expect(await realpath(probe.execPath)).toBe(bundledNode);
    expect(probe.nodeVersion).toBe('v24.22.3');
    expect(probe.env.piPackageDir).toBe(path.join(resourcesDir, 'agent-host', 'pi-assets'));
    expect(probe.env.tmpdir).toBe(path.join(dataDir, 'agent-host', 'tmp'));
    expect(probe.env.npmCache).toBe(path.join(dataDir, 'agent-host', 'npm-cache'));
    expect(await readdir(path.join(dataDir, 'agent-host', 'npm-cache', '_npx'))).not.toEqual([]);
    expect(probe.worker).toEqual({ ok: true, value: 42 });
    expect(probe.gitVersion.ok).toBe(true);
    expect(probe.gitStatus.ok).toBe(true);
    expect(probe.nativeModule.ok).toBe(true);

    // Writes: inside the workspace yes; outside the writable directories only where the
    // Agent Host has an OS sandbox (macOS; Windows has none in the first release, D7).
    expect(probe.writeInside.ok).toBe(true);
    expect(existsSync(inside)).toBe(true);
    if (isMac) {
      expect(probe.writeOutside).toEqual({ ok: false, error: 'EPERM' });
      expect(existsSync(outside)).toBe(false);
    }

    // Pi found its resources through PI_PACKAGE_DIR and never downloaded rg or fd.
    expect(report.piVersion).toBe('1.5.2');
    expect(existsSync(path.join(dataDir, 'pi', 'bin'))).toBe(false);
  } finally {
    mock.stop();
    await rm(root, { recursive: true, force: true });
  }
});
