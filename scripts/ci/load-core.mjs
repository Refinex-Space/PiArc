// Load test of prebuilt Core modules (T04, ADR-0014): loads each module in plain Node and in
// Electron on the current machine and runs its event channel (scripts/ci/core-load-check.mjs).
//
//   node scripts/ci/load-core.mjs --module <file.node> [--module <file.node> ...]
//                                 [--electron <binary>] [--skip-node]
//
// --electron  Electron executable to use (default: the one in node_modules, which
//             `node node_modules/electron/install.js` downloads for this machine)
// --skip-node only load in Electron, for a module of another architecture than this Node
//             (an x64 Electron under Rosetta 2, for example)
// Exit code 0 when every load passed.
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { isMain, isRecord, repoRoot } from '../lib/repo.mjs';
import { RESULT_PREFIX, checkCore } from './core-load-check.mjs';

/** @typedef {import('./core-load-check.mjs').CheckResult} CheckResult */

const CHECK_SCRIPT = path.join(repoRoot, 'scripts', 'ci', 'core-load-check.mjs');

function defaultElectron() {
  /** @type {unknown} */
  const binary = createRequire(path.join(repoRoot, 'apps', 'desktop', 'package.json'))('electron');
  if (typeof binary !== 'string') {
    throw new Error('the electron package did not resolve to an executable path');
  }
  return binary;
}

/**
 * Runs Electron and resolves with everything it printed once it exits.
 * @param {string} electron
 * @param {string[]} args
 * @returns {Promise<string>}
 */
function runElectron(electron, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(electron, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    /** @param {Buffer} chunk */
    const append = (chunk) => {
      text += chunk.toString('utf8');
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Electron did not finish within 60 s:\n${text}`));
    }, 60_000);
    child.on('error', reject);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(text);
    });
  });
}

/**
 * Runs the check as the main script of a throwaway Electron app.
 * @param {string} electron
 * @param {string} modulePath
 * @returns {Promise<CheckResult>}
 */
async function checkInElectron(electron, modulePath) {
  const appDir = await mkdtemp(path.join(os.tmpdir(), 'piarc core load 加载-'));
  try {
    await copyFile(CHECK_SCRIPT, path.join(appDir, 'core-load-check.mjs'));
    await writeFile(
      path.join(appDir, 'package.json'),
      `${JSON.stringify({ name: 'piarc-core-load-check', type: 'module', main: 'core-load-check.mjs' })}\n`,
    );
    const output = await runElectron(electron, [
      appDir,
      `--user-data-dir=${path.join(appDir, 'data')}`,
      modulePath,
    ]);
    const line = output.split(/\r?\n/).find((l) => l.startsWith(RESULT_PREFIX));
    if (line === undefined) {
      throw new Error(`Electron printed no result:\n${output}`);
    }
    return parseResult(line.slice(RESULT_PREFIX.length));
  } finally {
    await rm(appDir, { recursive: true, force: true });
  }
}

/**
 * Reads the JSON line the check printed.
 * @param {string} text
 * @returns {CheckResult}
 */
export function parseResult(text) {
  /** @type {unknown} */
  const value = JSON.parse(text);
  if (
    !isRecord(value) ||
    typeof value.host !== 'string' ||
    typeof value.platform !== 'string' ||
    typeof value.arch !== 'string' ||
    typeof value.module !== 'string' ||
    typeof value.testingExports !== 'boolean' ||
    typeof value.events !== 'number' ||
    typeof value.ordered !== 'boolean' ||
    (value.panicKind !== null && typeof value.panicKind !== 'string') ||
    typeof value.finalState !== 'string' ||
    typeof value.ok !== 'boolean'
  ) {
    throw new Error(`malformed check result: ${text}`);
  }
  return {
    host: value.host,
    platform: value.platform,
    arch: value.arch,
    module: value.module,
    testingExports: value.testingExports,
    events: value.events,
    ordered: value.ordered,
    panicKind: value.panicKind,
    finalState: value.finalState,
    ok: value.ok,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      module: { type: 'string', multiple: true },
      electron: { type: 'string' },
      'skip-node': { type: 'boolean', default: false },
    },
  });
  const modules = (values.module ?? []).map((file) => path.resolve(file));
  if (modules.length === 0) {
    throw new Error('pass at least one --module <file.node>');
  }
  const electron = values.electron ?? defaultElectron();
  /** @type {CheckResult[]} */
  const results = [];
  for (const modulePath of modules) {
    if (!values['skip-node']) {
      results.push(await checkCore(modulePath, `node ${process.versions.node}`));
    }
    results.push(await checkInElectron(electron, modulePath));
  }
  for (const r of results) {
    console.log(
      `${r.ok ? 'PASS' : 'FAIL'} ${r.module} in ${r.host} (${r.platform}-${r.arch}): ` +
        (r.testingExports
          ? `${String(r.events)} events, ordered ${String(r.ordered)}, panic -> ${String(r.panicKind)}, `
          : 'release build, ') +
        `state ${r.finalState}`,
    );
  }
  if (results.some((r) => !r.ok)) {
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) {
  await main();
}
