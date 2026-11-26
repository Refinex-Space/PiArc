// The Git tool (ADR-0084, ADR-0085, ADR-0086) with the real Core, Agent Host and mock provider on
// a real repository: the Changes view's scopes (all changes against the base branch, uncommitted,
// one commit), the commits list, go to file and side by side; the Commit view's staging
// checkboxes, the generated commit message in the interface language, the commit, the branch
// popup (check out, new branch with the prefix), and rollback through the native confirmation
// with undo. Every write is checked with git itself. Screenshots go to tmp/evidence/git/ with
// PIARC_EVIDENCE_TASK=git.
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ElectronApplication, Locator, Page } from '@playwright/test';

import { expect, test } from './sessions.js';
import { idle, openSession, prefer, requests, screenshots } from './t19.js';

const run = promisify(execFile);
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Git without the machine's configuration. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    },
  });
  return stdout.trim();
}

const APP =
  Array.from(
    { length: 30 },
    (_, i) => `export const line${String(i + 1)} = ${String(i + 1)};`,
  ).join('\n') + '\n';

/** main: README and src/app.ts; feature/login: one more commit; then uncommitted changes. */
async function makeRepository(ws: string): Promise<void> {
  await git(ws, 'init', '-q', '-b', 'main');
  for (const [key, value] of [
    ['user.name', 'PiArc Test'],
    ['user.email', 'test@example.invalid'],
    ['commit.gpgsign', 'false'],
  ] as const) {
    await git(ws, 'config', key, value);
  }
  await writeFile(path.join(ws, 'src', 'app.ts'), APP);
  await writeFile(path.join(ws, 'README.md'), '# Demo\n\nA demo project.\n');
  await git(ws, 'add', '-A');
  await git(ws, 'commit', '-q', '-m', 'chore: initial commit');
  await git(ws, 'checkout', '-q', '-b', 'feature/login');
  await writeFile(path.join(ws, 'src', 'app.ts'), APP.replace('line3 = 3', "line3 = 'three'"));
  await writeFile(
    path.join(ws, 'src', 'login.ts'),
    'export function login(): boolean {\n  return true;\n}\n',
  );
  await git(ws, 'add', '-A');
  await git(ws, 'commit', '-q', '-m', 'feat: add login');
  await writeFile(path.join(ws, 'README.md'), '# Demo\n\nA demo project with sign-in.\n');
  await writeFile(path.join(ws, 'notes.txt'), 'remember the tests\n');
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

function files(page: Page) {
  return page.getByTestId('git-files').getByTestId('git-file');
}

async function filePaths(page: Page): Promise<string[]> {
  return (
    await files(page).evaluateAll((rows) => rows.map((r) => r.getAttribute('data-path') ?? ''))
  ).sort();
}

async function openGit(page: Page, card?: (card: Locator) => Promise<void>): Promise<void> {
  await page.getByTestId('panel-tab-changes-card').click();
  await expect(page.getByTestId('git-card')).toBeVisible();
  await card?.(page.getByTestId('git-card'));
  await page.getByTestId('changes-open').click();
  await expect(page.getByTestId('git-panel')).toBeVisible();
}

test('the Changes view shows the branch, uncommitted and one commit, with go to file and side by side', async ({
  app,
  page,
  workspaces,
}, info) => {
  const { ws } = await openSession(app, page, workspaces, 'git-changes', 'git-start', 'Start.', {
    'src/.keep': '',
  });
  await makeRepository(ws);
  await idle(page);
  // The rail's card: branch and uncommitted files.
  await openGit(page, async (card) => {
    await expect(card).toContainText('feature/login');
    await expect(card).toContainText('2 uncommitted files');
  });

  // All changes against main: the branch's commit and what is not committed yet.
  await expect
    .poll(() => filePaths(page))
    .toEqual(['README.md', 'notes.txt', 'src/app.ts', 'src/login.ts']);
  await expect(page.getByTestId('git-scope')).toContainText('main');
  const app3 = page.locator('[data-testid=git-file-section][data-path="src/app.ts"]');
  await expect(app3.getByTestId('git-diff')).toContainText("line3 = 'three'");
  await expect(page.getByTestId('git-commit-row')).toContainText('feat: add login');
  await screenshots(page, info, 'git-changes-all');

  // Uncommitted only.
  await page.getByTestId('git-scope').click();
  await page.getByTestId('git-scope-uncommitted').click();
  await expect.poll(() => filePaths(page)).toEqual(['README.md', 'notes.txt']);

  // One commit, from the commits list.
  await page.getByTestId('git-commit-row').filter({ hasText: 'feat: add login' }).click();
  await expect.poll(() => filePaths(page)).toEqual(['src/app.ts', 'src/login.ts']);

  // Go to file, then side by side.
  await page.getByTestId('git-goto').click();
  await page.getByTestId('git-goto-input').fill('logi');
  await page.keyboard.press('Enter');
  await expect(
    page.locator('[data-testid=git-file-section][data-path="src/login.ts"]'),
  ).toHaveAttribute('data-current', 'true');
  // Side by side needs room: in a narrow tile it falls back to one column and says so.
  await page.getByTestId('git-menu').click();
  await expect(page.getByTestId('git-menu-split')).toContainText('Needs a wider panel');
  await page.getByTestId('git-menu-split').click();
  await expect(page.locator('.git-table.is-split')).toHaveCount(0);
  await page.getByTestId('tile-maximize-changes').click();
  await expect(page.locator('.git-table.is-split').first()).toBeVisible();
  await screenshots(page, info, 'git-changes-commit-split');
});

test('the Commit view stages, writes the message in the interface language, commits and switches branches', async ({
  app,
  page,
  workspaces,
  mock,
}, info) => {
  const { ws } = await openSession(app, page, workspaces, 'git-commit', 'git-start', 'Start.', {
    'src/.keep': '',
  });
  await makeRepository(ws);
  await idle(page);
  await prefer(page, {
    key: 'git.commitInstructions',
    value: 'Use Conventional Commits. [[piarc-scenario:git-commit-message]]',
  });
  await openGit(page);
  await page.getByTestId('git-view-commit').click();
  await expect(page.getByTestId('git-commit-view')).toBeVisible();
  await expect(page.getByTestId('git-branch-button')).toContainText('feature/login');

  // Stage README.md with its checkbox and the untracked group with the group's.
  const readme = page.locator('[data-testid=git-commit-file][data-path="README.md"]');
  await expect(readme.getByTestId('git-file-check')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('git-commit')).toBeDisabled();
  await readme.getByTestId('git-file-check').click();
  await expect(readme.getByTestId('git-file-check')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => git(ws, 'diff', '--cached', '--name-only')).toBe('README.md');
  await page.getByTestId('git-group-check-untracked').click();
  await expect.poll(() => git(ws, 'diff', '--cached', '--name-only')).toBe('README.md\nnotes.txt');

  // The selected file's staged hunk, with its unstage button.
  await readme.click();
  await expect(page.getByTestId('git-stage-staged')).toContainText('with sign-in');
  await expect(page.getByTestId('git-unstage-hunk')).toBeVisible();
  // A narrow tool shows one column: the diff replaced the list until "Back".
  if (await page.getByTestId('git-commit-back').isVisible()) {
    await page.getByTestId('git-commit-back').click();
  }

  // Generate: one auxiliary request with the instructions, in English (the interface language).
  await page.getByTestId('git-generate').click();
  await expect(page.getByTestId('git-commit-message')).toHaveValue(
    'docs: describe the sign-in flow',
    { timeout: 30_000 },
  );
  const asked = await requests(mock, 'git-commit-message');
  expect(asked).toHaveLength(1);
  const body = JSON.stringify(asked[0]?.body);
  expect(body).toContain('README.md');
  expect(body).toContain('English');
  await screenshots(page, info, 'git-commit-view');

  // Commit with Mod+Enter.
  await page.getByTestId('git-commit-message').click();
  await page.keyboard.press(`${MOD}+Enter`);
  await expect
    .poll(() => git(ws, 'log', '-1', '--format=%s'))
    .toBe('docs: describe the sign-in flow');
  await expect(page.getByTestId('git-notice').filter({ hasText: 'Committed' })).toBeVisible();
  await expect(page.getByTestId('git-commit-clean')).toBeVisible();

  // The branch popup: check out main, then a new branch that starts with the prefix.
  await prefer(page, { key: 'git.branchPrefix', value: 'me/' });
  await page.getByTestId('git-branch-button').click();
  await expect(page.getByTestId('git-branch-popup')).toBeVisible();
  await screenshots(page, info, 'git-branch-popup');
  await page.getByTestId('git-branch-search').fill('main');
  await page.locator('[data-testid=git-branch-row][data-branch="main"]').click();
  await page.getByTestId('git-branch-checkout').click();
  await expect.poll(() => git(ws, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  await expect(page.getByTestId('git-branch-button')).toContainText('main');

  await page.getByTestId('git-branch-button').click();
  await page.locator('[data-testid=git-branch-row][data-branch="new"]').click();
  const name = page.getByTestId('git-branch-name');
  await expect(name).toHaveValue('me/');
  await name.pressSequentially('docs');
  await page.getByTestId('git-branch-name-submit').click();
  await expect.poll(() => git(ws, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('me/docs');
});

test('rolling back asks natively, keeps the bytes and undoes', async ({
  app,
  page,
  workspaces,
}, info) => {
  const { ws } = await openSession(app, page, workspaces, 'git-rollback', 'git-start', 'Start.', {
    'src/.keep': '',
  });
  await makeRepository(ws);
  await idle(page);
  const changed = await readFile(path.join(ws, 'README.md'), 'utf8');
  await openGit(page);
  await page.getByTestId('git-view-commit').click();
  const readme = page.locator('[data-testid=git-commit-file][data-path="README.md"]');
  await readme.click({ button: 'right' });

  // Refused first: nothing changes.
  await answerNext(app, false);
  await page.getByTestId('git-commit-rollback').click();
  await expect.poll(async () => (await confirmations(app)).length).toBe(1);
  expect((await confirmations(app))[0]?.message).toContain('Roll back 1 file?');
  expect(await readFile(path.join(ws, 'README.md'), 'utf8')).toBe(changed);

  // Accepted: back to HEAD, then undone from the notice.
  await readme.click({ button: 'right' });
  await answerNext(app, true);
  await page.getByTestId('git-commit-rollback').click();
  await expect.poll(() => git(ws, 'status', '--porcelain', '--', 'README.md')).toBe('');
  await expect(
    page.getByTestId('git-notice').filter({ hasText: 'Rolled back 1 file.' }),
  ).toBeVisible();
  await screenshots(page, info, 'git-rollback-notice');
  await page.getByTestId('git-notice-undo').click();
  await expect.poll(() => readFile(path.join(ws, 'README.md'), 'utf8')).toBe(changed);
});

test('the Git settings page saves to the user file and asks before always force pushing', async ({
  app,
  page,
  workspaces,
  userDataDir,
}, info) => {
  await openSession(app, page, workspaces, 'git-settings', 'git-start', 'Start.');
  await idle(page);
  await page.keyboard.press(`${MOD}+,`);
  const settings = page;
  await settings.getByTestId('settings-nav-git').click();
  await expect(settings.getByTestId('settings-page-git')).toBeVisible();
  await settings.getByTestId('git-setting-prefix').fill('feature/');
  await settings.getByTestId('git-setting-prefix-save').click();
  await settings.getByTestId('git-setting-protected-input').fill('release/*');
  await settings.getByTestId('git-setting-protected-input').press('Enter');
  await settings.getByTestId('git-setting-pull-rebase').click();
  const file = path.join(userDataDir, 'settings.json');
  await expect
    .poll(async () => (JSON.parse(await readFile(file, 'utf8')) as { git?: unknown }).git)
    .toEqual({
      branchPrefix: 'feature/',
      protectedBranches: ['main', 'master', 'release/*'],
      pullMode: 'rebase',
    });

  // Always force push: the main process asks; refusing leaves it off.
  await app.evaluate(({ dialog }) => {
    const shown: string[] = [];
    (globalThis as { __gitForceAsked?: string[] }).__gitForceAsked = shown;
    dialog.showMessageBox = (...args: unknown[]) => {
      const options = args.at(-1) as { message?: string };
      shown.push(options.message ?? '');
      return Promise.resolve({ response: 1, checkboxChecked: false });
    };
  });
  // Refused natively, so the box stays clear (`check()` would insist on a change).
  await settings.getByTestId('git-setting-force-push').click();
  await expect
    .poll(() =>
      app.evaluate(() => (globalThis as { __gitForceAsked?: string[] }).__gitForceAsked ?? []),
    )
    .toEqual(['Always force push?']);
  await expect(settings.getByTestId('git-setting-force-push')).not.toBeChecked();
  const saved = JSON.parse(await readFile(file, 'utf8')) as { git?: Record<string, unknown> };
  expect(saved.git?.alwaysForcePush).toBeUndefined();
  await screenshots(settings, info, 'git-settings');
});
