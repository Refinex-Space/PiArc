// The steps of the S6 first-run checklist that need a person at the Mac or the Windows PC
// (docs/spikes/S06-first-run-checklist.md). Each command launches an installed
// development-flavor PiArc with Playwright (it needs the `--inspect` fuse of development
// builds) and calls a Core test export or main-process test hook. `--app` is the .app bundle
// on macOS and PiArc.exe on Windows (default: the Velopack install,
// %LOCALAPPDATA%\cn.piarc.desktop\current\PiArc.exe); `variant` and `keychain` are macOS only.
//
//   node scripts/dev/s6-probe.mjs serve <file> [--port 8765]
//       Serves one file over http://127.0.0.1:<port>/ so a browser download gets the
//       quarantine attribute, as a download from GitHub Releases would.
//   node scripts/dev/s6-probe.mjs agent-host [--app /Applications/PiArc.app]
//       One mock conversation with the installed app's Agent Host (bundled node under
//       sandbox-exec, one Bash call). Shows whether Gatekeeper stops the bundled node.
//   node scripts/dev/s6-probe.mjs notify [--app …] [--wait 30]
//       Posts a notification and keeps the app running for --wait seconds (default 30), then
//       prints the program-side events (`show` / `failed`). Electron removes the app's
//       delivered notifications when it quits, so the banner and its Notification Center
//       entry are only there while the app runs.
//   node scripts/dev/s6-probe.mjs variant --app <A.app> --out <dir> [--version 0.0.1]
//       Makes "build B" for the keychain count: a copy of build A with another bundle version,
//       re-signed the way packaging signs, as PiArc-B.dmg. Rebuilding unchanged sources can
//       give the same ad-hoc identity; an update always changes Info.plist and the seal.
//   node scripts/dev/s6-probe.mjs keychain write|read|delete [--app …] [--dir <dir>]
//       Creates (write) or reads (read) a probe vault whose master key is the keychain item
//       `piarc-test.s6-keychain.credential-vault`; delete removes both. Run write with build A,
//       install build B, run read and count the keychain dialogs.
//
// Every run uses a fresh user-data directory and prints the report as JSON.
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

import { _electron as electron } from 'playwright';

import { signBundle } from '../../apps/desktop/packaging/macos-sign.mjs';

import { isMain, repoRoot, run } from '../lib/repo.mjs';

const DEFAULT_APP =
  process.platform === 'win32'
    ? path.join(
        process.env.LOCALAPPDATA ?? os.homedir(),
        'cn.piarc.desktop',
        'current',
        'PiArc.exe',
      )
    : '/Applications/PiArc.app';
const DEFAULT_KEYCHAIN_DIR = path.join(os.tmpdir(), 'piarc-s6-keychain-probe');

/**
 * Launches the app and runs `fn` with it; always closes it.
 * @template T
 * @param {string} appPath
 * @param {(app: import('playwright').ElectronApplication) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withApp(appPath, fn) {
  const executable = appPath.endsWith('.app')
    ? path.join(appPath, 'Contents', 'MacOS', 'PiArc')
    : appPath;
  if (!existsSync(executable)) {
    throw new Error(`${executable} not found; pass --app <PiArc.app or PiArc.exe>`);
  }
  const userData = await mkdtemp(path.join(os.tmpdir(), 'piarc-s6-probe-'));
  const app = await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${userData}`],
  });
  try {
    const hasHooks = await app.evaluate(() => globalThis.__piarcTestHooks !== undefined);
    if (!hasHooks) {
      throw new Error('This build has no test hooks: install a development-flavor build.');
    }
    return await fn(app);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
}

/**
 * @param {string} file
 * @param {number} port
 */
function serve(file, port) {
  const name = path.basename(file);
  const size = statSync(file).size;
  createServer((request, response) => {
    if (request.url !== `/${encodeURIComponent(name)}`) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<a href="/${encodeURIComponent(name)}">${name}</a>`);
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(size),
      'content-disposition': `attachment; filename="${name}"`,
    });
    createReadStream(file).pipe(response);
  }).listen(port, '127.0.0.1', () => {
    console.log(`Open http://127.0.0.1:${String(port)}/ in Safari and download ${name}.`);
    console.log('Press Ctrl+C to stop.');
  });
}

/**
 * Starts the mock provider with one scenario file; resolves with its base URL and a stop
 * function.
 * @param {string} scenario
 */
async function startMock(scenario) {
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
      scenario,
    ],
    { cwd: repoRoot, stdio: ['pipe', 'pipe', 'inherit'] },
  );
  const lines = createInterface({ input: child.stdout });
  /** @type {Promise<string>} */
  const firstLine = new Promise((resolve, reject) => {
    lines.once('line', resolve);
    child.once('exit', (code) => {
      reject(new Error(`piarc-mock-provider exited with ${String(code)}`));
    });
  });
  const port = await firstLine;
  lines.close();
  return {
    baseUrl: `http://127.0.0.1:${port.trim()}`,
    stop: () => child.stdin.end(),
  };
}

