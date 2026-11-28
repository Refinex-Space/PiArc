// The Pi package market's L4 rig (ADR-0102): `piarc-mock-npm` (the mock registry over HTTPS with
// the test CA) as a standalone process, and the app pointed at it through the development
// build's overrides. The app never reaches the real registry: without the overrides a
// development build's market points at `registry.invalid`.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import type { Page } from '@playwright/test';

import { openSettings } from './settings-panel.js';
import { test as base } from './sessions.js';

const repoRoot = path.join(import.meta.dirname, '..', '..', '..');
/** The test CA the mock's certificate chains to (the private key was discarded). */
export const TEST_CA = path.join(
  repoRoot,
  'crates',
  'piarc-testkit',
  'fixtures',
  'tls',
  'ca.test.crt',
);

const skill = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\nBody.\n`;

/** The catalog: one package per category, a theme-only one the market hides, and a payload. */
export const PACKAGES = [
  {
    name: 'pi-lint-skills',
    description: 'Lint skills for TypeScript projects',
    keywords: ['pi-skill'],
    downloadsMonthly: 12_400,
    updated: '2026-11-20T10:00:00Z',
    license: 'MIT',
    repository: 'https://github.com/example/pi-lint-skills',
    readme: '# pi-lint-skills\n\nRuns **lint** for you.\n\n```sh\nnpm run lint\n```\n',
    versions: [
      {
        version: '1.0.0',
        manifest: { pi: { skills: ['./skills'] } },
        files: { 'skills/lint/SKILL.md': skill('lint') },
      },
      {
        version: '1.2.0',
        manifest: { pi: { skills: ['./skills'] } },
        files: { 'skills/lint/SKILL.md': skill('lint') },
      },
    ],
  },
  {
    name: 'pi-git-tools',
    description: 'An extension with git helpers',
    keywords: ['pi-extension'],
    downloadsMonthly: 3_100,
    updated: '2026-10-01T10:00:00Z',
    versions: [
      {
        version: '0.4.0',
        manifest: { pi: { extensions: ['./index.ts'] } },
        files: { 'index.ts': 'export default function () {}\n' },
      },
    ],
  },
  {
    name: '@demo/prompts',
    description: 'Prompt templates for reviews',
    downloadsMonthly: 900,
    updated: '2026-11-25T10:00:00Z',
    versions: [
      {
        version: '2.0.1',
        manifest: { pi: { prompts: ['./prompts'] } },
        files: { 'prompts/review.md': 'Review this.\n' },
      },
    ],
  },
  {
    name: 'pi-dark-theme',
    description: 'Only a theme',
    downloadsMonthly: 40_000,
    versions: [
      {
        version: '1.0.0',
        manifest: { pi: { themes: ['./themes'] } },
        files: { 'themes/dark.json': '{}' },
      },
    ],
  },
  {
    name: 'pi-xss-probe',
    description: '<img src=x onerror="window.__xss=1"> ‮gnp.exe',
    keywords: ['pi-skill'],
    downloadsMonthly: 10,
    readme: '<script>window.__xss=1</script>\n\n[link](javascript:alert(1))\n',
    versions: [
      {
        version: '0.0.1',
        manifest: { pi: { skills: ['./skills'] } },
        files: { 'skills/probe/SKILL.md': skill('probe') },
      },
    ],
  },
];

export interface MockNpm {
  readonly base: string;
  /** Sends one control line (`offline`, `online`, `status <path> <code>`…) and waits for `ok`. */
  control(line: string): Promise<void>;
  /** The request paths the registry saw. */
  requests(): Promise<string[]>;
  /** Requests the registry did not expect. */
  violations(): Promise<unknown[]>;
  stop(): Promise<void>;
}

export async function startMockNpm(packages: readonly unknown[] = PACKAGES): Promise<MockNpm> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'piarc market 市场-'));
  const fixtures = path.join(dir, 'packages.json');
  await writeFile(fixtures, JSON.stringify(packages));
  const child = spawn(
    'cargo',
    [
      'run',
      '-q',
      '--locked',
      '-p',
      'piarc-testkit',
      '--bin',
      'piarc-mock-npm',
      '--',
      '--fixtures',
      fixtures,
      '--work',
      path.join(dir, 'work'),
      // npm resolves names itself and would not find a `.test` one: directly, the loopback
      // address (the certificate names it too).
      '--host',
      '127.0.0.1',
    ],
    { cwd: repoRoot, stdio: ['pipe', 'pipe', 'inherit'] },
  );
  const lines = createInterface({ input: child.stdout });
  // Each stdout line answers the oldest question; the first one is the port.
  const waiting: ((line: string) => void)[] = [];
  lines.on('line', (line) => waiting.shift()?.(line));
  const port = await new Promise<string>((resolve, reject) => {
    waiting.push(resolve);
    child.once('exit', (code) => {
      reject(new Error(`piarc-mock-npm exited with ${String(code)}`));
    });
  });
  const ask = (line: string) =>
    new Promise<string>((resolve) => {
      waiting.push(resolve);
      child.stdin.write(`${line}\n`);
    });
  return {
    base: `https://127.0.0.1:${port.trim()}`,
    control: async (line) => {
      const answer = await ask(line);
      if (answer !== 'ok') throw new Error(`piarc-mock-npm: ${answer}`);
    },
    requests: async () => {
      const value: unknown = JSON.parse(await ask('requests'));
      return Array.isArray(value) ? value.map(String) : [];
    },
    violations: async () => {
      const value: unknown = JSON.parse(await ask('violations'));
      return Array.isArray(value) ? value.map((v: unknown) => v) : [];
    },
    stop: async () => {
      child.stdin.end();
      await new Promise((resolve) => child.once('exit', resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** The app's environment for the market: the mock registry and its CA. A file whose top level
 * sets `appEnv` with `test.use` passes this again inside a `describe` (the file's value wins). */
export const marketEnv = async (
  { npm }: { npm: MockNpm },
  use: (env: Record<string, string>) => Promise<void>,
): Promise<void> => {
  await use({ PIARC_TEST_MARKET_REGISTRY: npm.base, PIARC_TEST_MARKET_CA: TEST_CA });
};

/** The session fixtures plus a mock registry the app's market uses. */
export const test = base.extend<{ npm: MockNpm }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern here.
  npm: async ({}, use) => {
    const npm = await startMockNpm();
    await use(npm);
    await npm.stop();
  },
  appEnv: marketEnv,
});

export { expect } from './sessions.js';

/** Opens "Skills & plugins" in its market view. */
export async function openMarket(page: Page): Promise<Page> {
  const settings = await openSettings(page);
  await settings.getByTestId('settings-nav-skills').click();
  await settings.getByTestId('skills-view-market').click();
  await settings.getByTestId('market').waitFor();
  return settings;
}

export function marketRow(page: Page, name: string) {
  return page.locator(`[data-testid="market-row"][data-name="${name}"]`);
}
