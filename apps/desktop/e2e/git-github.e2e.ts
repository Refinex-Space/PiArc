// G5 of the Git tool (design addendum 9.3) with the real Core, a real repository and a fake `gh`
// (`PIARC_TEST_GH`; the machine's own `gh` and GitHub account are never used): creating a pull
// request with a generated description (the branch is pushed first, to a local bare repository
// behind a GitHub URL), merging it after the native confirmation, and an AI review shown inline
// and as a list, then handed to the agent. Screenshots go to tmp/evidence/git/ with
// PIARC_EVIDENCE_TASK=git.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ElectronApplication, Page } from '@playwright/test';

import { fakeGh, git, githubRemote, makeRepository } from './git.js';
import { expect, test } from './sessions.js';
import { idle, openSession, prefer, requests, screenshots } from './t19.js';

const gh = fakeGh();
test.use({ appEnv: { PIARC_TEST_GH: gh.program } });
test.skip(process.platform === 'win32', 'the fake gh is a script with a shebang');

async function answerNext(app: ElectronApplication, answer: boolean): Promise<void> {
  await app.evaluate((_electron, value) => {
    const hooks = globalThis.__piarcTestHooks;
    if (hooks === undefined) throw new Error('test hooks are missing: build the development app');
    hooks.answerConfirm(value);
  }, answer);
}

async function confirmations(app: ElectronApplication): Promise<readonly { message: string }[]> {
  return app.evaluate(() => globalThis.__piarcTestHooks?.confirmations() ?? []);
}

async function openGit(page: Page): Promise<void> {
  await page.getByTestId('panel-tab-changes-card').click();
  await expect(page.getByTestId('git-card')).toBeVisible();
  await page.getByTestId('changes-open').click();
  await expect(page.getByTestId('git-panel')).toBeVisible();
  await page.getByTestId('tile-maximize-changes').click();
}

test('a pull request is opened with a generated description and merged after the native confirmation', async ({
  app,
  page,
  workspaces,
  mock,
}, info) => {
  gh.reset();
  const { ws } = await openSession(app, page, workspaces, 'git-pr', 'git-start', 'Start.', {
    'src/.keep': '',
  });
  await makeRepository(ws);
  const bare = await githubRemote(ws);
  await idle(page);
  await prefer(page, {
    key: 'git.prInstructions',
    value: 'Keep it short. [[piarc-scenario:git-pr-description]]',
  });
  await openGit(page);
  await page.getByTestId('git-view-commit').click();
  await expect(page.getByTestId('git-pr-none')).toBeVisible();
  // `pr view` names the repository from the remote's URL.
  expect(gh.calls()[0]).toContain('--repo=github.com/octo/app');

  // The dialog: one commit, so its subject is the title; the inferred base; generate.
  await page.getByTestId('git-pr-create').click();
  await expect(page.getByTestId('git-pr-dialog')).toBeVisible();
  await expect(page.getByTestId('git-pr-base')).toHaveValue('main');
  await expect(page.getByTestId('git-pr-title')).toHaveValue('feat: add login');
  await page.getByTestId('git-pr-generate').click();
  await expect(page.getByTestId('git-pr-title')).toHaveValue('Add sign-in', { timeout: 30_000 });
  await expect(page.getByTestId('git-pr-body')).toHaveValue(
    '## Summary\n- Adds the login function.',
  );
  const asked = await requests(mock, 'git-pr-description');
  expect(asked).toHaveLength(1);
  const sent = JSON.stringify(asked[0]?.body);
  expect(sent).toContain('feat: add login');
  expect(sent).toContain('English');
  await page.getByTestId('git-pr-draft').check();
  await screenshots(page, info, 'git-pr-dialog');

  // Create: the branch had no upstream, so it is pushed first; the body goes through stdin.
  await page.getByTestId('git-pr-submit').click();
  await expect(page.getByTestId('git-pr')).toContainText('#12', { timeout: 30_000 });
  await expect(page.getByTestId('git-pr')).toHaveAttribute('data-state', 'draft');
  await expect(page.getByTestId('git-pr-merge')).toBeDisabled();
  expect(await git(bare, 'rev-parse', 'feature/login')).toBe(await git(ws, 'rev-parse', 'HEAD'));
  const create = gh.calls().find((c) => c[1] === 'create');
  expect(create).toEqual([
    'pr',
    'create',
    '--repo=github.com/octo/app',
    '--base=main',
    '--head=feature/login',
    '--title=Add sign-in',
    '--body-file=-',
    '--draft',
  ]);
  expect(gh.body()).toBe('## Summary\n- Adds the login function.');

  // Ready for review on GitHub: the band shows it after the view is shown again.
  gh.update({ isDraft: false });
  await page.getByTestId('git-view-changes').click();
  await page.getByTestId('git-view-commit').click();
  await expect(page.getByTestId('git-pr')).toHaveAttribute('data-state', 'open');
  await expect(page.getByTestId('git-pr-checks')).toContainText('1');
  await screenshots(page, info, 'git-pr-band');
  // Two columns: their divider sits between them, and nothing is wider than the tool.
  const layout = await page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
    const tile = document.querySelector('.tool-tile-body');
    return {
      column: box('.git-commit-column')?.right ?? 0,
      divider: (box('[data-testid=git-commit-divider]')?.left ?? 0) + 3,
      overflow: tile === null ? 0 : tile.scrollWidth - tile.clientWidth,
    };
  });
  expect(Math.abs(layout.divider - layout.column)).toBeLessThanOrEqual(1);
  expect(layout.overflow).toBe(0);

  // Merge by rebasing, from the menu, after the native confirmation that names the PR.
  await answerNext(app, true);
  await page.getByTestId('git-pr-merge-more').click();
  await page.getByTestId('git-pr-merge-rebase').click();
  await expect(page.getByTestId('git-pr')).toHaveAttribute('data-state', 'merged');
  expect((await confirmations(app)).at(-1)?.message).toContain('#12');
  expect(gh.calls().find((c) => c[1] === 'merge')).toEqual([
    'pr',
    'merge',
    '--repo=github.com/octo/app',
    '--rebase',
    '--',
    '12',
  ]);
});

