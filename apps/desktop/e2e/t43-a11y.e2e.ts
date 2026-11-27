// T43-A01: axe on every state of the accessibility state list (`a11y/states.ts`), light and
// dark, with the real Core, Agent Host and mock provider. Journeys reach the states the way a
// user does; `checkState` writes each axe result to tmp/evidence/T43/axe/ and fails on any
// violation. The last test checks every listed state was reached in this run.
import { openSettings, closeSettings } from './settings-panel.js';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { exerciseElicitation } from './elicitation.js';
import { AXE_DIR, checkState } from './a11y.js';
import { A11Y_STATES } from './a11y/states.js';
import { expect, focusMain, makeWorkspace, openFolder, test } from './sessions.js';
import { IPC_CHANNELS } from '../src/shared/ipc.js';
import { expectTestHooks } from './core.js';
import { browserDouble, PROVIDER, PROVIDER_FILE, startAuth, writeProvider } from './oauth.js';
import { idle, killAgentHost, openSession, prefer, send } from './t19.js';
import { conflictOnMain, fakeGh, git, githubRemote, makeRepository } from './git.js';
import { clickInPage } from './browser-b3.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** G5's pull request states need a `gh`: a fake one, never the machine's (see git-github). */
const gh = fakeGh();
test.use({ appEnv: { PIARC_TEST_GH: gh.program } });

/** Starts another session in the open workspace with `scenario`. */
async function newSession(page: Page, text: string, scenario: string): Promise<void> {
  await page.getByTestId('new-session').click();
  await page.getByTestId('home-input').fill(`${text} [[piarc-scenario:${scenario}]]`);
  await page.getByTestId('home-start').click();
  await expect(page.getByTestId('conversation')).toBeVisible({ timeout: 30_000 });
}

/** Opens a rail tab (card) by its panel id. */
async function railTab(page: Page, panel: string): Promise<void> {
  const details = page.getByTestId('tool-rail');
  if ((await details.getAttribute('aria-pressed')) === 'false') await details.click();
  const section = page.getByTestId(`panel-tab-${panel}`);
  if ((await section.getAttribute('aria-expanded')) !== 'true') await section.click();
  await expect(section).toHaveAttribute('aria-expanded', 'true');
}

// "Checked in this run" (R5): markers an earlier run left behind would let a state whose check
// was removed from the journey pass the last test. The axe reports stay.
test.beforeAll(async () => {
  const markers = (await readdir(AXE_DIR).catch(() => [])).filter((f) => f.endsWith('.checked'));
  await Promise.all(markers.map((f) => rm(path.join(AXE_DIR, f), { force: true })));
});

