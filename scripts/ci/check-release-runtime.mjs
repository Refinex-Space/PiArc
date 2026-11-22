// T45-A12 (THR-12, I10): the packaged release build cannot be used as a general runtime or be
// driven from outside. Each probe starts the app with a fresh user data directory:
//
// - run-as-node            ELECTRON_RUN_AS_NODE=1 with `-e <script>`: the script does not run;
// - node-options           NODE_OPTIONS=--require <module>: the module is not loaded;
// - inspect                --inspect=0: no "Debugger listening" before Core is up;
// - remote-debugging-port  --remote-debugging-port=<port>: the app exits non-zero and the port
//                          never answers /json/version.
//
// The first three wait for Core's log file in the user data directory: the app booted as an
// app, and whatever the switch would have done happens before that. Each probe has a positive
// control on the Electron of node_modules (no fuses, no release check), which must show the
// effect, so a probe that could not see it fails instead of passing.
//
// Usage: node scripts/ci/check-release-runtime.mjs [--flavor release] [--arch <arch>] [--app <path>]
// (CI desktop job after `npm run package:desktop` and `npm run check:fuses`). Exit code 1 when a
// probe or a control fails.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { parseBuildFlavor } from '../../apps/desktop/fuses.mjs';
import { isMain } from '../lib/repo.mjs';
import { packagedAppPath, productName } from './check-fuses.mjs';

/** The probes, by check id (the names `tests/security/threats.yaml` refers to). */
export const PROBES = ['run-as-node', 'node-options', 'inspect', 'remote-debugging-port'];

const MARKER = 'PIARC-T45-RUNTIME-PROBE';
const BOOT_LIMIT_MS = 60_000;

/**
 * The executable inside a packaged app.
 * @param {string} app the .app bundle or the .exe
 */
export function executableOf(app) {
  if (process.platform !== 'darwin') return app;
  return path.join(app, 'Contents', 'MacOS', path.basename(app, '.app'));
}

/** @returns {string} */
function electronBinary() {
  const binary = /** @type {unknown} */ (createRequire(import.meta.url)('electron'));
  if (typeof binary !== 'string') throw new Error('the electron package gave no executable path');
  return binary;
}

/** @returns {Promise<number>} */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether `port` answers Chromium's DevTools version endpoint.
 * @param {number} port
 */
