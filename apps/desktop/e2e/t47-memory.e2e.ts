// T47 L4: auto memory in the window and managed settings' lock marks.
// - A02, A05: the agent saves a note; the transcript says "Saved memory · build" and links to
//   the note on the settings window's memory page, where it is viewed, edited and deleted;
//   Claude Code's memory is imported once; turning auto memory off leaves the Memory tool out
//   of the next session's request; nothing is written under `.claude/` (A06).
// - A10, A12: managed settings (PiArc's file and Claude Code's, in this platform's layout under
//   a fake system root, `PIARC_TEST_MANAGED_ROOT`) show a banner, lock marks and read-only
//   controls; the diagnostics list the Claude Code file's ignored keys.
// Screenshots go to tmp/evidence/T47/.
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ElectronApplication, Page } from '@playwright/test';

import {
  expect,
  filesNamed,
  focusMain,
  makeWorkspace,
  mockRequests,
  openFolder,
  startSession,
  test,
} from './sessions.js';
import { prefer, send } from './t19.js';

const EVIDENCE = path.join(import.meta.dirname, '..', '..', '..', 'tmp', 'evidence', 'T47');

async function openSettings(app: ElectronApplication, page: Page): Promise<Page> {
  const opened = app.waitForEvent('window');
  await page.getByTestId('open-settings').click();
  const settings = await opened;
  await settings.getByTestId('settings-window').waitFor();
  return settings;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Claude Code's project key of a checkout: every character but ASCII letters and digits → `-`. */
function claudeProjectKey(checkout: string): string {
  return checkout.replace(/[^A-Za-z0-9]/gu, '-');
}

test('the agent saves a note; the transcript and the memory page show, edit and delete it', async ({
  app,
  page,
  mock,
  userDataDir,
  workspaces,
}) => {
  test.setTimeout(150_000);
  await mkdir(EVIDENCE, { recursive: true });
  await prefer(page, { key: 'language', value: 'en' });
  const ws = await makeWorkspace(workspaces, 'memory 记忆', { 'a.txt': 'alpha\n' });
  // Claude Code's memory of the same project, for the import (read only).
  const home = path.join(userDataDir, 'test-home');
  const claudeMemory = path.join(home, '.claude', 'projects', claudeProjectKey(ws), 'memory');
  await mkdir(claudeMemory, { recursive: true });
  await writeFile(
    path.join(claudeMemory, 'style.md'),
    '---\nname: style\ndescription: Tabs, not spaces\ntype: feedback\n---\nIndent with tabs.\n',
  );
  const claudeBefore = await readFile(path.join(claudeMemory, 'style.md'), 'utf8');

  await openFolder(page, app, ws);
  await startSession(page, 'Remember how we build.', 't47-save');
  const summary = page.getByTestId('tool-summary').filter({ hasText: 'Saved memory · build' });
  await expect(summary).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('agent-message').last()).toContainText('Saved the note.', {
    timeout: 30_000,
  });
  const [request] = await mockRequests(mock, 't47-save');
  expect(request?.tools).toContain('Memory');
  // The note and the index are in the data directory's auto memory, not under `.claude/`.
  const notes = await filesNamed(path.join(userDataDir, 'auto-memory'), 'build.md');
  expect(notes).toHaveLength(1);
  expect(await filesNamed(path.join(userDataDir, 'auto-memory'), 'MEMORY.md')).toHaveLength(1);
  await page.screenshot({ path: path.join(EVIDENCE, 'transcript-saved-memory.png') });

  // "Open in settings" opens the memory page on this workspace with the note expanded.
  await summary.click();
  const opened = app.waitForEvent('window');
  await page.getByTestId('memory-open-settings').click();
  const settings = await opened;
  await settings.getByTestId('memory-page').waitFor();
  await expect(settings.getByTestId('memory-workspace')).toHaveValue(ws);
  const note = settings.getByTestId('memory-note-build');
  await expect(note).toContainText('Run cargo check before committing');
  await expect(note.locator('pre')).toContainText('cargo check --workspace');
  await expect(settings.getByTestId('memory-state')).toContainText('On:');
  await settings.screenshot({ path: path.join(EVIDENCE, 'memory-page-light.png') });

  // Edit the description and the type.
  await note.getByTestId('memory-edit-build').click();
  await note.getByTestId('memory-edit-description').fill('Check the workspace before a commit');
  await note.getByTestId('memory-edit-type').selectOption('feedback');
  await note.getByTestId('memory-edit-save').click();
  await expect(settings.getByTestId('memory-note-build')).toContainText(
    'Check the workspace before a commit',
  );
  await expect(settings.getByTestId('memory-note-build')).toContainText('Edited by you');
  const index = await readFile(path.join(path.dirname(notes[0] ?? ''), 'MEMORY.md'), 'utf8');
  expect(index).toContain('Check the workspace before a commit');

  // Import Claude Code's note once; the source stays as it was.
  await expect(settings.getByTestId('memory-import')).toContainText('1 memory file');
  await settings.getByTestId('memory-import-button').click();
  await expect(settings.getByTestId('memory-note-style')).toContainText('Tabs, not spaces');
  await expect(settings.getByTestId('memory-note-style')).toContainText('Imported');
  expect(await readFile(path.join(claudeMemory, 'style.md'), 'utf8')).toBe(claudeBefore);
  await settings.getByTestId('memory-filter').selectOption('feedback');
  await expect(settings.getByTestId('memory-list').locator('li')).toHaveCount(2);
  await settings.getByTestId('memory-filter').selectOption('project');
  await expect(settings.getByTestId('memory-list').locator('li')).toHaveCount(0);
  await settings.getByTestId('memory-filter').selectOption('all');
  await prefer(page, { key: 'appearance.theme', value: 'dark' });
  await settings.screenshot({ path: path.join(EVIDENCE, 'memory-page-dark.png') });
  await prefer(page, { key: 'language', value: 'zh-CN' });
  await expect(settings.getByTestId('memory-note-style')).toContainText('导入');
  await settings.screenshot({ path: path.join(EVIDENCE, 'memory-page-zh-CN-dark.png') });
  await prefer(page, { key: 'appearance.theme', value: 'light' });
  await prefer(page, { key: 'language', value: 'en' });

  // Delete one note (two clicks), then turn auto memory off for the user.
  await settings.getByTestId('memory-open-style').click();
  await settings.getByTestId('memory-delete-style').click();
  await settings.getByTestId('memory-delete-style').click();
  await expect(settings.getByTestId('memory-note-style')).toHaveCount(0);
  // The switch follows Core's answer, not the click (like the other settings Core writes).
  await settings.getByTestId('memory-user-enabled').click();
  await expect(settings.getByTestId('memory-user-enabled')).not.toBeChecked();
  await expect(settings.getByTestId('memory-state')).toContainText('Off:');
  const userSettings = JSON.parse(
    await readFile(path.join(userDataDir, 'settings.json'), 'utf8'),
  ) as { autoMemoryEnabled?: unknown };
  expect(userSettings.autoMemoryEnabled).toBe(false);

  // A new session has no Memory tool (A05).
  await focusMain(app);
  await page.getByTestId('new-session').click();
  await startSession(page, 'Anything to remember?', 't47-off', 'none');
  await expect(page.getByTestId('agent-message').last()).toContainText(
    'Nothing to remember here.',
    { timeout: 30_000 },
  );
  const [off] = await mockRequests(mock, 't47-off');
  expect(off?.tools).not.toContain('Memory');

  // `/memory` brings the open settings window back to the memory page on this workspace.
  await settings.getByTestId('settings-nav-general').click();
  await expect(settings.getByTestId('memory-page')).toHaveCount(0);
  await send(page, '/memory');
  await expect(settings.getByTestId('memory-page')).toBeVisible({ timeout: 15_000 });
  await expect(settings.getByTestId('memory-workspace')).toHaveValue(ws);

  // Nothing under `.claude/` was written: not in the workspace, not in the test home.
  expect(await exists(path.join(ws, '.claude'))).toBe(false);
  expect(await filesNamed(path.join(home, '.claude'), '.md')).toEqual([
    path.join(claudeMemory, 'style.md'),
  ]);
});