test('windows, the trust dialog, a first conversation, palettes, rail cards and settings pages', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(240_000);
  await prefer(page, { key: 'language', value: 'en' });
  await checkState(page, 'window:welcome');

  const ws = await makeWorkspace(workspaces, 'a11y 无障碍', {
    'notes.txt': 'The release is on Friday.\n',
    'guide.md':
      '# Project Guide\n\n| Day | Status |\n| --- | --- |\n| Today | Ready |\n\n![Local sample](./image.png)\n\n## Example\n\n~~~js\nconst value = 1;\n~~~\n\nEquation $x^2$ with a note[^1].\n\n[^1]: Check local files.\n',
    '.piarc/settings.json': JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'true' }] }] },
    }),
  });
  await writeFile(
    path.join(ws, 'image.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGMwrPCHIwbiOACRYw+BvTjSqgAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  await openFolder(page, app, ws);
  await checkState(page, 'window:new-session');

  await page.getByTestId('home-input').fill('Read the notes. [[piarc-scenario:t43-rows]]');
  await page.getByTestId('home-start').click();
  await expect(page.getByTestId('trust-dialog')).toBeVisible();
  await checkState(page, 'dialog:trust');
  await page.getByTestId('trust-accept').click();
  await expect(page.getByTestId('conversation')).toBeVisible({ timeout: 30_000 });
  await focusMain(app);
  await idle(page);
  await checkState(page, 'window:conversation');
  await page.keyboard.press(`${MOD}+Semicolon`);
  await expect(page.getByTestId('side-chat')).toBeVisible();
  await checkState(page, 'panel:side-chat');
  await page.getByTestId('tile-close-side-chat').click();
  await page.getByTestId('tool-files').click();
  await expect(page.getByTestId('tile-files')).toBeVisible();
  await checkState(page, 'panel:files');
  const opening = app.waitForEvent('window');
  await page.getByTestId('tile-popout-files').click();
  const fileWindow = await opening;
  await expect(fileWindow.getByTestId('project-files')).toBeVisible();
  await checkState(fileWindow, 'window:tool', { themeOwner: page });
  await fileWindow.getByTestId('tile-popout-files').click();
  await expect(page.getByTestId('project-files')).toBeVisible();
  await page.getByTestId('tile-maximize-files').click();
  await page.getByRole('treeitem', { name: 'guide.md', exact: true }).click();
  await expect(
    page.getByTestId('markdown-reader').getByRole('heading', { name: 'Project Guide' }),
  ).toBeVisible();
  await checkState(page, 'state:md-read');
  await page.getByTestId('md-outline-trigger').hover();
  await expect(page.getByTestId('md-outline-popover')).toBeVisible();
  await checkState(page, 'state:md-outline');
  await page.keyboard.press('Escape');
  await page.getByTestId('markdown-reader').getByRole('img', { name: 'Local sample' }).click();
  await expect(page.getByTestId('markdown-image-dialog')).toBeVisible();
  await checkState(page, 'dialog:md-image');
  await page
    .getByTestId('markdown-image-dialog')
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await page.getByTestId('md-mode-edit').check();
  await expect(page.getByTestId('markdown-editor-input')).toBeVisible();
  await checkState(page, 'state:md-live');
  const language = page.getByRole('combobox', { name: 'Code block language' });
  await language.focus();
  await language.fill('typ');
  await expect(page.getByRole('option', { name: 'typescript', exact: true })).toBeVisible();
  await checkState(page, 'state:md-code-language');
  await language.press('Escape');
  const cell = page.getByRole('textbox', { name: 'Row 2, column 1', exact: true });
  await cell.hover();
  await page.locator('[data-table-control=row]').click();
  await expect(page.getByRole('menu', { name: 'Row actions', exact: true })).toBeVisible();
  await checkState(page, 'state:md-table-controls');
  await page.keyboard.press('Escape');
  await page.getByTestId('md-mode-source').check();
  const author = page.getByTestId('markdown-editor-input');
  await author.click();
  await author.press(MOD + '+Home');
  await author.press('Home');
  await author.press('Shift+End');
  await expect(page.getByRole('toolbar', { name: 'Format selection' })).toBeVisible();
  await checkState(page, 'state:md-selection');
  await author.press('Shift+F10');
  const authorMenu = page.getByRole('menu', { name: 'Markdown actions', exact: true });
  await expect(authorMenu).toBeVisible();
  await checkState(page, 'state:md-body-menu');
  await page.keyboard.press('Escape');
  await author.focus();
  await author.press(MOD + '+End');
  await author.press('End');
  await author.press('Enter');
  await author.press('/');
  const slash = page.getByRole('listbox', { name: 'Insert Markdown' });
  await slash.getByRole('option', { name: 'Mermaid diagram', exact: true }).click();
  await expect(page.getByRole('listbox', { name: 'Mermaid diagram', exact: true })).toBeVisible();
  await checkState(page, 'state:md-slash');
  await author.press('Escape');
  await author.press('Escape');
  await author.press('Backspace');
  await page.getByTestId('md-mode-split').check();
  await expect(
    page.getByTestId('markdown-reader').getByRole('heading', { name: 'Project Guide' }),
  ).toBeVisible();
  await expect(author).toHaveAttribute('tabindex', '0');
  await checkState(page, 'state:md-split');
  await page.getByRole('treeitem', { name: 'notes.txt', exact: true }).click();
  await expect(page.locator('[data-source-line="1"]')).toBeVisible();
  await checkState(page, 'state:files-source');
  await page.getByRole('button', { name: 'Files settings' }).click();
  await page.getByRole('menuitem', { name: 'Auto save', exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByTestId('file-editor').fill('A draft for accessibility checks.');
  await checkState(page, 'state:files-editor');
  await page.getByTestId('tile-close-files').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await checkState(page, 'dialog:files-discard');
  await page.getByRole('dialog').getByRole('button', { name: 'Discard changes' }).click();
  await page.getByTestId('tool-files').click();
  await page.getByTestId('tool-preview').click();
  await expect(page.getByTestId('tile-preview')).toBeVisible();
  await checkState(page, 'panel:preview');
  // B3: a picked element's card, the annotation tools and the discard question.
  await writeFile(
    path.join(ws, 'b3.html'),
    '<!doctype html><title>B3</title><main><h1>Plans</h1><button id="save">Save</button></main>',
  );
  const address = page.getByTestId('browser-address');
  await address.click();
  await address.fill(path.join(ws, 'b3.html'));
  await address.press('Enter');
  await expect(page.getByTestId('browser-tab').first()).toHaveText('B3');
  await page.getByTestId('browser-pick-toggle').click();
  await clickInPage(app, 'b3.html', '#save');
  await expect(page.getByTestId('browser-pick-card')).toHaveCount(1);
  await expect(page.getByTestId('browser-pick-comment')).toBeFocused();
  await checkState(page, 'state:browser-picks');
  await page.getByTestId('browser-pick-remove').click();
  await expect(page.getByTestId('browser-pick-stage')).toHaveCount(0);
  await page.getByTestId('browser-pick-toggle').click();
  await expect(page.getByTestId('browser-pick-toggle')).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('browser-annotate-toggle').click();
  await expect(page.getByTestId('browser-annotate')).toBeVisible();
  await page.getByTestId('browser-annotate-tool-marker').click();
  await page.getByTestId('browser-annotate-canvas').click({ position: { x: 24, y: 24 } });
  await expect(page.getByTestId('browser-annotate-comment')).toBeFocused();
  await checkState(page, 'state:browser-annotate');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('browser-annotate-card')).toHaveCount(0);
  await page.getByTestId('browser-annotate-cancel').click();
  await expect(page.getByTestId('browser-annotate-discard')).toBeVisible();
  await checkState(page, 'dialog:browser-annotate-discard');
  await page.getByTestId('browser-annotate-discard-confirm').click();
  await page.getByTestId('browser-screenshot').click();
  await page.getByTestId('browser-shot-region').click();
  const regionCanvas = await page.getByTestId('browser-annotate-canvas').boundingBox();
  if (regionCanvas === null) throw new Error('No canvas');
  await page.mouse.move(regionCanvas.x + 16, regionCanvas.y + 16);
  await page.mouse.down();
  await page.mouse.move(regionCanvas.x + 120, regionCanvas.y + 64);
  await page.mouse.up();
  await expect(page.getByTestId('browser-region-comment')).toBeFocused();
  await checkState(page, 'state:browser-region');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('browser-annotate')).toHaveCount(0);
  await page.getByTestId('tile-close-preview').click();
  await page.getByTestId('tile-close-files').click();
  await checkState(page, 'row:userMessage');
  await checkState(page, 'row:agentMessage');
  await checkState(page, 'row:reasoning');
  await checkState(page, 'row:group');

  await page.keyboard.press(`${MOD}+K`);
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await checkState(page, 'dialog:command-palette');
  await page.keyboard.press('Escape');
  await page.keyboard.press(`${MOD}+/`);
  await expect(page.getByRole('dialog')).toBeVisible();
  await checkState(page, 'dialog:shortcuts');
  await page.keyboard.press('Escape');

  await railTab(page, 'context');
  await checkState(page, 'panel:context');
  await railTab(page, 'usage');
  await checkState(page, 'panel:usage');
  await railTab(page, 'changes-card');
  await checkState(page, 'panel:changes-card');
  await page.getByTestId('changes-open').click();
  await expect(page.getByTestId('changes-empty')).toBeVisible();
  await checkState(page, 'state:changes-empty');

  await page.getByTestId('open-search').click();
  await checkState(page, 'dialog:workspace-search');
  await page.getByTestId('session-filter').fill('Friday');
  await expect(page.getByTestId('search-hit').first()).toBeVisible({ timeout: 20_000 });
  await checkState(page, 'window:message-search');
  await page.keyboard.press('Escape');

  // A plugin with a hook (an executable item), installed off, for the Skills & plugins page.
  const plugin = path.join(workspaces, 'packages 包', 'demo');
  await makeWorkspace(path.dirname(plugin), 'demo', {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
    'commands/hello.md': '---\ndescription: Say hello\n---\nHello.\n',
    'hooks/hooks.json': JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo plugin-stop' }] }] },
    }),
  });
  const settings = await openSettings(page);
  await checkState(settings, 'dialog:settings');
  const search = settings.getByRole('combobox', { name: 'Search settings' });
  await search.fill('theme');
  await expect(settings.getByRole('listbox', { name: 'Search settings' })).toBeVisible();
  await checkState(settings, 'state:settings-search');
  await search.press('Escape');
  await settings.getByTestId('settings-nav-skills').click();
  await settings.getByTestId('package-kind').selectOption('directory');
  await settings.getByTestId('package-location').fill(plugin);
  await settings.getByTestId('package-install-submit').click();
  await expect(settings.getByTestId('package-status')).toContainText('Installed', {
    timeout: 30_000,
  });
  for (const id of [
    'general',
    'appearance',
    'markdown',
    'voice',
    'providers',
    'permissions',
    'sandbox',
    'proxy',
    'git',
    'browser',
    'agents',
    'skills',
    'memory',
    'mcp',
    'usage',
    'diagnostics',
    'shortcuts',
  ] as const) {
    await settings.getByTestId(`settings-nav-${id}`).click();
    await expect(settings.getByTestId(`settings-page-${id}`)).toBeVisible();
    await checkState(settings, `settings:${id}`);
  }
  // B5.1: the Chrome import dialog (the test home has no Chrome).
  await settings.getByTestId('settings-nav-browser').click();
  await settings.getByTestId('browser-import-open').click();
  await expect(settings.getByTestId('chrome-import-none')).toBeVisible();
  await checkState(settings, 'dialog:chrome-import');
  await settings.getByTestId('chrome-import-close').click();
  await closeSettings(settings);
  await send(page, 'Thanks.');
});