async function debuggerAnswers(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Starts `command`, collecting its output; `stop()` ends its process tree.
 * @param {string} command
 * @param {string[]} args
 * @param {Record<string, string>} env
 */
function start(command, args, env) {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const run = { output: '', exited: false, code: /** @type {number | null} */ (null) };
  child.stdout.on('data', (/** @type {Buffer} */ b) => (run.output += b.toString('utf8')));
  child.stderr.on('data', (/** @type {Buffer} */ b) => (run.output += b.toString('utf8')));
  const done = new Promise((resolve) => {
    child.on('exit', (code) => {
      run.exited = true;
      run.code = code;
      resolve(undefined);
    });
  });
  const stop = async () => {
    if (run.exited || child.pid === undefined) return;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
    await Promise.race([done, delay(10_000)]);
  };
  return { run, done, stop };
}

/**
 * Waits until Core wrote its log file in `userData` (the app is up) or the process exited.
 * @param {string} userData
 * @param {{ exited: boolean }} run
 */
async function booted(userData, run) {
  const logs = path.join(userData, 'logs');
  for (let waited = 0; waited < BOOT_LIMIT_MS; waited += 200) {
    if (existsSync(logs) && readdirSync(logs).some((n) => n.startsWith('core-'))) return true;
    if (run.exited) return false;
    await delay(200);
  }
  return false;
}

/**
 * One probe against the packaged app: `{ ok, detail }`.
 * @param {string} probe
 * @param {string} exe
 * @param {string} work a scratch directory
 */
export async function probeApp(probe, exe, work) {
  const userData = mkdtempSync(path.join(work, 'user data 数据 '));
  const dataArg = `--user-data-dir=${userData}`;
  const preload = path.join(work, 'preload.cjs');
  const loaded = path.join(work, `node-options-loaded-${String(Date.now())}`);
  writeFileSync(preload, `require('fs').writeFileSync(${JSON.stringify(loaded)}, 'x');\n`);
  /** @type {Record<string, { args: string[], env: Record<string, string> }>} */
  const launches = {
    'run-as-node': {
      args: ['-e', `process.stdout.write(${JSON.stringify(MARKER)})`, dataArg],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    },
    'node-options': { args: [dataArg], env: { NODE_OPTIONS: `--require "${preload}"` } },
    inspect: { args: ['--inspect=0', dataArg], env: {} },
  };
  if (probe === 'remote-debugging-port') {
    const port = await freePort();
    const app = start(exe, [`--remote-debugging-port=${String(port)}`, dataArg], {});
    let answered = false;
    for (let waited = 0; waited < 15_000 && !app.run.exited; waited += 250) {
      answered ||= await debuggerAnswers(port);
      await delay(250);
    }
    await app.stop();
    const ok = !answered && app.run.exited && app.run.code !== 0;
    return {
      ok,
      detail: `exited ${String(app.run.exited)} with ${String(app.run.code)}, /json/version answered: ${String(answered)}`,
    };
  }
  const launch = launches[probe];
  if (launch === undefined) throw new Error(`unknown probe ${probe}`);
  const app = start(exe, launch.args, launch.env);
  const up = await booted(userData, app.run);
  await app.stop();
  const effect =
    probe === 'run-as-node'
      ? app.run.output.includes(MARKER)
      : probe === 'node-options'
        ? existsSync(loaded)
        : app.run.output.includes('Debugger listening');
  return {
    ok: up && !effect,
    detail: `app came up: ${String(up)}, switch took effect: ${String(effect)}`,
  };
}

/**
 * The positive control of a probe on the Electron of node_modules: `{ ok, detail }`.
 * @param {string} probe
 * @param {string} work
 */
export async function control(probe, work) {
  const electron = electronBinary();
  const preload = path.join(work, 'control-preload.cjs');
  const loaded = path.join(work, `control-loaded-${String(Date.now())}`);
  writeFileSync(preload, `require('fs').writeFileSync(${JSON.stringify(loaded)}, 'x');\n`);
  if (probe === 'remote-debugging-port') {
    const port = await freePort();
    const userData = mkdtempSync(path.join(work, 'control data '));
    const bare = start(
      electron,
      [`--remote-debugging-port=${String(port)}`, `--user-data-dir=${userData}`],
      {},
    );
    let answered = false;
    for (let waited = 0; waited < 20_000 && !answered && !bare.run.exited; waited += 250) {
      answered = await debuggerAnswers(port);
      await delay(250);
    }
    await bare.stop();
    return { ok: answered, detail: `/json/version answered: ${String(answered)}` };
  }
  const script = 'setTimeout(() => {}, 1500)';
  /** @type {Record<string, { args: string[], env: Record<string, string> }>} */
  const launches = {
    'run-as-node': {
      args: ['-e', `process.stdout.write(${JSON.stringify(MARKER)})`],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    },
    'node-options': {
      args: ['-e', script],
      env: { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: `--require "${preload}"` },
    },
    inspect: { args: ['--inspect=0', '-e', script], env: { ELECTRON_RUN_AS_NODE: '1' } },
  };
  const launch = launches[probe];
  if (launch === undefined) throw new Error(`unknown probe ${probe}`);
  const run = start(electron, launch.args, launch.env);
  await Promise.race([run.done, delay(20_000)]);
  await run.stop();
  const effect =
    probe === 'run-as-node'
      ? run.run.output.includes(MARKER)
      : probe === 'node-options'
        ? existsSync(loaded)
        : run.run.output.includes('Debugger listening');
  return { ok: effect, detail: `switch took effect: ${String(effect)}` };
}

async function main() {
  const { values } = parseArgs({
    options: {
      flavor: { type: 'string' },
      arch: { type: 'string', default: process.arch },
      app: { type: 'string' },
    },
  });
  const flavor = parseBuildFlavor(values.flavor);
  if (flavor !== 'release') throw new Error('the probes check the release build');
  const app = values.app ?? packagedAppPath(flavor, productName(), process.platform, values.arch);
  const exe = executableOf(app);
  if (!existsSync(exe)) {
    throw new Error(`${exe} is missing; run npm run package:desktop first`);
  }
  const work = mkdtempSync(path.join(os.tmpdir(), 'piarc release probes 探测 '));
  let failed = 0;
  try {
    for (const probe of PROBES) {
      const positive = await control(probe, work);
      const result = await probeApp(probe, exe, work);
      /** @type {Array<{ label: string, ok: boolean, detail: string }>} */
      const outcomes = [
        { label: `control ${probe} (node_modules Electron shows the effect)`, ...positive },
        { label: `${probe} has no effect on the release build`, ...result },
      ];
      for (const { label, ok, detail } of outcomes) {
        console.log(`${ok ? '✔' : '✖'} ${label}: ${detail}`);
        if (!ok) failed += 1;
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (failed > 0) {
    console.error(`${String(failed)} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('release runtime probes passed');
  }
}

if (isMain(import.meta.url)) {
  await main();
}
