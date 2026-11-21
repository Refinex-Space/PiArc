#!/usr/bin/env node
// M3 memory (T35-A11, architecture chapter 11): one window, three sessions of one workspace
// running at once (one in its own worktree), each streaming from the strict mock and calling
// tools, one of them running a subagent that does the same. Once all four are under way, the
// script samples every process for a while:
//
// - the app's processes through `app.getAppMetrics()` (main process with Core, renderer, GPU,
//   network and other helpers): working set, which is the resident size on macOS;
// - the Agent Host (the node process the main process started for the workspace): RSS from
//   `ps` (macOS) or the working set from CIM (Windows).
//
// Budgets (chapter 11 as of this run): Agent Host ≤ 150 MB + 40 MB per further active session
// (the subagent counts as one: 4 active, 270 MB); the app's other processes together ≤ 510 MB on
// macOS and ≤ 450 MB on Windows. MB is 10^6 bytes, as in chapter 11.
//
//   npm run perf:m3 -- [--form packaged|dev] [--warmup 20] [--seconds 30]
//
// JSON goes to tmp/evidence/T35/m3-memory.json; the exit code is 1 when a budget is exceeded.
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

import { _electron as electron } from '@playwright/test';

import { isMain, isRecord, repoRoot } from '../lib/repo.mjs';
import { appCommand } from '../bench/s1-transcript.mjs';

export const BUDGET = {
  agentHostBaseMB: 150,
  agentHostPerSessionMB: 40,
  appOtherMB: process.platform === 'win32' ? 450 : 510,
};

/** Model responses per session: about 1.3 s each, so every session still runs while sampling. */
const STEPS = 120;

/** Active sessions in the Agent Host: three sessions and one subagent. */
const ACTIVE = 4;
const MB = 1_000_000;

/**
 * A long turn: each step streams text and then calls a read-only tool.
 * @param {string} id
 * @param {number} steps
 * @param {(i: number) => object} tool
 * @param {object[]} [first]
 */
function scenario(id, steps, tool, first = []) {
  const text = (/** @type {number} */ i) =>
    `Step ${String(i)} of ${id}: looking at the project and writing down what it found. `.repeat(8);
  return {
    id,
    steps: [
      ...first,
      ...Array.from({ length: steps }, (_, i) => ({
        text: text(i),
        chunk_chars: 12,
        chunk_delay_ms: 30,
        tool_calls: [{ id: `${id}-${String(i)}`, ...tool(i) }],
      })),
      { text: `Done with ${id}.` },
    ],
  };
}

const read = () => ({ name: 'Read', input: { path: 'src/lib.txt' } });
const listing = (/** @type {number} */ i) =>
  i % 2 === 0
    ? { name: 'Bash', input: { command: 'ls -la src', description: 'List' } }
    : { name: 'Grep', input: { pattern: 'line', path: 'src' } };

/**
 * @param {string} dir
 */
async function writeScenarios(dir) {
  const files = {
    'm3-one.json': scenario('m3-one', STEPS, read),
    'm3-tree.json': scenario('m3-tree', STEPS, listing),
    'm3-agent.json': scenario('m3-agent', STEPS, read, [
      {
        tool_calls: [
          {
            id: 'agent',
            name: 'Agent',
            input: {
              description: 'Explore',
              prompt: 'Look through the sources. [[piarc-scenario:m3-child]]',
              subagent_type: 'general-purpose',
            },
          },
        ],
      },
    ]),
    'm3-child.json': scenario('m3-child', STEPS, listing),
  };
  await mkdir(dir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    await writeFile(path.join(dir, name), JSON.stringify(value));
  }
}

/**
 * @param {string} scenarios
 * @returns {Promise<{ baseUrl: string, stop: () => void }>}
 */
