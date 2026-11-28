// T44 probe: idle CPU (architecture chapter 11). A session is open with the terminal panel
// showing a shell, nothing runs. For `seconds` with the window shown and then hidden, the CPU
// time of every app process (`getAppMetrics().cpu.cumulativeCPUUsage`) and of the Agent Host
// (`ps` / CIM) is summed and reported as a percentage of one core. While hidden, the page's
// animation-frame callbacks and the terminal panel's frames are counted: both must stay 0.
//
//   node scripts/perf/probe-idle.mjs --form packaged --lane nightly --out <file.json>
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { isMain } from '../lib/repo.mjs';
import {
  childProcesses,
  launchApp,
  openWorkspace,
  seedModels,
  sleep,
  startMock,
  startSession,
} from './lib.mjs';

/**
 * CPU seconds a process used so far (`ps` on macOS, CIM on Windows).
 * @param {number} pid
 */
export function cpuSeconds(pid) {
  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${String(pid)}"; [double]($p.UserModeTime + $p.KernelModeTime) / 1e7`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return Number(out.trim());
  }
  const out = execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  // [[dd-]hh:]mm:ss.ss
  const [days, rest] = out.includes('-') ? out.split('-') : ['0', out];
  const parts = (rest ?? '0').split(':').map(Number);
  const seconds = parts.reduce((sum, part) => sum * 60 + part, 0);
  return Number(days) * 86_400 + seconds;
}

/**
 * CPU seconds of the app's processes (by type) and the Agent Host.
 * @param {import('@playwright/test').ElectronApplication} app
 * @param {number} mainPid
 * @returns {Promise<Record<string, number>>}
 */
async function cpuByProcess(app, mainPid) {
  const metrics = await app.evaluate(({ app: electronApp }) =>
    electronApp
      .getAppMetrics()
      .map((m) => ({ type: m.type, seconds: m.cpu.cumulativeCPUUsage ?? Number.NaN })),
  );
  /** @type {Record<string, number>} */
  const by = {};
  for (const m of metrics) by[m.type] = (by[m.type] ?? 0) + m.seconds;
  by.AgentHost = childProcesses(mainPid, 'agent-host').reduce(
    (sum, h) => sum + cpuSeconds(h.pid),
    0,
  );
  return by;
}

/**
 * Percent of one core each process used between `start` and `end` over `seconds`.
 * @param {Record<string, number>} start
 * @param {Record<string, number>} end
 * @param {number} seconds
 */
function percent(start, end, seconds) {
  return Object.fromEntries(
    Object.keys(end).map((k) => [k, (((end[k] ?? 0) - (start[k] ?? 0)) / seconds) * 100]),
  );
}

/** @param {Record<string, number>} by */
const sum = (by) => Object.values(by).reduce((a, b) => a + b, 0);

/**
 * @param {{ form: 'packaged' | 'dev', lane: string }} options
 */
export async function measure(options) {
  const seconds = options.lane === 'pr' ? 15 : 60;
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'piarc perf 空闲 ')));
  const userData = path.join(root, 'data');
  const workspace = path.join(root, 'work 工作区');
  await mkdir(workspace, { recursive: true });
  const scenario = path.join(root, 'idle.json');
  await writeFile(scenario, JSON.stringify({ id: 'perf-idle', steps: [{ text: 'Ready.' }] }));
  const mock = await startMock(scenario);
  await seedModels(userData, mock.baseUrl);
  const { app, page } = await launchApp(options.form, userData);
  try {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800);
    });
    await openWorkspace(app, page, workspace);
    await startSession(page, 'perf-idle', { trust: true });
    await page.getByTestId('agent-message').filter({ hasText: 'Ready.' }).waitFor();
    await page.keyboard.press('Control+Backquote');
    await page.getByTestId('terminal-panel').waitFor();
    // The shell drew its prompt; then nothing should happen.
    await page.waitForFunction(
      '(globalThis.__piarcTerminalPanel?.stats().framesReceived ?? 0) > 0',
    );
    await page.getByTestId('composer-input').click();
    await sleep(5000);
    const mainPid = await app.evaluate(() => process.pid);

    const visibleStart = await cpuByProcess(app, mainPid);
    await sleep(seconds * 1000);
    const visible = percent(visibleStart, await cpuByProcess(app, mainPid), seconds);

    // Count the page's animation-frame callbacks from here on.
    await page.evaluate(`(() => {
      const raf = window.requestAnimationFrame.bind(window);
      window.__piarcFrames = 0;
      window.requestAnimationFrame = (callback) => raf((t) => { window.__piarcFrames += 1; callback(t); });
    })()`);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.hide();
    });
    await sleep(2000);
    const before = /** @type {{ raf: number, terminal: number }} */ (
      await page.evaluate(
        '({ raf: window.__piarcFrames, terminal: globalThis.__piarcTerminalPanel?.stats().framesReceived ?? 0 })',
      )
    );
    const hiddenStart = await cpuByProcess(app, mainPid);
    await sleep(seconds * 1000);
    const hidden = percent(hiddenStart, await cpuByProcess(app, mainPid), seconds);
    const after = /** @type {{ raf: number, terminal: number }} */ (
      await page.evaluate(
        '({ raf: window.__piarcFrames, terminal: globalThis.__piarcTerminalPanel?.stats().framesReceived ?? 0 })',
      )
    );
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.show();
    });
    const frames = { raf: after.raf - before.raf, terminal: after.terminal - before.terminal };
    return {
      values: {
        'idle-cpu-visible': sum(visible),
        'idle-cpu-hidden': sum(hidden),
        'hidden-frames': frames.raf + frames.terminal,
      },
      samples: seconds,
      detail: { hiddenFrames: frames, percentByProcess: { visible, hidden } },
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
      lane: { type: 'string', default: 'nightly' },
      out: { type: 'string' },
    },
  });
  const result = await measure({
    form: values.form === 'dev' ? 'dev' : 'packaged',
    lane: values.lane,
  });
  console.log(JSON.stringify(result, null, 2));
  if (values.out !== undefined) {
    await mkdir(path.dirname(values.out), { recursive: true });
    await writeFile(values.out, `${JSON.stringify(result, null, 2)}\n`);
  }
}

if (isMain(import.meta.url)) await main();
