// T44 probe: the first-token latency PiArc adds (architecture chapter 11). Against the same
// strict mock (which answers at once):
//
// - Pi alone: a Pi SDK session (`createAgentSession`, in-memory, no tools) in this Node process;
//   from `session.prompt()` to the first `text_delta`;
// - PiArc: the app (Core, Agent Host, the main process, the renderer); in the page, from
//   `window.piarc.prompt()` to the reply's first text in the transcript (one frame included).
//
// Each side answers `runs` prompts after a warm-up one; the value is the difference of the
// medians.
//
//   node scripts/perf/probe-first-token.mjs --form packaged --out <file.json>
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { isMain } from '../lib/repo.mjs';
import {
  launchApp,
  MOCK_MODEL,
  openWorkspace,
  quantile,
  seedModels,
  startMock,
  startSession,
} from './lib.mjs';

const RUNS = 20;

/**
 * Pi's prompt-to-first-text times (ms), `runs` + 1 prompts in one session; the first is dropped.
 * @param {string} root
 * @param {string} baseUrl
 * @param {number} runs
 */
async function piAlone(root, baseUrl, runs) {
  const agentDir = path.join(root, 'pi-alone');
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    path.join(agentDir, 'models.json'),
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
  await writeFile(
    path.join(agentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'piarc-mock', defaultModel: MOCK_MODEL.id }),
  );
  // Pi reads its agent directory from the environment when it needs it; the app launched
  // afterwards must not inherit it (its Agent Host checks the variable names its own).
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const pi = await import('@earendil-works/pi-coding-agent');
  const cwd = path.join(root, 'pi-alone-cwd');
  await mkdir(cwd, { recursive: true });
  const { session } = await pi.createAgentSession({
    cwd,
    agentDir,
    sessionManager: pi.SessionManager.inMemory(cwd),
    noTools: 'all',
  });
  /** @type {{ at: number | undefined }} */
  const first = { at: undefined };
  session.subscribe((event) => {
    if (
      first.at === undefined &&
      event.type === 'message_update' &&
      event.assistantMessageEvent.type === 'text_delta'
    ) {
      first.at = performance.now();
    }
  });
  /** @type {number[]} */
  const times = [];
  for (let i = 0; i <= runs; i++) {
    first.at = undefined;
    const started = performance.now();
    await session.prompt(
      i === 0 ? 'Start. [[piarc-scenario:perf-first-pi]]' : `Next ${String(i)}.`,
    );
    const at = /** @type {number | undefined} */ (first.at);
    if (at === undefined) throw new Error('Pi streamed no text');
    if (i > 0) times.push(at - started);
  }
  session.dispose();
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  return times;
}

/**
 * The app's prompt-to-first-text times (ms) for `runs` prompts after the session's first turn.
 * @param {string} root
 * @param {string} baseUrl
 * @param {'packaged' | 'dev'} form
 * @param {number} runs
 */
async function piarc(root, baseUrl, form, runs) {
  const userData = path.join(root, 'data');
  const workspace = path.join(root, 'work 工作区');
  await mkdir(workspace, { recursive: true });
  await seedModels(userData, baseUrl);
  const { app, page } = await launchApp(form, userData);
  try {
    await openWorkspace(app, page, workspace);
    await startSession(page, 'perf-first-app', { trust: true });
    await page.getByTestId('agent-message').filter({ hasText: 'Answer 0.' }).waitFor();
    const id = await page.getByTestId('conversation').getAttribute('data-session-id');
    if (id === null) throw new Error('no session id');
    /** @type {number[]} */
    const times = [];
    for (let i = 1; i <= runs; i++) {
      await page.getByTestId('composer').and(page.locator('[data-running="false"]')).waitFor();
      const ms = /** @type {number} */ (
        await page.evaluate(
          `new Promise((resolve, reject) => {
            // The list is virtual: look for this reply's text, not for one more row.
            const expected = /^Answer ${String(i)}\\.(?!\\d)/u;
            const started = performance.now();
            const observer = new MutationObserver(() => {
              const replies = document.querySelectorAll('[data-testid="agent-message"]');
              if ([...replies].some((r) => expected.test(r.textContent ?? ''))) {
                observer.disconnect();
                resolve(performance.now() - started);
              }
            });
            observer.observe(document.body, { subtree: true, childList: true, characterData: true });
            setTimeout(() => {
              observer.disconnect();
              const replies = document.querySelectorAll('[data-testid="agent-message"]');
              reject(new Error('no reply ' + String(expected) + ': the last shown is ' + JSON.stringify(replies[replies.length - 1]?.textContent ?? '')));
            }, 15000);
            window.piarc.prompt(${JSON.stringify(id)}, 'Next ${String(i)}.').catch(reject);
          })`,
        )
      );
      times.push(ms);
    }
    return times;
  } finally {
    await app.close().catch(() => undefined);
  }
}

/**
 * @param {{ form: 'packaged' | 'dev' }} options
 */
export async function measure(options) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'piarc perf 首字 ')));
  const scenarios = path.join(root, 'scenarios');
  await mkdir(scenarios);
  const answers = Array.from({ length: RUNS + 2 }, (_, i) => ({ text: `Answer ${String(i)}.` }));
  for (const id of ['perf-first-pi', 'perf-first-app']) {
    await writeFile(path.join(scenarios, `${id}.json`), JSON.stringify({ id, steps: answers }));
  }
  const mock = await startMock(scenarios);
  try {
    // The app first: the Pi SDK session changes this process's state (its environment).
    const app = await piarc(root, mock.baseUrl, options.form, RUNS);
    const alone = await piAlone(root, mock.baseUrl, RUNS);
    const [aloneMs, appMs] = [quantile(alone, 0.5), quantile(app, 0.5)];
    return {
      values: { 'first-token-overhead': appMs - aloneMs },
      samples: RUNS,
      detail: { piAloneMs: alone, piarcMs: app, medians: { piAlone: aloneMs, piarc: appMs } },
    };
  } finally {
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
  console.log(JSON.stringify({ values: result.values, medians: result.detail.medians }, null, 2));
  if (values.out !== undefined) {
    await mkdir(path.dirname(values.out), { recursive: true });
    await writeFile(values.out, `${JSON.stringify(result, null, 2)}\n`);
  }
  // The Pi SDK session may keep handles open.
  process.exit(0);
}

if (isMain(import.meta.url)) await main();