async function startMock(scenarios) {
  const child = spawn(
    'cargo',
    [
      'run',
      '-q',
      '--locked',
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
  /** @type {string} */
  const port = await new Promise((resolve, reject) => {
    lines.once('line', (/** @type {string} */ line) => {
      resolve(line);
    });
    child.once('exit', (code) => {
      reject(new Error(`piarc-mock-provider exited with ${String(code)}`));
    });
  });
  lines.close();
  return { baseUrl: `http://127.0.0.1:${port.trim()}`, stop: () => child.stdin.end() };
}

/**
 * Pi's models (the mock) in the data directory.
 * @param {string} dataDir
 * @param {string} baseUrl
 */
async function seedModels(dataDir, baseUrl) {
  await mkdir(path.join(dataDir, 'pi'), { recursive: true });
  await writeFile(
    path.join(dataDir, 'pi', 'models.json'),
    JSON.stringify({
      providers: {
        'piarc-mock': {
          baseUrl,
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
}

/**
 * A git repository with a few files to read.
 * @param {string} dir
 */
async function makeRepository(dir) {
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(
    path.join(dir, 'src', 'lib.txt'),
    Array.from({ length: 400 }, (_, i) => `line ${String(i)} of the library`).join('\n'),
  );
  await writeFile(path.join(dir, '.gitignore'), '.piarc/worktrees/\n');
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=PiArc M3',
        '-c',
        'user.email=m3@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: dir, stdio: 'ignore' },
    );
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'initial');
}

/**
 * Requests the mock received per scenario.
 * @param {string} baseUrl
 */
async function requestCounts(baseUrl) {
  const response = await fetch(`${baseUrl}/_piarc/requests`);
  /** @type {unknown} */
  const records = await response.json();
  /** @type {Record<string, number>} */
  const counts = {};
  for (const record of Array.isArray(records) ? records : []) {
    const name = isRecord(record) && typeof record.scenario === 'string' ? record.scenario : '';
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

/**
 * Resident size (bytes) of each process whose command line contains `agent-host`, among the
 * children of `parent`.
 * @param {number} parent
 * @returns {{ pid: number, bytes: number }[]}
 */
function agentHosts(parent) {
  if (process.platform === 'win32') {
    const script = `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${String(parent)}" | Where-Object { $_.CommandLine -like '*agent-host*' } | ForEach-Object { "$($_.ProcessId) $($_.WorkingSetSize)" }`;
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return out
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => {
        const [pid, bytes] = line.trim().split(/\s+/u).map(Number);
        return { pid: pid ?? 0, bytes: bytes ?? 0 };
      });
  }
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((line) => /^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u.exec(line.trim()))
    .filter((m) => m !== null && Number(m[2]) === parent && (m[4] ?? '').includes('agent-host'))
    .map((m) => ({ pid: Number(m?.[1]), bytes: Number(m?.[3]) * 1024 }));
}

/**
 * One sample: each app process type's working set, the Agent Host's resident size (when the
 * main process id is given) and the main process's JavaScript memory.
 * @param {import('@playwright/test').ElectronApplication} app
 * @param {number} [mainPid]
 */
async function snapshot(app, mainPid) {
  const { metrics, main } = await app.evaluate(({ app: electronApp }) => ({
    metrics: electronApp
      .getAppMetrics()
      .map((m) => ({ type: m.type, kib: m.memory.workingSetSize })),
    main: process.memoryUsage(),
  }));
  /** @type {Record<string, number>} */
  const byType = {};
  for (const metric of metrics)
    byType[metric.type] = (byType[metric.type] ?? 0) + metric.kib * 1024;
  const hosts = mainPid === undefined ? [] : agentHosts(mainPid);
  return {
    at: Date.now(),
    agentHostBytes: hosts.reduce((sum, host) => sum + host.bytes, 0),
    appBytes: metrics.reduce((sum, metric) => sum + metric.kib * 1024, 0),
    byType,
    main,
  };
}

/**
 * @param {number[]} values
 */
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (/** @type {number} */ q) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
  return { min: sorted[0] ?? Number.NaN, median: at(0.5), max: at(1) };
}

/**
 * Starts a session from the home view: the text carries the mock's scenario marker.
 * @param {import('@playwright/test').Page} page
 * @param {string} scenarioId
 * @param {{ worktree?: string, trust?: boolean }} options
 */
async function startSession(page, scenarioId, options) {
  await page.getByTestId('new-session').click();
  if (options.worktree !== undefined) {
    await page.getByTestId('home-worktree').check();
    await page.getByTestId('home-worktree-name').fill(options.worktree);
  }
  await page.getByTestId('home-input').fill(`Work on it [[piarc-scenario:${scenarioId}]]`);
  await page.getByTestId('home-start').click();
  if (options.trust === true) await page.getByTestId('trust-accept').click();
  await page.getByTestId('conversation').waitFor({ timeout: 30_000 });
}

/**
 * @param {{ form: 'packaged' | 'dev', warmup: number, seconds: number }} options
 */
export async function measure(options) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'piarc m3 内存 ')));
  const userData = path.join(root, 'data');
  const workspace = path.join(root, 'repo 仓库');
  await writeScenarios(path.join(root, 'scenarios'));
  await makeRepository(workspace);
  const mock = await startMock(path.join(root, 'scenarios'));
  await seedModels(userData, mock.baseUrl);
  const { command, args } = await appCommand(options.form, [`--user-data-dir=${userData}`]);
  const app = await electron.launch({
    executablePath: command,
    args,
    env: { ...process.env, PIARC_TEST_MEMORY_KEYCHAIN: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId('app-shell').waitFor();
    await page.evaluate("window.piarc.setPreference({ key: 'language', value: 'en' })");
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, workspace);
    await page.getByTestId('open-folder').click();
    await page.getByTestId('home-workspace').waitFor();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const idle = await snapshot(app);
    await startSession(page, 'm3-one', { trust: true });
    await startSession(page, 'm3-tree', { worktree: 'm3-tree' });
    await startSession(page, 'm3-agent', {});
    // Under way: the sessions and the subagent asked the model at least twice (the session that
    // started the subagent waits for it in its first request).
    const deadline = Date.now() + 60_000;
    for (;;) {
      const counts = await requestCounts(mock.baseUrl);
      const twice = ['m3-one', 'm3-tree', 'm3-child'].every((id) => (counts[id] ?? 0) >= 2);
      if (twice && (counts['m3-agent'] ?? 0) >= 1) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(`the sessions did not get going: ${JSON.stringify(counts)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    console.log(`warming up for ${String(options.warmup)} s`);
    await new Promise((resolve) => setTimeout(resolve, options.warmup * 1000));
    const mainPid = await app.evaluate(() => process.pid);
    /** @type {Awaited<ReturnType<typeof snapshot>>[]} */
    const samples = [];
    const end = Date.now() + options.seconds * 1000;
    while (Date.now() < end) {
      samples.push(await snapshot(app, mainPid));
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    const counts = await requestCounts(mock.baseUrl);
    const agentHostMB = stats(samples.map((s) => s.agentHostBytes / MB));
    const appOtherMB = stats(samples.map((s) => s.appBytes / MB));
    const mainHeapMB = {
      heapUsed: stats(samples.map((s) => s.main.heapUsed / MB)),
      external: stats(samples.map((s) => s.main.external / MB)),
      arrayBuffers: stats(samples.map((s) => s.main.arrayBuffers / MB)),
    };
    const types = [...new Set(samples.flatMap((s) => Object.keys(s.byType)))];
    const byTypeMB = Object.fromEntries(
      types.map((type) => [type, stats(samples.map((s) => (s.byType[type] ?? 0) / MB))]),
    );
    const agentHostBudget = BUDGET.agentHostBaseMB + BUDGET.agentHostPerSessionMB * (ACTIVE - 1);
    return {
      date: new Date().toISOString(),
      form: options.form,
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus()[0]?.model ?? 'unknown',
      memoryGiB: os.totalmem() / 1024 ** 3,
      os: os.release(),
      warmupSeconds: options.warmup,
      samples: samples.length,
      activeSessions: ACTIVE,
      requests: counts,
      agentHostMB,
      appOtherMB,
      byTypeMB,
      mainHeapMB,
      idle: {
        appOtherMB: idle.appBytes / MB,
        byTypeMB: Object.fromEntries(
          Object.entries(idle.byType).map(([type, bytes]) => [type, bytes / MB]),
        ),
        mainHeapUsedMB: idle.main.heapUsed / MB,
      },
      budgetMB: { agentHost: agentHostBudget, appOther: BUDGET.appOtherMB },
      withinBudget: {
        agentHost: agentHostMB.max <= agentHostBudget,
        appOther: appOtherMB.max <= BUDGET.appOtherMB,
      },
    };
  } finally {
    await app.close().catch(() => undefined);
    mock.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      form: { type: 'string', default: 'packaged' },
      warmup: { type: 'string', default: '20' },
      seconds: { type: 'string', default: '30' },
    },
  });
  const form = values.form === 'dev' ? 'dev' : 'packaged';
  const result = await measure({
    form,
    warmup: Number(values.warmup),
    seconds: Number(values.seconds),
  });
  const out = path.join(repoRoot, 'tmp', 'evidence', 'T35', 'm3-memory.json');
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
  const f = (/** @type {number} */ n) => n.toFixed(0);
  console.log(
    `Agent Host: median ${f(result.agentHostMB.median)} MB, max ${f(result.agentHostMB.max)} MB (budget ${f(result.budgetMB.agentHost)} MB)`,
  );
  console.log(
    `app's other processes: median ${f(result.appOtherMB.median)} MB, max ${f(result.appOtherMB.max)} MB (budget ${f(result.budgetMB.appOther)} MB)`,
  );
  for (const [type, s] of Object.entries(result.byTypeMB)) {
    console.log(
      `  ${type}: median ${f(s.median)} MB, max ${f(s.max)} MB (idle ${f(result.idle.byTypeMB[type] ?? 0)} MB)`,
    );
  }
  console.log(
    `  main process JavaScript heap: ${f(result.mainHeapMB.heapUsed.median)} MB (idle ${f(result.idle.mainHeapUsedMB)} MB), external ${f(result.mainHeapMB.external.median)} MB`,
  );
  console.log(`wrote ${path.relative(repoRoot, out)}`);
  if (!result.withinBudget.agentHost || !result.withinBudget.appOther) process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  await main();
}
