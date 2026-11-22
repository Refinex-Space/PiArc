// T44 probe: recovery from faults (architecture chapter 11).
//
// - Agent Host: with a session idle, its Agent Host is killed; from the kill until a new prompt
//   to the session has a reply on screen (Core restarts the host and resumes the session).
// - Renderer: while the mock streams a long reply, the window's renderer is reloaded, and in a
//   second turn crashed (the main process reloads it, T44); from the fault until the session's
//   transcript shows the reply again. The turn is not interrupted: it ends with the mock having
//   answered exactly the requests the scenario expects (no retry). The value is the slower of
//   the two.
//
// Everything after the fault goes through the main process (`executeJavaScript`): Playwright
// keeps a crashed page's target.
//
//   node scripts/perf/probe-recovery.mjs --form packaged --out <file.json>
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { isMain } from '../lib/repo.mjs';
import {
  childProcesses,
  launchApp,
  openWorkspace,
  requestCounts,
  seedModels,
  sleep,
  startMock,
  startSession,
} from './lib.mjs';

const LONG = 'The reply goes on while the window recovers. '.repeat(40);

/** @type {Record<string, object>} */
const SCENARIOS = {
  'perf-recover': {
    id: 'perf-recover',
    steps: [
      { text: 'Ready.' },
      ...Array.from({ length: 10 }, (_, i) => ({ text: `Answer ${String(i)}.` })),
    ],
  },
  'perf-reload': {
    id: 'perf-reload',
    steps: [
      { text: 'Ready.' },
      { text: `${LONG} First end.`, chunk_chars: 10, chunk_delay_ms: 40 },
      { text: `${LONG} Second end.`, chunk_chars: 10, chunk_delay_ms: 40 },
    ],
  },
};

/**
 * Evaluates `script` in the window's page from the main process.
 * @param {import('@playwright/test').ElectronApplication} app
 * @param {string} script
 * @returns {Promise<unknown>}
 */
function inPage(app, script) {
  return app.evaluate(
    ({ BrowserWindow }, code) =>
      BrowserWindow.getAllWindows()[0]?.webContents.executeJavaScript(code),
    script,
  );
}

/**
 * Polls `test` every 20 ms until it is true; resolves with the time it became true.
 * @param {() => Promise<boolean>} test
 * @param {number} timeout
 */
async function until(test, timeout) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await test().catch(() => false)) return Date.now();
    if (Date.now() > end) throw new Error('timed out');
    await sleep(20);
  }
}

const replies = `document.querySelectorAll('[data-testid="agent-message"]').length`;
const idleNow = `document.querySelector('[data-testid="composer"]')?.getAttribute('data-running') === 'false'`;

/**
 * Whether the window shows session `sessionId`'s transcript (clicking its row in the sidebar
 * when another view is shown); with `replies` > 0, also that many streamed replies (the one
 * being streamed during the fault is the last).
 * @param {import('@playwright/test').ElectronApplication} app
 * @param {string} sessionId
 * @param {number} replies
 */
async function sessionShown(app, sessionId, replies) {
  return (
    (await inPage(
      app,
      `(() => {
        // A document from before the fault does not count.
        if (window.__piarcBeforeFault === true) return false;
        const view = document.querySelector('[data-testid="conversation"]');
        if (view?.getAttribute('data-session-id') === ${JSON.stringify(sessionId)}) {
          const rows = document.querySelectorAll('[data-testid="user-message"]').length > 0;
          const streamed = [...document.querySelectorAll('[data-testid="agent-message"]')].filter((m) => m.textContent.includes('recovers')).length;
          return rows && streamed >= ${String(replies)};
        }
        document.querySelector('[data-testid="session-row"][data-session-id=${JSON.stringify(sessionId)}] [data-testid="session-title"]')?.click();
        return false;
      })()`,
    )) === true
  );
}

/**
 * @param {{ form: 'packaged' | 'dev' }} options
 */