/** The approval card of `kind`, once it shows. */
async function card(page: Page, kind: string) {
  const found = page.locator(`[data-approval-card="${kind}"]`);
  await expect(found).toBeVisible({ timeout: 30_000 });
  return found;
}

async function allowOnce(page: Page, kind: string): Promise<void> {
  await (
    await card(page, kind)
  )
    .getByRole('button', { name: /^(Allow once|Allow)$/u })
    .first()
    .click();
}

test('approval cards of each kind and the rows of tools and the harness', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(180_000);
  await writeFile(path.join(workspaces, 'outside 外部.txt'), 'outside\n');
  await openSession(app, page, workspaces, 'tools 工具', 't43-tools', 'Do the work.');
  await card(page, 'command');
  await checkState(page, 'approval:command');
  await allowOnce(page, 'command');
  await card(page, 'fileChange');
  await checkState(page, 'approval:fileChange');
  await allowOnce(page, 'fileChange');
  await card(page, 'permissionExpansion');
  await checkState(page, 'approval:permissionExpansion');
  await allowOnce(page, 'permissionExpansion');
  const form = await card(page, 'question');
  await checkState(page, 'approval:question');
  await form.getByRole('radio', { name: /^SQLite/u }).check();
  await form.getByTestId('question-submit').click();
  await idle(page);
  await checkState(page, 'row:commandExecution');
  await checkState(page, 'row:fileChange');
  await checkState(page, 'row:todo');
  await checkState(page, 'row:question');
  await checkState(page, 'row:nextSteps');
  await railTab(page, 'tasks');
  await checkState(page, 'panel:tasks');
});

