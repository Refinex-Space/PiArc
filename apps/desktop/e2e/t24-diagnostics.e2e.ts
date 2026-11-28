// T24-A10: the Configuration diagnostics page lists every settings file of a workspace with its
// load state, applied keys, keys a higher file overrides (and which file), ignored keys with the
// reason, and parse errors with their position; it follows an edit of a Claude Code file while
// the app runs. Claude Code's files are left byte for byte as they were. Core reads the user's
// files from the test home (`<user data>/test-home`, `createForTests`), never the real one.
// Screenshots go to tmp/evidence/T24/.
import { openSettings } from './settings-panel.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';

import { expect, focusMain, makeWorkspace, openFolder, startSession, test } from './sessions.js';
import { prefer } from './t19.js';

const EVIDENCE = path.join(import.meta.dirname, '..', '..', '..', 'tmp', 'evidence', 'T24');

const PROJECT = JSON.stringify({
  permissions: {
    allow: ['Bash(npm test)'],
    ask: ['Bash(git push *)'],
    defaultMode: 'acceptEdits',
  },
  hooks: {},
  env: { L4_SAMPLE: '1' },
});
// A trailing comma: line 1, column 44.
const BROKEN_LOCAL = '{ "permissions": { "deny": [ "Read(.env)", ] } }';
const USER = JSON.stringify({
  permissions: { deny: ['Bash(rm -rf *)'], defaultMode: 'plan' },
  theme: 'dark',
});

async function openDiagnostics(page: Page): Promise<Page> {
  const settings = await openSettings(page);
  await settings.getByTestId('settings-nav-diagnostics').click();
  await settings.getByTestId('config-diagnostics').waitFor();
  return settings;
}