test('a review shows its findings inline and as a list, and hands them to the agent', async ({
  app,
  page,
  workspaces,
  mock,
}, info) => {
  const { ws, id } = await openSession(
    app,
    page,
    workspaces,
    'git-review',
    'git-review-start',
    'Start.',
    { 'src/.keep': '' },
  );
  await makeRepository(ws);
  // A review has no instructions: the scenario marker reaches the model through the diff.
  await writeFile(
    path.join(ws, 'README.md'),
    '# Demo\n\nA demo project with sign-in. [[piarc-scenario:git-review]]\n',
  );
  await idle(page);
  await openGit(page);
  await page.getByTestId('git-scope').click();
  await page.getByTestId('git-scope-uncommitted').click();
  await page.getByTestId('git-review').click();
  const bar = page.getByTestId('git-review-bar');
  await expect(bar).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('git-review-count')).toHaveText('2 findings');
  await expect(page.getByTestId('git-review-dropped')).toBeVisible();

  // Inline: under their lines in README.md's diff; next jumps between them.
  const readme = page.locator('[data-testid=git-file-section][data-path="README.md"]');
  await expect(readme.getByTestId('git-finding')).toHaveCount(2);
  await expect(readme.locator('tr.git-finding').first()).toContainText('The heading is generic');
  await page.getByTestId('git-review-next').click();
  await screenshots(page, info, 'git-review-inline');

  // Dismiss one; the other stays.
  await readme
    .getByTestId('git-finding')
    .filter({ hasText: 'The heading is generic' })
    .getByTestId('git-finding-dismiss')
    .click();
  await expect(page.getByTestId('git-review-count')).toHaveText('1 finding');

  // As a list, grouped by file; picking a finding shows its line.
  await prefer(page, { key: 'git.reviewPresentation', value: 'separate' });
  const list = page.getByTestId('git-review-list');
  await expect(list).toBeVisible();
  await expect(readme.getByTestId('git-finding')).toHaveCount(0);
  await expect(list.getByTestId('git-finding')).toHaveCount(1);
  await list.getByTestId('git-finding-pick').click();
  await screenshots(page, info, 'git-review-list');

  // Hand the findings to the agent: one message in this session.
  await page.getByTestId('git-review-fix').click();
  await expect
    .poll(async () => (await requests(mock, 'git-review-start')).length, { timeout: 30_000 })
    .toBe(2);
  const fix = JSON.stringify((await requests(mock, 'git-review-start'))[1]?.body);
  expect(fix).toContain('Code review findings on the uncommitted changes:');
  expect(fix).toContain('Line 3 (high): The sentence leaks a test marker');
  expect(fix).not.toContain('The heading is generic');
  await idle(page);

  // The file changes again with the same counts (+1 −1) and a turn ends: the diff shows the new
  // text, and the review is marked as possibly out of date.
  await writeFile(path.join(ws, 'README.md'), '# Demo\n\nRewritten.\n');
  await page.evaluate(({ session, text }) => window.piarc.prompt(session, text), {
    session: id,
    text: 'Check again.',
  });
  await idle(page);
  await expect(readme).toContainText('Rewritten.', { timeout: 20_000 });
  await expect(page.getByTestId('git-review-stale')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('git-review-clear').click();
  await expect(bar).toHaveCount(0);
});