test('plan mode: the plan card, the plan panel, mode changes and the approved plan', async ({
  app,
  page,
  workspaces,
}) => {
  await openSession(app, page, workspaces, 'plan 计划', 't26-plan', 'Fix the parser bug');
  await card(page, 'plan');
  await expect(page.getByTestId('plan-panel')).toHaveAttribute('data-state', 'pending');
  await checkState(page, 'approval:plan');
  await checkState(page, 'panel:plan');
  await page.locator('[data-approval-card="plan"]').getByTestId('plan-keep-planning').click();
  const second = page.locator('[data-approval-card="plan"]');
  await expect(second).toContainText('Add a failing test for the loop bound', { timeout: 30_000 });
  await second.getByTestId('plan-approve-manual').click();
  await idle(page);
  await checkState(page, 'row:permissionModeChanged');
  await checkState(page, 'row:plan');
});

const REVIEWER =
  '---\nname: reviewer\ndescription: Reviews the build.\ntools: Read, Bash\ncolor: blue\n---\n' +
  'You review builds and report what you found.\n';

test('a subagent card, background tasks and the terminal panel', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(240_000);
  await openSession(app, page, workspaces, 'subagent 子代理', 't31-main', 'Review the build', {
    '.claude/agents/reviewer.md': REVIEWER,
  });
  await allowOnce(page, 'command');
  await idle(page);
  await expect(page.getByTestId('subagent-card')).toHaveAttribute('data-status', 'completed');
  await checkState(page, 'row:subagent');

  await page.getByTestId('new-session').click();
  await page.getByTestId('home-input').fill('Start the watcher [[piarc-scenario:t32-bg]]');
  await page.getByTestId('home-start').click();
  await expect(page.getByTestId('conversation')).toBeVisible({ timeout: 30_000 });
  await idle(page);
  const tasks = page.getByTestId('bg-tasks-card');
  await expect(tasks.getByTestId('bg-task')).toContainText('Running');
  await checkState(page, 'panel:background-tasks-card');
  await tasks.getByRole('button', { name: 'Show all background tasks' }).click();
  const row = page.getByTestId('bg-tasks-panel').getByTestId('bg-panel-task');
  await row.getByRole('button', { name: 'Output' }).click();
  await expect(row.getByTestId('bg-task-output')).toContainText('tick 3');
  await checkState(page, 'panel:background-tasks');
  await railTab(page, 'background-tasks-card');
  await tasks.getByTestId('bg-task-stop').click();

  await page.keyboard.press('Control+Backquote');
  await expect(page.getByTestId('terminal-panel')).toBeVisible();
  await expect(page.getByTestId('tile-background-tasks')).toBeVisible();
  await expect(page.getByRole('textbox', { name: /Terminal|终端/u })).toBeFocused();
  await checkState(page, 'panel:terminal');
  await page.getByTestId('terminal-actions').click();
  await page.getByTestId('terminal-view-text').click();
  await expect(page.getByTestId('terminal-text-dialog')).toBeVisible();
  await checkState(page, 'dialog:terminal-text');
  await page.keyboard.press('Escape');
});