/** A fake system root with PiArc's and Claude Code's managed files in this platform's layout. */
async function managedRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'piarc t47 managed 托管-'));
  const base =
    process.platform === 'win32'
      ? path.join(root, 'Program Files')
      : path.join(root, 'Library', 'Application Support');
  await mkdir(path.join(base, 'PiArc'), { recursive: true });
  await mkdir(path.join(base, 'ClaudeCode'), { recursive: true });
  await writeFile(
    path.join(base, 'PiArc', 'managed-settings.json'),
    JSON.stringify({
      autoMemoryEnabled: false,
      outputStyle: 'Concise',
      sandbox: { enabled: true },
      permissions: { enableBypassPermissions: false },
    }),
  );
  await writeFile(
    path.join(base, 'ClaudeCode', 'managed-settings.json'),
    JSON.stringify({
      permissions: { deny: ['Bash(curl:*)'] },
      allowManagedPermissionRulesOnly: true,
      cleanupPeriodDays: 30,
    }),
  );
  return root;
}

const managedTest = test.extend<{ managedRoot: string }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern here.
  managedRoot: async ({}, use) => {
    const root = await managedRoot();
    await use(root);
    await rm(root, { recursive: true, force: true });
  },
  appEnv: async ({ managedRoot }, use) => {
    await use({ PIARC_TEST_MANAGED_ROOT: managedRoot });
  },
});