export async function measure(options) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'piarc perf 恢复 ')));
  const userData = path.join(root, 'data');
  const workspace = path.join(root, 'work 工作区');
  await mkdir(workspace, { recursive: true });
  const scenarios = path.join(root, 'scenarios');
  await mkdir(scenarios);
  for (const [id, value] of Object.entries(SCENARIOS)) {
    await writeFile(path.join(scenarios, `${id}.json`), JSON.stringify(value));
  }
  const mock = await startMock(scenarios);
  await seedModels(userData, mock.baseUrl);
  const { app, page } = await launchApp(options.form, userData);
  try {
    await openWorkspace(app, page, workspace);
    const mainPid = await app.evaluate(() => process.pid);

    // The Agent Host.
    await startSession(page, 'perf-recover', { trust: true });
    await page.getByTestId('agent-message').filter({ hasText: 'Ready.' }).waitFor();
    const recoverId = await page.getByTestId('conversation').getAttribute('data-session-id');
    if (recoverId === null) throw new Error('no session id');
    await until(async () => (await inPage(app, idleNow)) === true, 30_000);
    const before = Number(await inPage(app, replies));
    const hosts = childProcesses(mainPid, 'agent-host');
    if (hosts.length === 0) throw new Error('no Agent Host process');
    const killedAt = Date.now();
    for (const host of hosts) process.kill(host.pid, 'SIGKILL');
    // Core takes the prompt once it can (retry only a refusal), then the reply shows.
    await until(
      () =>
        inPage(app, `window.piarc.prompt(${JSON.stringify(recoverId)}, 'Again.')`).then(
          () => true,
          () => false,
        ),
      30_000,
    );
    const answeredAt = await until(async () => Number(await inPage(app, replies)) > before, 30_000);
    const agentHost = answeredAt - killedAt;

    // The renderer: a reload, then a crash, each during a streamed reply.
    await startSession(page, 'perf-reload');
    await page.getByTestId('agent-message').filter({ hasText: 'Ready.' }).waitFor();
    const reloadId = await page.getByTestId('conversation').getAttribute('data-session-id');
    if (reloadId === null) throw new Error('no session id');
    /** @type {number[]} */
    const renderer = [];
    /** @type {number[]} */
    const replyShown = [];
    for (const fault of ['reload', 'crash']) {
      await until(async () => (await inPage(app, idleNow)) === true, 30_000);
      const text = Number(await inPage(app, replies));
      // Core may still be closing the previous turn: retry a refusal.
      await until(
        () =>
          inPage(app, `window.piarc.prompt(${JSON.stringify(reloadId)}, 'Go on.')`).then(
            () => true,
            () => false,
          ),
        10_000,
      );
      await until(async () => Number(await inPage(app, replies)) > text, 20_000);
      await sleep(1000);
      await inPage(app, 'window.__piarcBeforeFault = true');
      const faultAt = Date.now();
      await app.evaluate(({ BrowserWindow }, how) => {
        const contents = BrowserWindow.getAllWindows()[0]?.webContents;
        if (how === 'crash') contents?.forcefullyCrashRenderer();
        else contents?.reload();
      }, fault);
      const shownAt = await until(() => sessionShown(app, reloadId, 0), 20_000);
      renderer.push(shownAt - faultAt);
      const replyAt = await until(
        () => sessionShown(app, reloadId, fault === 'reload' ? 1 : 2),
        30_000,
      );
      replyShown.push(replyAt - faultAt);
      // The turn goes on to its end.
      await until(
        async () =>
          (await inPage(
            app,
            `document.querySelector('[data-testid="composer"]')?.getAttribute('data-running') === 'false' && document.body.textContent.includes(${JSON.stringify(fault === 'reload' ? 'First end.' : 'Second end.')})`,
          )) === true,
        60_000,
      );
    }
    const counts = await requestCounts(mock.baseUrl);
    if (counts['perf-reload'] !== 3) {
      throw new Error(`the turns were interrupted: ${JSON.stringify(counts)}`);
    }
    return {
      values: {
        'agent-host-recovery': agentHost,
        'renderer-recovery': Math.max(...renderer),
      },
      samples: 1,
      detail: {
        agentHostMs: agentHost,
        rendererMs: { reload: renderer[0], crash: renderer[1] },
        // The reply streamed during the fault shows again only when its turn ends (I189).
        streamingReplyMs: { reload: replyShown[0], crash: replyShown[1] },
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
      lane: { type: 'string', default: 'nightly' },
      out: { type: 'string' },
    },
  });
  const result = await measure({ form: values.form === 'dev' ? 'dev' : 'packaged' });
  console.log(JSON.stringify(result, null, 2));
  if (values.out !== undefined) {
    await mkdir(path.dirname(values.out), { recursive: true });
    await writeFile(values.out, `${JSON.stringify(result, null, 2)}\n`);
  }
}

if (isMain(import.meta.url)) await main();