test('the Changes panel with comments, and the rewind dialog', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(120_000);
  await openSession(app, page, workspaces, 'changes 改动', 't42-comments', 'Start.', {
    'notes.ts':
      Array.from(
        { length: 14 },
        (_, i) => `export const n${String(i + 1)} = ${String(i + 1)};`,
      ).join('\n') + '\n',
    '.piarc/settings.json': JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }),
  });
  await idle(page);
  await send(page, 'Edit the files.');
  await expect(
    page.getByTestId('agent-message').filter({ hasText: 'Edited two files.' }),
  ).toHaveCount(1, {
    timeout: 30_000,
  });
  await idle(page);
  await railTab(page, 'changes-card');
  await page.getByTestId('changes-open').click();
  const made = page.locator('[data-testid=changes-file][data-path="src/made.ts"]');
  await made.locator('[data-testid=changes-comment-add][data-side=new][data-line="1"]').click();
  await page.getByTestId('changes-comment-input').fill('Name it differently.');
  await page.getByTestId('changes-comment-save').click();
  await made.locator('[data-testid=changes-comment-add][data-side=new][data-line="2"]').click();
  await page.getByTestId('changes-comment-input').fill('Return the name.');
  await checkState(page, 'panel:changes');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  const target = page.getByTestId('user-row').filter({ hasText: 'Edit the files.' });
  await target.hover();
  await target.getByTestId('rewind-here').click();
  await expect(page.getByTestId('rewind-dialog')).toBeVisible();
  await checkState(page, 'dialog:rewind');
  await page.keyboard.press('Escape');
});

test.describe('web search', () => {
  test.beforeEach(async ({ userDataDir }) => {
    // The native search's auxiliary request has no scenario marker: select by header.
    const file = path.join(userDataDir, 'pi', 'models.json');
    const models = JSON.parse(await readFile(file, 'utf8')) as {
      providers: Record<string, { models: Record<string, unknown>[] }>;
    };
    for (const provider of Object.values(models.providers)) {
      for (const model of provider.models) model.headers = { 'x-piarc-scenario': 't38-search' };
    }
    await writeFile(file, JSON.stringify(models));
    await writeFile(
      path.join(userDataDir, 'settings.json'),
      JSON.stringify({
        modelProviders: { models: { 'piarc-mock/mock-large': { nativeWebSearch: true } } },
        permissions: { allow: ['WebSearch'] },
      }),
    );
  });

  test('a web search with its sources', async ({ app, page, workspaces }) => {
    await openSession(app, page, workspaces, 'search 搜索', 't38-search', 'What is new in PiArc?');
    await idle(page);
    await expect(page.getByTestId('web-search-card')).toHaveAttribute('data-status', 'completed');
    await checkState(page, 'row:webSearch');
  });
});

