// Shared pieces of the performance measurements (T44, architecture chapter 11): the strict mock
// provider as a child process, Pi's model configuration pointing at it, launching the app (the
// development-flavor package by default) with an isolated data directory, starting sessions
// from the home view, process sizes (`app.getAppMetrics()` and the Agent Host's resident size)
// and statistics. Moved here from T35's m3-memory.mjs so every probe uses one set of
// definitions. MB is 10^6 bytes, as in chapter 11.
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { createInterface } from 'node:readline';
import path from 'node:path';

import { _electron as electron } from '@playwright/test';

import { isRecord, repoRoot } from '../lib/repo.mjs';
import { appCommand } from '../bench/s1-transcript.mjs';

export const MB = 1_000_000;

/**
 * Starts piarc-mock-provider on a free port with the scenarios in `scenarios` (a file or a
 * directory); `stop` closes its stdin, which ends it.
 * @param {string} scenarios
 * @returns {Promise<{ baseUrl: string, stop: () => void }>}
 */
export async function startMock(scenarios) {
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

/** The mock's model as Pi's `models.json` describes it. */
export const MOCK_MODEL = {
  id: 'mock-large',
  name: 'mock-large',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4096,
};

/**
 * Pi's models (the mock) in `<dataDir>/pi/models.json`, and the user's `settings.json`.
 * @param {string} dataDir
 * @param {string} baseUrl
 * @param {Record<string, unknown>} [settings]
 */
export async function seedModels(dataDir, baseUrl, settings = {}) {
  await mkdir(path.join(dataDir, 'pi'), { recursive: true });
  await writeFile(path.join(dataDir, 'settings.json'), JSON.stringify(settings));
  await writeFile(
    path.join(dataDir, 'pi', 'models.json'),
    JSON.stringify({
      providers: {
        'piarc-mock': {
          baseUrl,
          api: 'anthropic-messages',
          apiKey: 'piarc-mock-test-key',
          models: [MOCK_MODEL],
        },
      },
    }),
  );
}

/**
 * The requests the mock received.
 * @param {string} baseUrl
 * @returns {Promise<{ scenario: string, body: string }[]>}
 */
export async function mockRequests(baseUrl) {
  const response = await fetch(`${baseUrl}/_piarc/requests`);
  /** @type {unknown} */
  const records = await response.json();
  return (Array.isArray(records) ? records : []).map((record) => ({
    scenario: isRecord(record) && typeof record.scenario === 'string' ? record.scenario : '',
    body: isRecord(record) && typeof record.body === 'string' ? record.body : '',
  }));
}

/**
 * Requests the mock received per scenario.
 * @param {string} baseUrl
 */
export async function requestCounts(baseUrl) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const { scenario } of await mockRequests(baseUrl)) {
    counts[scenario] = (counts[scenario] ?? 0) + 1;
  }
  return counts;
}

/**
 * Starts the app (`form`: the development-flavor package or the source tree's dev build) with
 * `userData` as its data directory; the vault's master key stays in memory (no keychain prompt).
 * @param {'packaged' | 'dev'} form
 * @param {string} userData
 * @param {{ env?: Record<string, string>, args?: string[] }} [options]
 */
export async function launchApp(form, userData, options = {}) {
  const { command, args } = await appCommand(form, [
    `--user-data-dir=${userData}`,
    ...(options.args ?? []),
  ]);
  const app = await electron.launch({
    executablePath: command,
    args,
    env: { ...process.env, PIARC_TEST_MEMORY_KEYCHAIN: '1', ...options.env },
  });
  const page = await app.firstWindow();
  await page.getByTestId('app-shell').waitFor({ timeout: 60_000 });
  await page.evaluate("window.piarc.setPreference({ key: 'language', value: 'en' })");
  return { app, page };
}

/**
 * Opens `dir` as a workspace through the sidebar (the folder picker answers `dir`).
 * @param {import('@playwright/test').ElectronApplication} app
 * @param {import('@playwright/test').Page} page
 * @param {string} dir
 */
export async function openWorkspace(app, page, dir) {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
  }, dir);
  await page.getByTestId('open-folder').click();
  await page.getByTestId('home-workspace').waitFor();
}

/**
 * Starts a session from the home view: the text carries the mock's scenario marker.
 * @param {import('@playwright/test').Page} page
 * @param {string} scenarioId
 * @param {{ worktree?: string, trust?: boolean }} [options]
 */
export async function startSession(page, scenarioId, options = {}) {
  await page.getByTestId('new-session').click();
  if (options.worktree !== undefined) {
    await page.locator('.environment-change').click();
    await page.getByTestId('menu-worktree').click();
    await page.getByTestId('home-worktree-name').fill(options.worktree);
  }
  await page.getByTestId('home-input').fill(`Work on it [[piarc-scenario:${scenarioId}]]`);
  await page.getByTestId('home-start').click();
  if (options.trust === true) await page.getByTestId('trust-accept').click();
  await page.getByTestId('conversation').waitFor({ timeout: 30_000 });
}

