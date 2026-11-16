// S8 on Windows (W0): Core starts the Agent Host in a Job Object with KILL_ON_JOB_CLOSE
// (piarc_exec::ProcessTreeSpawner), so when PiArc's main process dies, for example ended from
// Task Manager, Windows closes the job and ends the Agent Host and everything it started. The
// test ends the main process with `taskkill /F` (TerminateProcess, as Task Manager's "End
// task" does for a process that does not answer) while a turn is in progress and the Agent
// Host runs an MCP server through the bundled npx, then checks the process table.
// Packaged form only (Resources/agent-host/); macOS ends the Agent Host through its process
// group instead (I36).
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startMock } from './agent-host.js';
import { expectTestHooks } from './core.js';
import { expect, test } from './fixtures.js';

test.skip(process.platform !== 'win32', 'the Job Object is Windows only');

const repoRoot = path.join(import.meta.dirname, '..', '..', '..');

interface ProcessRow {
  pid: number;
  parent: number;
  name: string;
}

/** Every process with its parent, from a CIM snapshot. */
function processTable(): ProcessRow[] {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name | ConvertTo-Json -Compress',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (result.status !== 0) {
    throw new Error(`process snapshot failed: ${result.stderr}`);
  }
  const rows = JSON.parse(result.stdout) as {
    ProcessId: number;
    ParentProcessId: number;
    Name: string;
  }[];
  return rows.map((row) => ({ pid: row.ProcessId, parent: row.ParentProcessId, name: row.Name }));
}

/** `root` and its descendants, each with its depth below `root`. */
function tree(table: ProcessRow[], root: number): (ProcessRow & { depth: number })[] {
  const found: (ProcessRow & { depth: number })[] = [];
  let level = table.filter((row) => row.pid === root).map((row) => ({ ...row, depth: 0 }));
  while (level.length > 0) {
    found.push(...level);
    const pids = new Set(level.map((row) => row.pid));
    const depth = (level[0]?.depth ?? 0) + 1;
    level = table
      .filter((row) => pids.has(row.parent) && row.pid !== row.parent)
      .map((row) => ({ ...row, depth }));
  }
  return found;
}

function describe(rows: (ProcessRow & { depth: number })[]): string {
  return rows.map((row) => `${'  '.repeat(row.depth)}${row.name} ${String(row.pid)}`).join('\n');
}

test('ending the main process ends the Agent Host and its process tree', async ({
  app,
}, testInfo) => {
  test.setTimeout(180_000);
  await expectTestHooks(app);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'piarc s8 进程树-')));
  const workspace = path.join(root, 'ws');
  const dataDir = path.join(root, 'data');
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(dataDir, 'pi'), { recursive: true });
  // The model starts its answer and then sends nothing more: the turn stays in progress.
  const scenario = path.join(root, 'scenario.json');
  await writeFile(
    scenario,
    JSON.stringify({
      id: 's8-kill',
      steps: [{ text: 'Thinking about it for a long while', stall_after_events: 3 }],
    }),
  );
  const mock = await startMock(scenario);
  // Electron's main process (Playwright's own child can be a launcher in front of it).
  const mainPid = await app.evaluate(() => process.pid);
  try {
    await writeFile(
      path.join(dataDir, 'pi', 'models.json'),
      JSON.stringify({
        providers: {
          'piarc-mock': {
            baseUrl: mock.baseUrl,
            api: 'anthropic-messages',
            apiKey: 'piarc-mock-test-key',
            models: [
              {
                id: 'mock-large',
                name: 'mock-large',
                reasoning: false,
                input: ['text'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200_000,
                maxTokens: 4096,
              },
            ],
          },
        },
      }),
    );
    await writeFile(path.join(dataDir, 'pi', 'settings.json'), '{}');
    // An MCP server started by the bundled npx (a registry-style tarball, see
    // agent-host.e2e.ts): the Agent Host → npx → node levels of the tree.
    const resourcesDir = await app.evaluate(() => process.resourcesPath);
    const agentHostDir = path.join(resourcesDir, 'agent-host');
    const packed = spawnSync(
      path.join(agentHostDir, 'node', 'node.exe'),
      [
        path.join(agentHostDir, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        'pack',
        path.join(repoRoot, 'packages', 'testkit', 'src', 'mcp-probe-server'),
        '--pack-destination',
        root,
        '--silent',
      ],
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

    // The probe never finishes: the main process dies under it.
    void app
      .evaluate(
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
          prompt: 'Take your time. [[piarc-scenario:s8-kill]]',
          timeoutMs: 150_000,
        },
      )
      .catch(() => undefined);

    // Wait until the model request is in progress and the MCP server runs: the Agent Host
    // (node.exe under the main process) has descendants two levels down.
    let before: (ProcessRow & { depth: number })[] = [];
    await expect
      .poll(
        async () => {
          const response = await fetch(`${mock.baseUrl}/_piarc/requests`);
          const requests = (await response.json()) as unknown[];
          before = tree(processTable(), mainPid);
          const agentHost = before.find((row) => row.depth === 1 && row.name === 'node.exe');
          const below = agentHost === undefined ? [] : tree(processTable(), agentHost.pid);
          return requests.length > 0 && below.some((row) => row.depth >= 2);
        },
        { timeout: 90_000, intervals: [250] },
      )
      .toBe(true);
    before = tree(processTable(), mainPid);
    // Chromium's own helpers (renderer, GPU, crashpad) leave on their own schedule; the job
    // holds the Agent Host and what it started.
    const agentHostPid = before.find((row) => row.depth === 1 && row.name === 'node.exe')?.pid;
    const descendants = before.filter(
      (row) =>
        agentHostPid !== undefined && tree(before, agentHostPid).some((r) => r.pid === row.pid),
    );

    const killed = spawn('taskkill.exe', ['/F', '/PID', String(mainPid)], { stdio: 'ignore' });
    await new Promise((resolve) => killed.once('exit', resolve));

    let alive: ProcessRow[] = [];
    await expect
      .poll(
        () => {
          const pids = new Set(processTable().map((row) => row.pid));
          alive = descendants.filter((row) => pids.has(row.pid));
          return alive.length;
        },
        { timeout: 15_000, intervals: [250] },
      )
      .toBe(0);
    const report = [
      `before taskkill /F of the main process ${String(mainPid)}:`,
      describe(before),
      `after: none of the ${String(descendants.length)} processes of the Agent Host's tree is running`,
    ].join('\n');
    console.log(report);
    await writeFile(testInfo.outputPath('process-tree.txt'), `${report}\n`, 'utf8');
  } finally {
    mock.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