test('a Browser call with its screenshot, and the preview console', async ({
  app,
  page,
  workspaces,
}) => {
  await openSession(app, page, workspaces, 'browser 浏览器', 'browser-run', 'Check the browser', {
    'logs.html':
      '<!doctype html><title>Logs</title><script>console.log("hello");console.warn("slow");' +
      'setTimeout(() => { throw new TypeError("boom") }, 0);</script>',
    'fail.js': "console.error('boom: the fixture cannot start');\nprocess.exit(3);\n",
    '.piarc/launch.json': JSON.stringify({
      version: '0.2.0',
      configurations: [
        { name: 'broken', runtimeExecutable: 'node', program: 'fail.js', port: 45_179 },
      ],
    }),
  });
  await idle(page);
  const card = page.getByTestId('browser-card');
  await expect(card).toHaveAttribute('data-status', 'completed');
  await expect(card.getByTestId('browser-shot')).toHaveAttribute('data-state', 'shown');
  await checkState(page, 'row:browser');
  // B1.1.1, B4.5: the start page with a launch configuration, and a server that failed.
  // The agent's call may have opened the preview already; its button toggles the tool.
  if (!(await page.getByTestId('tile-preview').isVisible())) {
    await page.getByTestId('tool-preview').click();
  }
  await expect(page.getByTestId('browser-start')).toBeVisible();
  const broken = page.locator('[data-testid="browser-server"][data-name="broken"]');
  await expect(broken).toBeVisible();
  await checkState(page, 'state:browser-start');
  await broken.getByTestId('browser-server-run').click();
  await expect(
    page.locator('[data-testid="browser-server-failed"][data-name="broken"]'),
  ).toBeVisible({ timeout: 60_000 });
  await checkState(page, 'state:browser-server-failed');
  // B1.4.3: the console drawer under a workspace page.
  const address = page.getByTestId('browser-address');
  await address.click();
  await address.fill('./logs.html');
  await address.press('Enter');
  await page.getByTestId('browser-more').click();
  await page.getByRole('menuitem', { name: /Console|控制台/ }).click();
  // The page's three messages (the missing favicon may add a fourth, Chromium's own).
  await expect(page.getByTestId('browser-console')).toContainText('Uncaught TypeError: boom');
  await expect(page.getByTestId('browser-console')).toContainText('slow');
  await checkState(page, 'state:browser-console');
});

test.describe('failures, compaction, reminders and model dialogs', () => {
  test.beforeEach(async ({ userDataDir }) => {
    // Keep almost nothing on compaction, so a short conversation has something to summarize;
    // a second model, so switching models asks first.
    await writeFile(
      path.join(userDataDir, 'pi', 'settings.json'),
      JSON.stringify({ retry: { baseDelayMs: 5 }, compaction: { keepRecentTokens: 1 } }),
    );
    const file = path.join(userDataDir, 'pi', 'models.json');
    const models = JSON.parse(await readFile(file, 'utf8')) as {
      providers: Record<string, { models: Record<string, unknown>[] }>;
    };
    for (const provider of Object.values(models.providers)) {
      const first = provider.models[0];
      if (first !== undefined)
        provider.models.push({ ...first, id: 'mock-small', name: 'mock-small' });
    }
    await writeFile(file, JSON.stringify(models));
  });

  test('error, undelivered, working, compaction, reminder and outcome-unknown rows', async ({
    app,
    page,
    workspaces,
  }) => {
    test.setTimeout(240_000);
    await expectTestHooks(app);
    await openSession(app, page, workspaces, 'views 视图', 't29-views', 'What do the notes say?', {
      'sub/CLAUDE.md': 'Notes directory rule: dates are written as weekdays.',
      'sub/notes.txt': 'Release on Friday.\n',
    });
    await idle(page);
    await page.getByTestId('session-view-options').click();
    await page
      .getByTestId('detail-switch')
      .locator('label')
      .filter({ has: page.getByTestId('detail-detailed') })
      .click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('reminder-row')).toHaveCount(1);
    await checkState(page, 'row:reminder');

    await newSession(page, 'First question', 't27-usage');
    await idle(page);
    await send(page, '/compact');
    await expect(page.getByTestId('compaction-row').last()).toHaveAttribute(
      'data-status',
      'completed',
      {
        timeout: 30_000,
      },
    );
    await checkState(page, 'row:contextCompaction');

    await page.keyboard.press(`${MOD}+Shift+KeyI`);
    await page.getByTestId('model-option-piarc-mock/mock-small').click();
    await expect(page.getByTestId('model-switch-confirm')).toBeVisible();
    // The chosen option is gone: focus moves into the preview, so Esc and Tab still work.
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean(document.activeElement?.closest('[data-testid="model-switch-dialog"]')),
        ),
      )
      .toBe(true);
    await checkState(page, 'dialog:model-switch');
    await page.keyboard.press('Escape');
    await send(page, '/output-style');
    await expect(page.getByTestId('output-style-dialog')).toBeVisible();
    await checkState(page, 'dialog:output-style');
    await page.keyboard.press('Escape');

    await newSession(page, 'Hello', 't19-auth');
    await expect(page.getByTestId('error-card')).toHaveAttribute('data-kind', 'auth', {
      timeout: 20_000,
    });
    await checkState(page, 'row:error');

    await newSession(page, 'Hello', 't19-chat');
    await idle(page);
    await app.evaluate((_electron, channel) => {
      globalThis.__piarcTestHooks?.failNext(channel, 'the main process dropped the message');
    }, IPC_CHANNELS.sessionPrompt);
    await send(page, 'Second question');
    await expect(page.getByTestId('undelivered')).toBeVisible();
    await checkState(page, 'row:optimistic');

    await newSession(page, 'Keep working', 't18-stall');
    await expect(page.getByTestId('working-row')).toBeVisible({ timeout: 20_000 });
    await checkState(page, 'row:working');
    await page.getByTestId('composer-input').click();
    await page.keyboard.press('Escape');
    await idle(page);

    await newSession(page, 'Start the long job', 't19-host');
    await expect(page.getByTestId('agent-message')).toContainText('Working on it', {
      timeout: 20_000,
    });
    await killAgentHost(app);
    await expect(page.getByTestId('uncertain-card')).toBeVisible({ timeout: 30_000 });
    await checkState(page, 'row:uncertain');

    // A session's history while it is read, and when the read fails.
    const reopen = async () => {
      await page.reload();
      await page
        .getByTestId('session-row')
        .filter({ hasText: 'First question' })
        .getByTestId('session-title')
        .click();
    };
    await app.evaluate((_electron, channel) => {
      globalThis.__piarcTestHooks?.holdNext(channel, 30_000);
    }, IPC_CHANNELS.sessionTranscript);
    await reopen();
    await expect(page.getByTestId('conversation-loading')).toBeVisible();
    await checkState(page, 'state:conversation-loading');
    await app.evaluate((_electron, channel) => {
      globalThis.__piarcTestHooks?.failNext(channel, 'unreadable');
    }, IPC_CHANNELS.sessionTranscript);
    await reopen();
    await expect(page.getByTestId('conversation-failed')).toBeVisible();
    await checkState(page, 'state:conversation-failed');
  });
});