test('configuration diagnostics explain every file and follow a Claude Code edit', async ({
  app,
  page,
  workspaces,
  userDataDir,
}) => {
  test.setTimeout(120_000);
  await mkdir(EVIDENCE, { recursive: true });
  const home = path.join(userDataDir, 'test-home');
  await mkdir(path.join(home, '.claude'), { recursive: true });
  await writeFile(path.join(home, '.claude', 'settings.json'), USER);
  await writeFile(
    path.join(home, '.claude.json'),
    JSON.stringify({ numStartups: 2, mcpServers: {} }),
  );
  await prefer(page, { key: 'language', value: 'en' });
  const ws = await makeWorkspace(workspaces, 'diagnostics 诊断', {
    '.claude/settings.json': PROJECT,
    '.claude/settings.local.json': BROKEN_LOCAL,
    '.piarc/settings.json': JSON.stringify({
      permissions: { defaultMode: 'default', deny: ['Write(secrets/**)'] },
    }),
  });
  await openFolder(page, app, ws);
  // Not trusted: the project's allow rule and mode wait for trust.
  await startSession(page, 'Hello', 't18-chat', 'deny');
  await focusMain(app);
  const settings = await openDiagnostics(page);
  await expect(settings.getByTestId('diagnostics-trust')).toContainText('not trusted');

  const project = settings.getByTestId('diagnostics-file-claudeProject');
  await expect(project.getByTestId('diagnostics-status')).toHaveText(
    'Partly applied until you trust this project',
  );
  await expect(project).toContainText(path.join(ws, '.claude', 'settings.json'));
  await expect(project).toContainText('Read only');
  await project.getByTestId('diagnostics-details').locator('summary').click();
  const ignored = project.getByTestId('diagnostics-ignored-key');
  // `hooks` applies since T25; the empty object has no leaf to list.
  await expect(ignored).toHaveText([
    '/env PiArc does not use this setting',
    '/permissions/allow Waits until you trust this project',
    '/permissions/defaultMode Waits until you trust this project',
  ]);
  await expect(
    project.getByTestId('diagnostics-effective').getByTestId('diagnostics-key'),
  ).toHaveText([/\/permissions\/ask.*Bash\(git push \*\).*Merged from every file/]);

  const local = settings.getByTestId('diagnostics-file-claudeProjectLocal');
  await expect(local.getByTestId('diagnostics-status')).toHaveText('Could not be read');
  await expect(local.getByTestId('diagnostics-issues')).toContainText('Line 1, column 44:');

  const user = settings.getByTestId('diagnostics-file-claudeUser');
  await expect(user).toContainText(path.join(home, '.claude', 'settings.json'));
  await user.getByTestId('diagnostics-details').locator('summary').click();
  const overridden = user.getByTestId('diagnostics-overridden').getByTestId('diagnostics-key');
  await expect(overridden).toHaveText([
    /\/permissions\/defaultMode\s*"plan"\s*"default"\s*\.piarc\/settings\.json/,
  ]);
  await expect(user.getByTestId('diagnostics-ignored-key')).toHaveText([
    '/theme PiArc does not use this setting',
  ]);

  const state = settings.getByTestId('diagnostics-file-claudeState');
  await expect(state.getByTestId('diagnostics-status')).toHaveText('Loaded');
  await state.getByTestId('diagnostics-details').locator('summary').click();
  // T36: the user's MCP servers apply (listed by server name only).
  await expect(
    state.getByTestId('diagnostics-effective').getByTestId('diagnostics-key'),
  ).toHaveText([/^\/mcpServers/]);
  await expect(state.getByTestId('diagnostics-ignored-key')).toHaveText([
    '/numStartups PiArc does not use this setting',
  ]);
  await expect(
    settings.getByTestId('diagnostics-file-projectLocal').getByTestId('diagnostics-status'),
  ).toHaveText('Not present');
  await settings.getByTestId('settings-page-diagnostics').evaluate((el) => {
    el.scrollTop = 0;
  });
  await settings.screenshot({ path: path.join(EVIDENCE, 'diagnostics-en.png') });
  for (const [name, section] of [
    ['project', project],
    ['local-broken', local],
    ['user', user],
    ['state', state],
  ] as const) {
    await section.screenshot({ path: path.join(EVIDENCE, `diagnostics-en-${name}.png`) });
  }

  // Fixing the broken file while the app runs: the page follows Core's settings event.
  await writeFile(
    path.join(ws, '.claude', 'settings.local.json'),
    '{ "permissions": { "deny": [ "Read(.env)" ] } }',
  );
  await expect(local.getByTestId('diagnostics-status')).toHaveText('Loaded', { timeout: 15_000 });
  await local.getByTestId('diagnostics-details').locator('summary').click();
  await expect(
    local.getByTestId('diagnostics-effective').getByTestId('diagnostics-key'),
  ).toHaveText([/\/permissions\/deny.*Read\(\.env\)/]);
  await local.screenshot({ path: path.join(EVIDENCE, 'diagnostics-after-edit.png') });

  await prefer(page, { key: 'language', value: 'zh-CN' });
  await expect(settings.getByTestId('diagnostics-trust')).toContainText('未受信任');
  await settings.getByTestId('settings-page-diagnostics').evaluate((el) => {
    el.scrollTop = 0;
  });
  await settings.screenshot({ path: path.join(EVIDENCE, 'diagnostics-zh-CN.png') });
  await user.screenshot({ path: path.join(EVIDENCE, 'diagnostics-zh-CN-user.png') });

  // I85: a rule that never matches names the one to write; Claude Code sources are listed.
  await settings.getByTestId('settings-nav-permissions').click();
  await expect(settings.getByTestId('permission-source-claudeUser')).toContainText(
    'Bash(rm -rf *)',
  );
  await expect(
    settings.getByTestId('permission-source-project').getByTestId('permission-suggestion'),
  ).toHaveText('永不匹配，请改写为 Edit(secrets/**)');
  await settings
    .getByTestId('permission-source-project')
    .screenshot({ path: path.join(EVIDENCE, 'permissions-suggestion-zh-CN.png') });

  // PiArc read the Claude Code files and wrote none of them.
  expect(await readFile(path.join(ws, '.claude', 'settings.json'), 'utf8')).toBe(PROJECT);
  expect(await readFile(path.join(home, '.claude', 'settings.json'), 'utf8')).toBe(USER);
});
