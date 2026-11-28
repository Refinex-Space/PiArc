// T40 with the real Core, Agent Host and mock provider: the "Skills & plugins" page installs a
// Claude Code plugin and a Pi package from folders, lists their components and what PiArc does
// not support (A07), and turning one on goes through the main process's native confirmation,
// which lists the source and every executable item; cancelling runs nothing, confirming starts
// the plugin's MCP server in the open session's pool (A02). Development builds' test hooks
// answer the native dialog (Playwright cannot click it); release builds have no test hooks
// (scripts/ci/check-app-layout.mjs checks the release Core). Screenshots and the confirmations'
// text go to tmp/evidence/T40/.
import { openSettings } from './settings-panel.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';

import { expect, focusMain, makeWorkspace, openFolder, startSession, test } from './sessions.js';
import { idle, prefer } from './t19.js';

const REPO = path.join(import.meta.dirname, '..', '..', '..');
const EVIDENCE = path.join(REPO, 'tmp', 'evidence', 'T40');
const ECHO_SERVER = path.join(REPO, 'packages', 'testkit', 'src', 'mcp-echo-server.ts');

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

/** A plugin with a command, a hook, an MCP server, a mods module and a bin directory. */
async function makePlugin(dir: string): Promise<void> {
  await write(dir, {
    '.claude-plugin/plugin.json': JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      description: 'A demo plugin',
    }),
    'commands/hello.md': '---\ndescription: Say hello\n---\nHello.\n',
    'hooks/hooks.json': JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo plugin-stop' }] }] },
      modules: ['./register.js'],
    }),
    'hooks/register.js': 'export function register() {}\n',
    '.mcp.json': JSON.stringify({
      mcpServers: {
        echo: {
          command: process.execPath,
          args: [ECHO_SERVER, 'plugin-echo'],
          env: { MCP_ECHO_START_LOG: 'mcp-starts.jsonl' },
        },
      },
    }),
    'bin/tool': '#!/bin/sh\n',
  });
}

/** A Pi package with an extension, a skill and a theme. */
async function makePiPackage(dir: string): Promise<void> {
  await write(dir, {
    'package.json': JSON.stringify({
      name: 'pi-demo',
      version: '0.2.0',
      pi: { extensions: ['./probe.ts'], skills: ['./skills'], themes: ['./themes'] },
    }),
    'probe.ts': 'export default function () {}\n',
    'skills/lint/SKILL.md': '---\nname: lint\ndescription: Lint\n---\nLint.\n',
    'themes/dark.json': '{}',
  });
}

async function starts(workspace: string): Promise<string[]> {
  const text = await readFile(path.join(workspace, 'mcp-starts.jsonl'), 'utf8').catch(() => '');
  return text.split('\n').filter((line) => line !== '');
}

async function openSkills(page: Page): Promise<Page> {
  const settings = await openSettings(page);
  await settings.getByTestId('settings-nav-skills').click();
  await settings.getByTestId('plugins-section').waitFor();
  return settings;
}

async function install(settings: Page, dir: string): Promise<void> {
  await settings.getByTestId('package-install-open').click();
  await settings.getByTestId('package-kind-directory').check({ force: true });
  await settings.getByTestId('package-location').fill(dir);
  await settings.getByTestId('package-install-submit').click();
  await expect(settings.getByTestId('package-status')).toContainText('Installed', {
    timeout: 30_000,
  });
}

function row(settings: Page, id: string) {
  return settings.locator(`[data-testid="package-row"][data-id="${id}"]`);
}

async function answerNext(app: ElectronApplication, answer: boolean): Promise<void> {
  await app.evaluate((_electron, value) => {
    const hooks = globalThis.__piarcTestHooks;
    if (hooks === undefined) throw new Error('test hooks are missing: build the development app');
    hooks.answerConfirm(value);
  }, answer);
}

async function confirmations(
  app: ElectronApplication,
): Promise<readonly { message: string; detail: string }[]> {
  return app.evaluate(() => globalThis.__piarcTestHooks?.confirmations() ?? []);
}