managedTest.describe('managed settings', () => {
  managedTest(
    'lock their settings in the window and are listed in the diagnostics',
    async ({ app, page, workspaces }) => {
      managedTest.setTimeout(120_000);
      await mkdir(EVIDENCE, { recursive: true });
      await prefer(page, { key: 'language', value: 'en' });
      const ws = await makeWorkspace(workspaces, 'managed 托管', { 'a.txt': 'alpha\n' });
      await openFolder(page, app, ws);
      await startSession(page, 'Hello', 't18-chat', 'trust');
      await focusMain(app);
      const settings = await openSettings(app, page);
      await expect(settings.getByTestId('managed-banner')).toContainText(
        'Some settings are managed by your organization.',
      );

      await settings.getByTestId('settings-nav-memory').click();
      await expect(settings.getByTestId('memory-managed')).toBeVisible();
      await expect(settings.getByTestId('memory-user-enabled')).toBeDisabled();
      await expect(settings.getByTestId('memory-project-enabled')).toBeDisabled();
      await expect(settings.getByTestId('memory-state')).toContainText('Off:');
      await settings.screenshot({ path: path.join(EVIDENCE, 'managed-memory.png') });

      await settings.getByTestId('settings-nav-permissions').click();
      await expect(settings.getByTestId('managed-bypass')).toBeVisible();
      await expect(settings.getByTestId('setting-enable-bypass')).toBeDisabled();
      const enterprise = settings.getByTestId('permission-source-enterprise');
      await expect(enterprise).toContainText('Bash(curl:*)');
      await expect(enterprise.getByTestId('managed-rules-enterprise')).toBeVisible();
      // Only the organization's rules apply: the user's file is not edited here.
      await expect(settings.getByTestId('managed-rules-user')).toBeVisible();
      await expect(settings.getByTestId('permission-add-user')).toHaveCount(0);
      await settings.screenshot({ path: path.join(EVIDENCE, 'managed-permissions.png') });

      await settings.getByTestId('settings-nav-sandbox').click();
      await expect(settings.getByTestId('managed-sandbox-enabled')).toBeVisible();
      await expect(settings.getByTestId('sandbox-enabled')).toBeDisabled();
      await settings.getByTestId('settings-nav-skills').click();
      await expect(settings.getByTestId('managed-output-style')).toBeVisible();
      await expect(settings.getByTestId('output-style-select')).toBeDisabled();
      await settings.screenshot({ path: path.join(EVIDENCE, 'managed-skills.png') });

      // The diagnostics list both documents; Claude Code's unsupported key is ignored.
      await settings.getByTestId('settings-nav-diagnostics').click();
      const managed = settings.getByTestId('diagnostics-kind-enterprise');
      await expect(managed).toContainText('managed-settings.json');
      await managed.getByTestId('diagnostics-details').last().locator('summary').click();
      await expect(managed.getByTestId('diagnostics-ignored-key')).toContainText([
        /cleanupPeriodDays/u,
      ]);
      await managed.scrollIntoViewIfNeeded();
      await settings.screenshot({ path: path.join(EVIDENCE, 'managed-diagnostics.png') });
      await prefer(page, { key: 'language', value: 'zh-CN' });
      await settings.getByTestId('settings-nav-memory').click();
      await expect(settings.getByTestId('managed-banner')).toContainText('部分设置由你的组织管理');
      await settings.screenshot({ path: path.join(EVIDENCE, 'managed-memory-zh-CN.png') });
      await prefer(page, { key: 'language', value: 'en' });
    },
  );
});
