// B5.6 probe: the built-in browser (design addendum B2.4.3, B1.5.2, B5.6). A session is open
// with the preview showing a page of a local fixture server; the agent's script host and the
// development build's test hooks (`browser`, `browserScript`) drive it:
//
// - `browser-snapshot-1k`, `browser-snapshot-10k`: p95 of `page.snapshot({ scope: "full_page" })`
//   in an agent page of 1,000 and 10,000 nodes, timed inside the script host;
// - `browser-tab-switch`: p95 from selecting the other tab (the panel's `selectTab`) to the main
//   process placing its view on the panel (`browserState().tabs[].visible`), polled every 2 ms
//   in the main process;
// - `browser-occlusion`: p95 from opening the panel's "More" menu over the page to the still frame
//   (`#browser-occlusion`) being on screen, timed in the renderer;
// - `browser-idle-cpu`: with the preview showing one user tab and two hidden tabs (a user tab
//   whose page runs a timer and an animation, and an agent tab the finished script left
//   parked), the app's processes plus the Agent Host, percent of one core over 60 s: hidden pages
//   are throttled (B5.6).
//
//   node scripts/perf/probe-browser.mjs --form packaged --lane nightly --out <file.json>
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { isMain } from '../lib/repo.mjs';
import {
  childProcesses,
  launchApp,
  openWorkspace,
  quantile,
  seedModels,
  sleep,
  startMock,
  startSession,
} from './lib.mjs';
import { cpuSeconds } from './probe-idle.mjs';

/**
 * A page of about `n` nodes: list items with a link each.
 * @param {number} n
 */
export function nodesPage(n) {
  const items = [];
  for (let i = 0; i < Math.ceil(n / 3); i++) {
    items.push(`<li><a href="#item-${String(i)}">Item ${String(i)}</a></li>`);
  }
  return `<!doctype html><title>Nodes ${String(n)}</title><ul>${items.join('')}</ul>`;
}

/** @type {Record<string, string | undefined>} */
const PAGES = {
  '/': '<!doctype html><title>Perf home</title><p>Home</p>',
  '/busy':
    '<!doctype html><title>Busy</title><style>@keyframes s{to{transform:rotate(1turn)}}div{width:40px;height:40px;background:#888;animation:s 1s linear infinite}</style><div></div><p id="n">0</p><script>let n=0;setInterval(()=>{document.getElementById("n").textContent=String(++n)},50)</script>',
  '/nodes-1k': nodesPage(1000),
  '/nodes-10k': nodesPage(10000),
};

/** @returns {Promise<{ origin: string, close: () => Promise<void> }>} */
async function fixtureServer() {
  const server = createServer((request, response) => {
    const body = PAGES[request.url ?? '/'];
    if (body === undefined) {
      response.writeHead(404).end('missing');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(undefined);
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve(undefined);
        });
      }),
  };
}

/**
 * Runs a `Browser` script through the development test hook; answers its output.
 * @param {import('@playwright/test').ElectronApplication} app
 * @param {string} sessionId
 * @param {string} script
 */
async function runScript(app, sessionId, script) {
  const answer = await app.evaluate(
    (_electron, args) => {
      const hooks = globalThis.__piarcTestHooks;
      if (hooks === undefined) throw new Error('No test hooks: build the development flavor');
      return hooks.browserScript(args.sessionId, args.script, 300_000);
    },
    { sessionId, script },
  );
  if (answer === null) throw new Error('the script host did not answer');
  if (answer.error !== undefined) throw new Error(`script failed: ${answer.error.message}`);
  return answer.output;
}

/**
 * Snapshot times (ms) of `runs` full-page snapshots of `url` in an agent page.
 * @param {import('@playwright/test').ElectronApplication} app
 * @param {string} sessionId
 * @param {string} url
 * @param {number} runs
 */
async function snapshotTimes(app, sessionId, url, runs) {
  const output = await runScript(
    app,
    sessionId,
    `const task = await taskSpace("perf");
const page = task.page("p1");
await page.goto(${JSON.stringify(url)});
const times = [];
for (let i = 0; i < ${String(runs)}; i++) {
  const start = performance.now();
  await page.snapshot({ scope: "full_page" });
  times.push(performance.now() - start);
}
console.log("PERF " + JSON.stringify(times));`,
  );
  const match = /PERF (\[[^\]]*\])/u.exec(output);
  if (match?.[1] === undefined) throw new Error('the snapshot script printed no times');
  /** @type {unknown} */
  const times = JSON.parse(match[1]);
  return Array.isArray(times) ? times.filter((t) => typeof t === 'number') : [];
}

/**
 * The session's browser state through the development test hook.
 * @param {import('@playwright/test').ElectronApplication} app
 * @param {string} sessionId
 * @returns {Promise<import('../../apps/desktop/src/shared/test-hooks.js').BrowserObservation>}
 */
async function observe(app, sessionId) {
  return app.evaluate((_electron, id) => {
    const hooks = globalThis.__piarcTestHooks;
    if (hooks === undefined) throw new Error('No test hooks: build the development flavor');
    return hooks.browser(id);
  }, sessionId);
}

/**
 * Milliseconds from selecting tab `tab` to its view being on the panel.
 * @param {import('@playwright/test').ElectronApplication} app
 * @param {import('@playwright/test').Page} page
 * @param {string} sessionId
 * @param {string} tab
 */