/**
 * Resident size (bytes) of each process whose command line contains `needle`, among the children
 * of `parent`: `ps` on macOS, the working set from CIM on Windows.
 * @param {number} parent
 * @param {string} needle
 * @returns {{ pid: number, bytes: number }[]}
 */
export function childProcesses(parent, needle) {
  if (process.platform === 'win32') {
    const script = `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${String(parent)}" | Where-Object { $_.CommandLine -like '*${needle}*' } | ForEach-Object { "$($_.ProcessId) $($_.WorkingSetSize)" }`;
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
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
    .filter((m) => m !== null && Number(m[2]) === parent && (m[4] ?? '').includes(needle))
    .map((m) => ({ pid: Number(m?.[1]), bytes: Number(m?.[3]) * 1024 }));
}

/**
 * One sample: each app process type's working set (the resident size on macOS), the Agent
 * Host's resident size (when the main process id is given), the MCP servers under it and the
 * main process's JavaScript memory.
 * @param {import('@playwright/test').ElectronApplication} app
 * @param {number} [mainPid]
 */
export async function appSnapshot(app, mainPid) {
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
  const hosts = mainPid === undefined ? [] : childProcesses(mainPid, 'agent-host');
  const servers = hosts.flatMap((host) => childProcesses(host.pid, 'mcp-echo-server'));
  return {
    at: Date.now(),
    agentHostBytes: hosts.reduce((sum, host) => sum + host.bytes, 0),
    mcpServerBytes: servers.reduce((sum, server) => sum + server.bytes, 0),
    mcpServers: servers.length,
    appBytes: metrics.reduce((sum, metric) => sum + metric.kib * 1024, 0),
    byType,
    main,
  };
}

/**
 * Physical memory (bytes) of each pid (ADR-0063): macOS `phys_footprint` from `footprint`,
 * Windows private working set from the performance counters; both count the pages a process
 * alone holds, not the framework pages every Chromium process maps. Empty elsewhere.
 * @param {readonly number[]} pids
 * @returns {Promise<Record<string, number>>}
 */
export async function physicalFootprints(pids) {
  /** @type {Record<string, number>} */
  const by = {};
  if (process.platform === 'darwin') {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'piarc footprint '));
    try {
      const file = path.join(dir, 'footprint.json');
      execFileSync(
        'footprint',
        ['-f', 'bytes', '-j', file, ...pids.flatMap((pid) => ['-p', String(pid)])],
        { stdio: 'ignore' },
      );
      /** @type {unknown} */
      const report = JSON.parse(await readFile(file, 'utf8'));
      if (isRecord(report) && Array.isArray(report.processes)) {
        for (const p of report.processes) {
          if (isRecord(p) && typeof p.pid === 'number' && typeof p.footprint === 'number') {
            by[String(p.pid)] = p.footprint;
          }
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } else if (process.platform === 'win32') {
    const wanted = new Set(pids.map(String));
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object { "$($_.IDProcess) $($_.WorkingSetPrivate)" }',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    for (const line of out.trim().split(/\r?\n/u)) {
      const [pid, bytes] = line.trim().split(/\s+/u);
      if (pid !== undefined && wanted.has(pid) && bytes !== undefined) {
        by[pid] = (by[pid] ?? 0) + Number(bytes);
      }
    }
  }
  return by;
}

/**
 * The app's processes (no Agent Host) as `app-memory` measures them (ADR-0063): the physical
 * memory of each `getAppMetrics()` process, summed by type and in total (bytes); `undefined` on
 * a platform without a reading.
 * @param {import('@playwright/test').ElectronApplication} app
 * @returns {Promise<{ total: number, byType: Record<string, number> } | undefined>}
 */
export async function appFootprint(app) {
  const processes = await app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type })),
  );
  const by = await physicalFootprints(processes.map((p) => p.pid));
  if (Object.keys(by).length === 0) return undefined;
  /** @type {Record<string, number>} */
  const byType = {};
  let total = 0;
  for (const p of processes) {
    const bytes = by[String(p.pid)] ?? 0;
    byType[p.type] = (byType[p.type] ?? 0) + bytes;
    total += bytes;
  }
  return { total, byType };
}

/**
 * The value at quantile `q` of `values` (nearest rank).
 * @param {readonly number[]} values
 * @param {number} q
 */
export function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[rank] ?? Number.NaN;
}

/**
 * Minimum, median and maximum.
 * @param {readonly number[]} values
 */
export function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? Number.NaN,
    median: quantile(sorted, 0.5),
    max: sorted.at(-1) ?? Number.NaN,
  };
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
