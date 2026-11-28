// The in-app update L4 rig (ADR-0111): a release signed with the test key, served by
// `piarc-mock-releases` (GitHub's download redirects over HTTPS with the test CA), and the
// development build's update overrides pointing at it. Without the overrides a development
// build's feed is `updates.invalid` and it trusts no key, so the app never reaches GitHub.
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { TEST_CA } from './market.js';

const repoRoot = path.join(import.meta.dirname, '..', '..', '..');
const TEST_KEYS = path.join(repoRoot, 'scripts', 'release', 'test-keys');

/** The test public key (base64), the one the app trusts in these tests. */
export async function testPublicKey(): Promise<string> {
  const text = await readFile(path.join(TEST_KEYS, 'release-manifest.test.pub'), 'utf8');
  return text.split('\n')[1]?.trim() ?? '';
}

function bytes(seed: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

const NOTES = {
  en: '### Added\n\n- **In-app updates** download through your proxy.\n\n### Fixed\n\n- The About page shows every bundled part.\n',
  'zh-CN':
    '### 新增\n\n- **应用内更新**经你的代理下载。\n\n### 修复\n\n- 关于页列出所有内置组件。\n',
};

/** Writes `<root>/<version>/` with every platform's artefacts and signs its manifest. */
export async function publishRelease(
  root: string,
  version: string,
  options: { readonly security?: boolean; readonly archiveBytes?: number } = {},
): Promise<void> {
  const dir = path.join(root, version);
  await mkdir(dir, { recursive: true });
  const files: [string, Buffer][] = [
    [
      'piarc-release-notes.json',
      Buffer.from(
        JSON.stringify({
          format: 'piarc-release-notes/1',
          version,
          date: '2026-12-01',
          security: options.security === true,
          notes: NOTES,
        }),
      ),
    ],
  ];
  const size = options.archiveBytes ?? 400_000;
  for (const arch of ['arm64', 'x64']) {
    files.push([`PiArc-${version}-macos-${arch}.zip`, bytes(1, size)]);
    const pkg = `cn.piarc.desktop-${version}-win-${arch}-full.nupkg`;
    files.push([
      `releases.win-${arch}.json`,
      Buffer.from(
        JSON.stringify({
          Assets: [
            { PackageId: 'cn.piarc.desktop', Version: version, Type: 'Full', FileName: pkg },
          ],
        }),
      ),
    ]);
    files.push([pkg, bytes(2, size)]);
  }
  for (const [name, content] of files) await writeFile(path.join(dir, name), content);
  await new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      [
        path.join(repoRoot, 'scripts', 'release', 'release-manifest.mjs'),
        'generate',
        '--version',
        version,
        '--key',
        path.join(TEST_KEYS, 'release-manifest.test.key'),
        '--out',
        path.join(dir, 'piarc-release-manifest.json'),
        ...files.map(([name]) => path.join(dir, name)),
      ],
      (error) => {
        if (error === null) resolve();
        else reject(new Error(`release-manifest.mjs failed: ${error.message}`));
      },
    );
  });
}

export interface MockReleases {
  /** `https://localhost:<port>/releases`. */
  readonly releases: string;
  /** Sends one control line (`latest <v>`, `slow <bytes>`, `offline`…) and waits for `ok`. */
  control(line: string): Promise<void>;
  requests(): Promise<string[]>;
  stop(): Promise<void>;
}

/** Publishes `version` and serves it as the latest release. */
export async function startMockReleases(
  version = '1.1.0',
  options: { readonly security?: boolean } = {},
): Promise<MockReleases> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'piarc releases 发布-'));
  await publishRelease(root, version, options);
  const child = spawn(
    'cargo',
    [
      'run',
      '-q',
      '--locked',
      '-p',
      'piarc-testkit',
      '--bin',
      'piarc-mock-releases',
      '--',
      '--dir',
      root,
      '--latest',
      version,
    ],
    { cwd: repoRoot, stdio: ['pipe', 'pipe', 'inherit'] },
  );
  const lines = createInterface({ input: child.stdout });
  const waiting: ((line: string) => void)[] = [];
  lines.on('line', (line) => waiting.shift()?.(line));
  const port = await new Promise<string>((resolve, reject) => {
    waiting.push(resolve);
    child.once('exit', (code) => {
      reject(new Error(`piarc-mock-releases exited with ${String(code)}`));
    });
  });
  const ask = (line: string) =>
    new Promise<string>((resolve) => {
      waiting.push(resolve);
      child.stdin.write(`${line}\n`);
    });
  return {
    releases: `https://localhost:${port.trim()}/releases`,
    control: async (line) => {
      const answer = await ask(line);
      if (answer !== 'ok') throw new Error(`piarc-mock-releases: ${answer}`);
    },
    requests: async () => {
      const value: unknown = JSON.parse(await ask('requests'));
      return Array.isArray(value) ? value.map(String) : [];
    },
    stop: async () => {
      child.stdin.end();
      await new Promise((resolve) => child.once('exit', resolve));
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** The app's environment for a feed at `releases`. */
export async function updateEnv(releases: string): Promise<Record<string, string>> {
  return {
    PIARC_TEST_UPDATE_FEED: releases,
    PIARC_TEST_UPDATE_CA: TEST_CA,
    PIARC_TEST_UPDATE_HOSTS: 'localhost,127.0.0.1',
    PIARC_TEST_UPDATE_KEY: await testPublicKey(),
  };
}