async function switchTime(app, page, sessionId, tab) {
  const shown = app.evaluate(
    async (_electron, args) => {
      const hooks = globalThis.__piarcTestHooks;
      if (hooks === undefined) throw new Error('No test hooks: build the development flavor');
      const start = performance.now();
      for (;;) {
        const state = await hooks.browser(args.sessionId);
        if (state.tabs.find((t) => t.id === args.tab)?.visible === true) {
          return performance.now() - start;
        }
        if (performance.now() - start > 10_000) return Number.NaN;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    },
    { sessionId, tab },
  );
  await page.evaluate(
    `window.piarc.browser(${JSON.stringify(sessionId)}, { op: 'selectTab', tab: ${JSON.stringify(tab)} })`,
  );
  return shown;
}

/**
 * Milliseconds from opening the "More" menu over the page to the still frame on screen.
 * @param {import('@playwright/test').Page} page
 */
async function occlusionTime(page) {
  // Timed in the page: the menu opens and the still frame appears without a Playwright round
  // trip in between.
  /** @type {unknown} */
  const ms = await page.evaluate(`new Promise((resolve) => {
    const button = document.querySelector('[data-testid="browser-more"]');
    if (!button) { resolve(Number.NaN); return; }
    const start = performance.now();
    button.click();
    const check = () => {
      const still = document.querySelector('[data-testid="browser-occlusion"]');
      if (still && still.offsetWidth > 0) resolve(performance.now() - start);
      else if (performance.now() - start > 10000) resolve(Number.NaN);
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  })`);
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    '!document.querySelector(\'[data-testid="browser-occlusion"]\')?.offsetWidth',
  );
  return typeof ms === 'number' ? ms : Number.NaN;
}

/**
 * CPU seconds of the app's processes and the Agent Host so far.
 * @param {import('@playwright/test').ElectronApplication} app
 * @param {number} mainPid
 */
async function cpuTotal(app, mainPid) {
  const metrics = await app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().map((m) => m.cpu.cumulativeCPUUsage ?? 0),
  );
  const hosts = childProcesses(mainPid, 'agent-host').reduce(
    (sum, h) => sum + cpuSeconds(h.pid),
    0,
  );
  return metrics.reduce((a, b) => a + b, 0) + hosts;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} url
 */
async function userOpens(page, url) {
  const input = page.getByTestId('browser-address');
  await input.click();
  await input.fill(url);
  await input.press('Enter');
}

/**
 * @param {{ form: 'packaged' | 'dev', lane: string }} options
 */
export async function measure(options) {
  const runs = options.lane === 'pr' ? 5 : 20;
  const seconds = options.lane === 'pr' ? 15 : 60;
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'piarc perf 浏览器 ')));
  const userData = path.join(root, 'data');
  const workspace = path.join(root, 'work 工作区');
  await mkdir(workspace, { recursive: true });
  const scenario = path.join(root, 'browser.json');
  await writeFile(scenario, JSON.stringify({ id: 'perf-browser', steps: [{ text: 'Ready.' }] }));
  const mock = await startMock(scenario);
  await seedModels(userData, mock.baseUrl);
  const server = await fixtureServer();
  const { app, page } = await launchApp(options.form, userData);
  try {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900);
    });
    await openWorkspace(app, page, workspace);
    await startSession(page, 'perf-browser', { trust: true });
    await page.getByTestId('agent-message').filter({ hasText: 'Ready.' }).waitFor();
    const sessionId = await page.getByTestId('conversation').getAttribute('data-session-id');
    if (sessionId === null) throw new Error('the conversation has no session id');
    await page.getByTestId('tool-preview').click();
    await page.getByTestId('browser-start').waitFor();
    // The user opens the fixture's port: the agent's pages may use it (B2.6.2).
    await userOpens(page, `${server.origin}/`);
    await page.getByTestId('browser-tab').filter({ hasText: 'Perf home' }).waitFor();

    const snapshot1k = await snapshotTimes(app, sessionId, `${server.origin}/nodes-1k`, runs);
    const snapshot10k = await snapshotTimes(app, sessionId, `${server.origin}/nodes-10k`, runs);

    // A second user tab with a busy page; switch between the two user tabs.
    await page.getByTestId('browser-new-tab').click();
    await userOpens(page, `${server.origin}/busy`);
    await page.getByTestId('browser-tab').filter({ hasText: 'Busy' }).waitFor();
    const userTabs = (await observe(app, sessionId)).tabs.filter((t) => t.openedBy === 'user');
    const [home, busy] = userTabs;
    if (home === undefined || busy === undefined) throw new Error('two user tabs expected');
    /** @type {number[]} */
    const switches = [];
    for (let i = 0; i < runs; i++) {
      switches.push(await switchTime(app, page, sessionId, i % 2 === 0 ? home.id : busy.id));
      await sleep(100);
    }
    await switchTime(app, page, sessionId, home.id);
    await sleep(500);

    /** @type {number[]} */
    const occlusions = [];
    for (let i = 0; i < runs; i++) {
      occlusions.push(await occlusionTime(page));
      await sleep(100);
    }

    // Idle: the home tab shown, the busy user tab and the agent's tab hidden.
    await page.getByTestId('composer-input').click();
    await sleep(5000);
    const mainPid = await app.evaluate(() => process.pid);
    const start = await cpuTotal(app, mainPid);
    await sleep(seconds * 1000);
    const idle = (((await cpuTotal(app, mainPid)) - start) / seconds) * 100;

    return {
      values: {
        'browser-snapshot-1k': quantile(snapshot1k, 0.95),
        'browser-snapshot-10k': quantile(snapshot10k, 0.95),
        'browser-tab-switch': quantile(switches, 0.95),
        'browser-occlusion': quantile(occlusions, 0.95),
        'browser-idle-cpu': idle,
      },
      samples: runs,
      detail: { snapshot1k, snapshot10k, switches, occlusions },
    };
  } finally {
    await app.close().catch(() => undefined);
    await server.close();
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