test('packages install off, turn on only after the native confirmation, and list what is unsupported', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(180_000);
  await mkdir(EVIDENCE, { recursive: true });
  await prefer(page, { key: 'language', value: 'en' });
  const ws = await makeWorkspace(workspaces, 'plugins 插件', {});
  const plugin = path.join(workspaces, 'packages 包', 'demo');
  const piPackage = path.join(workspaces, 'packages 包', 'pi-demo');
  await makePlugin(plugin);
  await makePiPackage(piPackage);
  await openFolder(page, app, ws);
  await startSession(page, 'Hello', 't18-chat', 'trust');
  await idle(page);

  await focusMain(app);
  const settings = await openSkills(page);
  await install(settings, plugin);
  const demo = row(settings, 'demo');
  await expect(demo.getByTestId('package-type')).toHaveText('Claude Code plugin');
  await expect(demo.getByTestId('package-state')).toHaveText('Off');
  // The package's page: what it brings and what PiArc does not support.
  await demo.getByTestId('package-row-open').click();
  const page1 = settings.getByTestId('package-detail');
  await expect(page1.getByTestId('package-components')).toContainText('Commands');
  await expect(page1.getByTestId('package-components')).toContainText('demo:hello');
  await expect(page1.getByTestId('package-components')).toContainText('plugin_demo_echo');
  // A07: mods and the bin directory are named; the rest of the plugin still loads.
  await expect(page1.getByTestId('package-unsupported')).toHaveText('Not supported: mods, bin');
  await settings.screenshot({ path: path.join(EVIDENCE, 'package-page-light.png') });
  await settings.getByTestId('skills-view-installed').click();

  // A02: cancelling the native confirmation turns nothing on and starts nothing.
  await answerNext(app, false);
  await demo.getByTestId('package-on').click();
  await expect(settings.getByTestId('package-status')).toHaveText(
    'Nothing changed: the confirmation was cancelled.',
  );
  await expect(demo.getByTestId('package-state')).toHaveText('Off');
  const [cancelled] = await confirmations(app);
  expect(cancelled?.message).toBe('Turn on demo?');
  expect(cancelled?.detail).toContain(`Folder: ${plugin}`);
  expect(cancelled?.detail).toContain('Hooks it runs (event, matcher and command):');
  expect(cancelled?.detail).toContain('• Stop[*] echo plugin-stop');
  expect(cancelled?.detail).toContain('MCP servers it starts or connects');
  expect(cancelled?.detail).toContain(`• plugin_demo_echo: ${process.execPath}`);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  expect(await starts(ws)).toEqual([]);

  // Confirming turns it on: the open session's pool starts the plugin's server.
  await answerNext(app, true);
  await demo.getByTestId('package-on').click();
  await expect(demo.getByTestId('package-state')).toHaveText('On', { timeout: 15_000 });
  await expect.poll(async () => (await starts(ws)).length, { timeout: 20_000 }).toBe(1);
  await demo.screenshot({ path: path.join(EVIDENCE, 'plugin-row-en.png') });

  // The Pi package: its extension runs in the Agent Host, which the confirmation says.
  await install(settings, piPackage);
  const pi = row(settings, 'pi-demo');
  await expect(pi.getByTestId('package-type')).toHaveText('Pi package');
  await pi.getByTestId('package-row-open').click();
  await expect(settings.getByTestId('package-unsupported')).toHaveText('Not supported: themes');
  await settings.getByTestId('skills-view-installed').click();
  await answerNext(app, true);
  await pi.getByTestId('package-on').click();
  await expect(pi.getByTestId('package-state')).toHaveText('On', { timeout: 15_000 });
  const shown = await confirmations(app);
  expect(shown).toHaveLength(3);
  expect(shown[2]?.message).toBe('Turn on pi-demo?');
  expect(shown[2]?.detail).toContain('Pi extensions it loads (entry file):\n• probe.ts');
  expect(shown[2]?.detail).toContain('same permissions as the agent');
  await writeFile(
    path.join(EVIDENCE, 'native-confirmations.json'),
    `${JSON.stringify(shown, null, 2)}\n`,
  );

  await settings.getByTestId('plugins-section').scrollIntoViewIfNeeded();
  await settings.screenshot({ path: path.join(EVIDENCE, 'plugins-section-light.png') });
  await prefer(page, { key: 'appearance.theme', value: 'dark' });
  await settings.screenshot({ path: path.join(EVIDENCE, 'plugins-section-dark.png') });
  await prefer(page, { key: 'language', value: 'zh-CN' });
  await expect(demo.getByTestId('package-state')).toHaveText('已开启');
  await settings.screenshot({ path: path.join(EVIDENCE, 'plugins-section-zh-CN-dark.png') });
  await prefer(page, { key: 'appearance.theme', value: 'light' });
  await prefer(page, { key: 'language', value: 'en' });

  // Turning it off takes effect at once (no restart) and asks nothing.
  await demo.getByTestId('package-off').click();
  await expect(demo.getByTestId('package-state')).toHaveText('Off', { timeout: 15_000 });
  expect(await confirmations(app)).toHaveLength(3);
});