test.describe('sign in', () => {
  test.use({ appEnv: { PIARC_TEST_OAUTH_PROVIDER: PROVIDER_FILE } });

  test('the sign-in dialog with a device code', async ({ app, page, mock }) => {
    test.setTimeout(120_000);
    const auth = await startAuth();
    try {
      await writeProvider(auth, mock.baseUrl, 'deviceCode');
      await browserDouble(app);
      await prefer(page, { key: 'language', value: 'en' });
      const settings = await openSettings(page);
      await settings.getByTestId('settings-nav-providers').click();
      await settings.getByTestId('provider-add').click();
      await expect(settings.getByTestId(`login-${PROVIDER}`)).toBeVisible();
      await checkState(settings, 'dialog:add-service');
      await settings.getByTestId(`login-${PROVIDER}`).click();
      await expect(settings.getByTestId('login-user-code')).toBeVisible({ timeout: 30_000 });
      await checkState(settings, 'dialog:sign-in');
      await settings.keyboard.press('Escape');
    } finally {
      auth.stop();
    }
  });
});

test('MCP asks for a form and an external URL', async ({ app, page, workspaces }) => {
  test.setTimeout(120_000);
  await exerciseElicitation(app, page, workspaces, async (state) => {
    await checkState(page, state);
  });
});

test('the Git tool in a repository: changes, commit view, branches and a branch name', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(120_000);
  const { ws } = await openSession(app, page, workspaces, 'git 仓库', 'git-start', 'Start.');
  await makeRepository(ws);
  await idle(page);
  await railTab(page, 'changes-card');
  await page.getByTestId('changes-open').click();
  await expect(page.getByTestId('git-file').first()).toBeVisible();
  await checkState(page, 'state:git-changes');
  await page.getByTestId('git-view-commit').click();
  const readme = page.locator('[data-testid=git-commit-file][data-path="README.md"]');
  await readme.getByTestId('git-file-check').click();
  await expect(readme.getByTestId('git-file-check')).toHaveAttribute('aria-checked', 'true');
  await checkState(page, 'state:git-commit');
  await page.getByTestId('git-branch-button').click();
  await expect(page.getByTestId('git-branch-row').first()).toBeVisible();
  await checkState(page, 'state:git-branches');
  await page.locator('[data-testid=git-branch-row][data-branch="new"]').click();
  await expect(page.getByTestId('git-branch-name-dialog')).toBeVisible();
  await checkState(page, 'dialog:git-prompt');
  await page.keyboard.press('Escape');

  // G3: the Log view with a commit's details (one column at this width), the reset dialog,
  // and a stash.
  await page.getByTestId('git-view-log').click();
  await page.getByTestId('git-log-row').filter({ hasText: 'feat: add login' }).click();
  await expect(page.getByTestId('git-commit-detail')).toBeVisible();
  await checkState(page, 'state:git-log');
  if (await page.getByTestId('git-log-back').isVisible()) {
    await page.getByTestId('git-log-back').click();
  }
  await page
    .getByTestId('git-log-row')
    .filter({ hasText: 'chore: initial commit' })
    .click({ button: 'right' });
  await page.getByTestId('git-log-reset').click();
  await expect(page.getByTestId('git-reset-dialog')).toBeVisible();
  await checkState(page, 'dialog:git-history');
  await page.keyboard.press('Escape');
  await git(ws, 'stash', '-q', '-u', '-m', '半成品 work in progress');
  await page.getByTestId('git-log-mode-stashes').click();
  await page.getByTestId('git-stash-row').click();
  await expect(page.getByTestId('git-stash-detail')).toBeVisible();
  await checkState(page, 'state:git-stashes');
});

