// T43-A01: axe on every state of the accessibility state list (`a11y/states.ts`), light and
// dark, with the real Core, Agent Host and mock provider. Journeys reach the states the way a
// user does; `checkState` writes each axe result to tmp/evidence/T43/axe/ and fails on any
// violation. The last test checks every listed state was reached in this run.
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ElectronApplication, Page } from '@playwright/test';

import { AXE_DIR, checkState } from './a11y.js';
import { A11Y_STATES } from './a11y/states.js';
import { expect, focusMain, makeWorkspace, openFolder, test } from './sessions.js';
import { IPC_CHANNELS } from '../src/shared/ipc.js';
import { expectTestHooks } from './core.js';
import { browserDouble, PROVIDER, PROVIDER_FILE, startAuth, writeProvider } from './oauth.js';
import { idle, killAgentHost, openSession, prefer, send } from './t19.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

async function openSettings(app: ElectronApplication, page: Page): Promise<Page> {
  const opened = app.waitForEvent('window');
  await page.getByTestId('open-settings').click();
  const settings = await opened;
  await settings.getByTestId('settings-window').waitFor();
  return settings;
}

/** Starts another session in the open workspace with `scenario`. */
async function newSession(page: Page, text: string, scenario: string): Promise<void> {
  await page.getByTestId('new-session').click();
  await page.getByTestId('home-input').fill(`${text} [[piarc-scenario:${scenario}]]`);
  await page.getByTestId('home-start').click();
  await expect(page.getByTestId('conversation')).toBeVisible({ timeout: 30_000 });
}

/** Opens a rail tab (card) by its panel id. */
async function railTab(page: Page, panel: string): Promise<void> {
  await page.getByTestId(`panel-tab-${panel}`).click();
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
    '.piarc/settings.json': JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'true' }] }] },
    }),
  });
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

  await page.getByTestId('session-filter').fill('Friday');
  await expect(page.getByTestId('search-hit').first()).toBeVisible({ timeout: 20_000 });
  await checkState(page, 'window:message-search');
  await page.getByTestId('session-filter').fill('');

  // A plugin with a hook (an executable item), installed off, for the Skills & plugins page.
  const plugin = path.join(workspaces, 'packages 包', 'demo');
  await makeWorkspace(path.dirname(plugin), 'demo', {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
    'commands/hello.md': '---\ndescription: Say hello\n---\nHello.\n',
    'hooks/hooks.json': JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo plugin-stop' }] }] },
    }),
  });
  const settings = await openSettings(app, page);
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
    'providers',
    'permissions',
    'sandbox',
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
  await page.getByTestId('panel-tab-tasks').click();
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
  await tasks.getByTestId('bg-task-stop').click();

  await page.keyboard.press('Control+Backquote');
  await expect(page.getByTestId('terminal-panel')).toBeVisible();
  await expect(page.getByRole('textbox', { name: /Terminal|终端/u })).toBeFocused();
  await checkState(page, 'panel:terminal');
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
    await page
      .getByTestId('detail-switch')
      .locator('label')
      .filter({ has: page.getByTestId('detail-detailed') })
      .click();
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
      const settings = await openSettings(app, page);
      await settings.getByTestId('settings-nav-providers').click();
      await settings.getByTestId(`login-${PROVIDER}`).click();
      await expect(settings.getByTestId('login-user-code')).toBeVisible({ timeout: 30_000 });
      await checkState(settings, 'dialog:sign-in');
      await settings.keyboard.press('Escape');
    } finally {
      auth.stop();
    }
  });
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
