// G4 of the Git tool (design addendum 9.2) with the real Core on real repositories: a merge
// from the branch popup stops with a conflict, which the three-way merge view resolves before
// the state bar continues; a rebase with a conflict is aborted through the in-app confirmation;
// an interactive rebase rewords one commit and folds another into it. Every result is checked
// with git itself. Screenshots go to tmp/evidence/git/ with PIARC_EVIDENCE_TASK=git.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { conflictOnMain, git, makeRepository } from './git.js';
import { expect, test } from './sessions.js';
import { idle, openSession, screenshots } from './t19.js';

async function openGit(page: Page): Promise<void> {
  await page.getByTestId('panel-tab-changes-card').click();
  await expect(page.getByTestId('git-card')).toBeVisible();
  await page.getByTestId('changes-open').click();
  await expect(page.getByTestId('git-panel')).toBeVisible();
  await page.getByTestId('tile-maximize-changes').click();
}

async function branchMenu(page: Page, branch: string): Promise<void> {
  await page.getByTestId('git-view-commit').click();
  await page.getByTestId('git-branch-button').click();
  await page.getByTestId('git-branch-search').fill(branch);
  await page.locator(`[data-testid=git-branch-row][data-branch="${branch}"]`).click();
}

test('a merge conflict resolved in the three-way merge view, then continued', async ({
  app,
  page,
  workspaces,
}, info) => {
  const { ws } = await openSession(app, page, workspaces, 'git-merge', 'git-start', 'Start.', {
    'src/.keep': '',
  });
  await makeRepository(ws);
  await conflictOnMain(ws);
  await idle(page);
  await openGit(page);

  await branchMenu(page, 'main');
  await page.getByTestId('git-branch-merge').click();
  await page.getByTestId('git-merge-noFf').check();
  await page.getByTestId('git-merge-submit').click();

  // The merge stops: the conflicts dialog lists the file with both sides' changes.
  const conflicts = page.getByTestId('git-conflicts');
  await expect(conflicts).toBeVisible();
  await expect(conflicts).toContainText('Yours: feature/login · Theirs: main');
  await expect(conflicts.getByTestId('git-conflict-row')).toHaveAttribute(
    'data-path',
    'src/app.ts',
  );
  await screenshots(page, info, 'git-conflicts');
  await conflicts.getByTestId('git-conflict-merge').click();

  // The merge view: one conflict; take theirs and apply.
  const view = page.getByTestId('git-merge-view');
  await expect(view).toBeVisible();
  await expect(view.getByTestId('git-merge-left')).toHaveText('1 conflict left');
  await expect(view.getByTestId('git-merge-conflict')).toContainText("line3 = 'three'");
  await expect(view.getByTestId('git-merge-conflict')).toContainText("line3 = 'tres'");
  await screenshots(page, info, 'git-merge-view');
  await view.getByTestId('git-merge-use-theirs').click();
  await expect(view.getByTestId('git-merge-left')).toHaveText('All conflicts resolved');
  await view.getByTestId('git-merge-apply').click();
  await expect(view).toHaveCount(0);
  await expect.poll(() => git(ws, 'diff', '--name-only', '--diff-filter=U')).toBe('');
  expect(await readFile(path.join(ws, 'src', 'app.ts'), 'utf8')).toContain("line3 = 'tres'");

  // The state bar continues the merge: a merge commit with main as its second parent.
  await page.getByTestId('git-view-commit').click();
  await expect(page.getByTestId('git-state')).toHaveAttribute('data-state', 'merging');
  await page.getByTestId('git-continue').click();
  const main = await git(ws, 'rev-parse', 'main');
  // Until the merge commit exists HEAD has no second parent and rev-parse fails.
  await expect
    .poll(() => git(ws, 'rev-parse', '--verify', '--quiet', 'HEAD^2').catch(() => ''))
    .toBe(main);
  await expect(page.getByTestId('git-state')).toHaveCount(0);
});

test('a rebase conflict aborted through the confirmation, and an interactive rebase', async ({
  app,
  page,
  workspaces,
}, info) => {
  const { ws } = await openSession(app, page, workspaces, 'git-rebase', 'git-start', 'Start.', {
    'src/.keep': '',
  });
  await makeRepository(ws);
  await conflictOnMain(ws);
  await idle(page);
  await openGit(page);
  const before = await git(ws, 'rev-parse', 'HEAD');

  // Rebase onto main: a conflict; abort asks in the app first.
  await branchMenu(page, 'main');
  await page.getByTestId('git-branch-rebase').click();
  await expect(page.getByTestId('git-conflicts')).toBeVisible();
  await page.getByTestId('git-conflicts-close').click();
  await expect(page.getByTestId('git-state')).toHaveAttribute('data-state', 'rebasing');
  await page.getByTestId('git-abort').click();
  await expect(page.getByTestId('git-abort-dialog')).toBeVisible();
  await page.getByTestId('git-abort-dialog-confirm').click();
  await expect(page.getByTestId('git-state')).toHaveCount(0);
  expect(await git(ws, 'rev-parse', 'HEAD')).toBe(before);

  // Three commits on top; reword the oldest and fold the next into it.
  for (const [file, message] of [
    ['one.txt', 'one'],
    ['two.txt', 'two'],
    ['three.txt', 'three'],
  ] as const) {
    await writeFile(path.join(ws, file), `${file}\n`);
    await git(ws, 'add', file);
    await git(ws, 'commit', '-q', '-m', message);
  }
  await page.getByTestId('git-view-log').click();
  await page
    .getByTestId('git-log-row')
    .filter({ hasText: /^one/ })
    .or(page.getByTestId('git-log-row').filter({ hasText: 'one' }).last())
    .first()
    .click({ button: 'right' });
  await page.getByTestId('git-log-rebase').click();
  const dialog = page.getByTestId('git-rebase-dialog');
  await expect(dialog.getByTestId('git-rebase-row')).toHaveCount(3);
  const rows = dialog.getByTestId('git-rebase-row');
  await rows.nth(0).getByTestId('git-rebase-action').selectOption('reword');
  await rows.nth(0).getByTestId('git-rebase-message').fill('feat: one and two');
  await rows.nth(1).getByTestId('git-rebase-action').selectOption('fixup');
  await screenshots(page, info, 'git-rebase-dialog');
  await dialog.getByTestId('git-rebase-start').click();
  await expect.poll(() => git(ws, 'log', '--format=%s', '-2')).toBe('three\nfeat: one and two');
  expect(await readFile(path.join(ws, 'two.txt'), 'utf8')).toBe('two.txt\n');
});