test('the Git tool resolving a conflict and rebasing interactively', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(120_000);
  const { ws } = await openSession(app, page, workspaces, 'git 冲突', 'git-start', 'Start.');
  await makeRepository(ws);
  await conflictOnMain(ws);
  await idle(page);
  await railTab(page, 'changes-card');
  await page.getByTestId('changes-open').click();
  await page.getByTestId('git-view-commit').click();
  await page.getByTestId('git-branch-button').click();
  await page.getByTestId('git-branch-search').fill('main');
  await page.locator('[data-testid=git-branch-row][data-branch="main"]').click();
  await page.getByTestId('git-branch-merge').click();
  await page.getByTestId('git-merge-submit').click();
  await expect(page.getByTestId('git-conflict-row')).toBeVisible();
  await checkState(page, 'dialog:git-conflicts');
  await page.getByTestId('git-conflict-merge').click();
  await expect(page.getByTestId('git-merge-conflict')).toBeVisible();
  await checkState(page, 'state:git-merge-view');
  await page.getByTestId('git-merge-apply').click();
  await expect(page.getByTestId('git-merge-unresolved-dialog')).toBeVisible();
  await checkState(page, 'dialog:git-merge-unresolved');
  await page.keyboard.press('Escape');
  await page.getByTestId('git-merge-cancel').click();
  await git(ws, 'merge', '--abort');
  await page.getByTestId('git-view-log').click();
  await page
    .getByTestId('git-log-row')
    .filter({ hasText: 'feat: add login' })
    .click({ button: 'right' });
  await page.getByTestId('git-log-rebase').click();
  await expect(page.getByTestId('git-rebase-row').first()).toBeVisible();
  await checkState(page, 'dialog:git-rebase');
  await page.keyboard.press('Escape');
});

test('the Git tool with a review and a pull request on GitHub', async ({
  app,
  page,
  workspaces,
}) => {
  test.skip(process.platform === 'win32', 'the fake gh is a script with a shebang');
  test.setTimeout(120_000);
  gh.reset();
  const { ws } = await openSession(app, page, workspaces, 'git github', 'git-start', 'Start.');
  await makeRepository(ws);
  await githubRemote(ws);
  await writeFile(
    path.join(ws, 'README.md'),
    '# Demo\n\nA demo project with sign-in. [[piarc-scenario:git-review]]\n',
  );
  await idle(page);
  await railTab(page, 'changes-card');
  await page.getByTestId('changes-open').click();
  await page.getByTestId('git-scope').click();
  await page.getByTestId('git-scope-uncommitted').click();
  await page.getByTestId('git-review').click();
  await expect(page.getByTestId('git-finding').first()).toBeVisible({ timeout: 30_000 });
  await checkState(page, 'state:git-review-inline');
  await prefer(page, { key: 'git.reviewPresentation', value: 'separate' });
  await expect(page.getByTestId('git-review-list')).toBeVisible();
  await checkState(page, 'state:git-review-list');

  await page.getByTestId('git-view-commit').click();
  await page.getByTestId('git-pr-create').click();
  await expect(page.getByTestId('git-pr-dialog')).toBeVisible();
  await checkState(page, 'dialog:git-pull-request');
  await page.getByTestId('git-pr-submit').click();
  await expect(page.getByTestId('git-pr')).toBeVisible({ timeout: 30_000 });
  await checkState(page, 'state:git-pull-request');
});

test('every listed state was checked in this run', async () => {
  const checked = new Set(
    (await readdir(AXE_DIR).catch(() => []))
      .filter((f) => f.endsWith('.checked'))
      .map((f) => f.slice(0, -'.checked'.length)),
  );
  const missing = A11Y_STATES.map((s) => s.id).filter(
    (id) => !checked.has(id.replace(/[^a-z0-9-]+/giu, '_')),
  );
  expect(missing).toEqual([]);
});