/** @param {string} appPath */
async function agentHost(appPath) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'piarc-s6-agent-host-'));
  const workspace = path.join(root, 'ws');
  const dataDir = path.join(root, 'data');
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(dataDir, 'pi'), { recursive: true });
  const scenario = path.join(root, 'scenario.json');
  await writeFile(
    scenario,
    JSON.stringify({
      id: 's6-checklist',
      steps: [
        { tool_calls: [{ name: 'Bash', input: { command: 'printf bash-ok' } }] },
        { text: 'The bundled Agent Host answered.' },
      ],
    }),
  );
  const mock = await startMock(scenario);
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
                contextWindow: 200000,
                maxTokens: 4096,
              },
            ],
          },
        },
      }),
    );
    return await withApp(appPath, async (app) => {
      const resourcesDir = await app.evaluate(() => process.resourcesPath);
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
          workspace: await realpath(workspace),
          dataDir,
          provider: 'piarc-mock',
          model: 'mock-large',
          prompt: 'Checklist probe. [[piarc-scenario:s6-checklist]]',
          timeoutMs: 120_000,
        },
      );
      /** @type {unknown} */
      const report = JSON.parse(json);
      return report;
    });
  } finally {
    mock.stop();
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * @param {string} command
 * @param {string[]} args
 */
async function mustRun(command, args) {
  const code = await run(command, args);
  if (code !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${String(code)})`);
  }
}

/**
 * Build B: build A with another bundle version, re-signed, in a DMG.
 * @param {string} appPath
 * @param {string} outDir
 * @param {string} version
 */
async function variant(appPath, outDir, version) {
  const staging = path.join(outDir, 'PiArc-B');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const copy = path.join(staging, 'PiArc.app');
  await mustRun('ditto', [appPath, copy]);
  const plist = path.join(copy, 'Contents', 'Info.plist');
  for (const key of ['CFBundleVersion', 'CFBundleShortVersionString']) {
    await mustRun('plutil', ['-replace', key, '-string', version, plist]);
  }
  await signBundle(copy);
  await mustRun('codesign', ['--verify', '--deep', '--strict', copy]);
  await symlink('/Applications', path.join(staging, 'Applications'));
  const dmg = path.join(outDir, 'PiArc-B.dmg');
  await mustRun('hdiutil', [
    'create',
    '-volname',
    'PiArc',
    '-srcfolder',
    staging,
    '-fs',
    'HFS+',
    '-format',
    'ULFO',
    '-ov',
    dmg,
  ]);
  await rm(staging, { recursive: true, force: true });
  return dmg;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      app: { type: 'string', default: DEFAULT_APP },
      dir: { type: 'string', default: DEFAULT_KEYCHAIN_DIR },
      port: { type: 'string', default: '8765' },
      wait: { type: 'string', default: '30' },
      out: { type: 'string' },
      version: { type: 'string', default: '0.0.1' },
    },
  });
  const [command, argument] = positionals;
  switch (command) {
    case 'serve':
      if (argument === undefined) {
        throw new Error('usage: s6-probe.mjs serve <file>');
      }
      serve(path.resolve(argument), Number.parseInt(values.port, 10));
      return;
    case 'variant': {
      if (values.out === undefined) {
        throw new Error('usage: s6-probe.mjs variant --app <A.app> --out <dir>');
      }
      await mkdir(values.out, { recursive: true });
      console.log(await variant(values.app, values.out, values.version));
      return;
    }
    case 'agent-host':
      console.log(JSON.stringify(await agentHost(values.app), null, 2));
      return;
    case 'notify': {
      const waitMs = Number.parseInt(values.wait, 10) * 1000;
      if (!Number.isInteger(waitMs) || waitMs <= 0) {
        throw new Error('--wait must be a positive number of seconds');
      }
      console.log(
        `Posting a notification; watch the top right of the screen for ${values.wait} s.`,
      );
      const result = await withApp(values.app, (app) =>
        app.evaluate(async (_electron, wait) => {
          const hooks = globalThis.__piarcTestHooks;
          if (hooks === undefined) {
            throw new Error('no Core test hooks');
          }
          return hooks.showNotification('PiArc', 'S6 notification probe: did you see this?', wait);
        }, waitMs),
      );
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case 'keychain': {
      if (argument !== 'write' && argument !== 'read' && argument !== 'delete') {
        throw new Error('usage: s6-probe.mjs keychain write|read|delete');
      }
      /** @type {'write' | 'read' | 'delete'} */
      const action = argument;
      await mkdir(values.dir, { recursive: true });
      const json = await withApp(values.app, (app) =>
        app.evaluate(
          async (_electron, { action, dir }) => {
            const hooks = globalThis.__piarcTestHooks;
            if (hooks === undefined) {
              throw new Error('no Core test hooks');
            }
            return hooks.core.keychainProbe(action, dir);
          },
          { action, dir: values.dir },
        ),
      );
      console.log(JSON.stringify(JSON.parse(json), null, 2));
      return;
    }
    default:
      throw new Error('usage: s6-probe.mjs serve|variant|agent-host|notify|keychain …');
  }
}

if (isMain(import.meta.url)) {
  await main();
}
