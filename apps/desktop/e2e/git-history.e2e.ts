// G3 of the Git tool (design addendum 9.1) with the real Core on real repositories: the Log
// view's graph, filter and commit details, a tag, a cherry-pick and a hard reset through the
// native confirmation; stashing from the Commit view and popping from the Log view; deleting a
// remote branch natively and pushing it back from the notice; an image diff; and an automatic
// fetch without a click. Every write is checked with git itself. Screenshots go to
// tmp/evidence/git/ with PIARC_EVIDENCE_TASK=git.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import type { ElectronApplication, Page } from '@playwright/test';

import { git, makeRepository } from './git.js';
import { expect, focusMain, test } from './sessions.js';
import { idle, openSession, prefer, screenshots } from './t19.js';

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
  // The log and its details need room.
  await page.getByTestId('tile-maximize-changes').click();
}

function row(page: Page, subject: string) {
  return page.getByTestId('git-log-row').filter({ hasText: subject });
}

/** main gets one more commit beside feature/login, so the graph has two lanes. */
async function divergeMain(ws: string): Promise<void> {
  await git(ws, 'stash', '-q', '-u');
  await git(ws, 'checkout', '-q', 'main');
  await writeFile(path.join(ws, 'CHANGELOG.md'), '# Changes\n');
  await git(ws, 'add', 'CHANGELOG.md');
  await git(ws, 'commit', '-q', '-m', 'docs: start the changelog');
  await git(ws, 'checkout', '-q', 'feature/login');
  await git(ws, 'stash', 'pop', '-q');
}

/** A valid one-pixel PNG of one color. */
function png(r: number, g: number, b: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, r, g, b]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A bare remote with both branches, fetched. */
async function withRemote(ws: string): Promise<string> {
  const bare = path.join(await mkdtemp(path.join(os.tmpdir(), 'piarc-remote-')), 'origin 远端.git');
  await git(ws, 'init', '-q', '--bare', bare);
  await git(ws, 'remote', 'add', 'origin', bare);
  await git(ws, 'push', '-q', 'origin', 'main', 'feature/login');
  await git(ws, 'fetch', '-q', 'origin');
  return bare;
}

test('the Log view draws the graph, filters, shows a commit and runs commit operations', async ({
  app,
  page,
  workspaces,
}, info) => {
  const { ws } = await openSession(app, page, workspaces, 'git-log', 'git-start', 'Start.', {
    'src/.keep': '',
  });
  await makeRepository(ws);
  await divergeMain(ws);
  await idle(page);
  await openGit(page);
  await page.getByTestId('git-view-log').click();
  await expect(page.getByTestId('git-log')).toBeVisible();

  // The current branch: its two commits, the branch label on the newest.
  await expect(page.getByTestId('git-log-row')).toHaveCount(2);
  await expect(row(page, 'feat: add login').getByTestId('git-ref')).toContainText('feature/login');

  // All branches: main's commit joins, on a second lane.
  await page.getByTestId('git-log-revs').click();
  await page.getByTestId('git-log-revs-all').click();
  await expect(page.getByTestId('git-log-row')).toHaveCount(3);
  await expect(page.locator('.git-log-row .git-graph')).toHaveCount(3);

  // The filter matches messages; no graph while filtering.
  await page.getByTestId('git-log-filter').fill('LOGIN');
  await expect(page.getByTestId('git-log-row')).toHaveCount(1);
  await expect(page.locator('.git-log-row .git-graph')).toHaveCount(0);
  await page.getByTestId('git-log-filter').fill('');
  await expect(page.getByTestId('git-log-row')).toHaveCount(3);

  // A commit's details and its changed files.
  await row(page, 'feat: add login').click();
  const detail = page.getByTestId('git-commit-detail');
  await expect(detail).toContainText('PiArc Test');
  await expect(
    detail.locator('[data-testid=git-file-section][data-path="src/login.ts"]'),
  ).toBeVisible();
  await screenshots(page, info, 'git-log');

  // Keyboard: the rows are a listbox; Shift+F10 opens the row menu.
  await row(page, 'feat: add login').focus();
  await page.keyboard.press('ArrowDown');
  const focused = page.locator('.git-log-row:focus');
  await expect(focused).toHaveAttribute('aria-selected', 'true');
  await expect(focused).not.toContainText('feat: add login');
  await page.keyboard.press('Shift+F10');
  await expect(page.getByTestId('git-log-menu')).toBeVisible();
  await page.keyboard.press('Escape');

  // A tag on the first commit.
  await row(page, 'chore: initial commit').click({ button: 'right' });
  await page.getByTestId('git-log-tag').click();
  await page.getByTestId('git-tag-name').fill('v0.1');
  await page.getByTestId('git-tag-submit').click();
  await expect.poll(() => git(ws, 'tag', '--list')).toBe('v0.1');

  // Cherry-pick main's commit onto feature/login (the uncommitted changes stay).
  await row(page, 'docs: start the changelog').click({ button: 'right' });
  await page.getByTestId('git-log-cherry-pick').click();
  await expect.poll(() => git(ws, 'log', '-1', '--format=%s')).toBe('docs: start the changelog');
  await expect(page.getByTestId('git-notice').filter({ hasText: 'Cherry-picked' })).toBeVisible();
  expect(await readFile(path.join(ws, 'notes.txt'), 'utf8')).toBe('remember the tests\n');

  // A hard reset asks natively: refused, nothing moves; accepted, the branch and files go back.
  const login = await git(ws, 'rev-parse', 'HEAD~1');
  const before = await git(ws, 'rev-parse', 'HEAD');
  await row(page, 'feat: add login').click({ button: 'right' });
  await page.getByTestId('git-log-reset').click();
  await page.getByTestId('git-reset-hard').check();
  await answerNext(app, false);
  await page.getByTestId('git-reset-submit').click();
  await expect.poll(async () => (await confirmations(app)).length).toBe(1);
  expect((await confirmations(app))[0]?.message).toContain('Reset feature/login to');
  expect(await git(ws, 'rev-parse', 'HEAD')).toBe(before);

  await row(page, 'feat: add login').click({ button: 'right' });
  await page.getByTestId('git-log-reset').click();
  await page.getByTestId('git-reset-hard').check();
  await answerNext(app, true);
  await page.getByTestId('git-reset-submit').click();
  await expect.poll(() => git(ws, 'rev-parse', 'HEAD')).toBe(login);
  await expect.poll(() => git(ws, 'status', '--porcelain', '--', 'README.md')).toBe('');
});

test('stashing from the Commit view, popping from the Log view, and a remote branch deleted and restored', async ({
  app,
  page,
  workspaces,
}, info) => {
  const { ws } = await openSession(app, page, workspaces, 'git-stash', 'git-start', 'Start.', {
    'src/.keep': '',
  });
  await makeRepository(ws);
  const bare = await withRemote(ws);
  await idle(page);
  await openGit(page);
  await page.getByTestId('git-view-commit').click();

  await page.getByTestId('git-stash').click();
  await page.getByTestId('git-stash-message').fill('半成品');
  await page.getByTestId('git-stash-untracked').check();
  await page.getByTestId('git-stash-submit').click();
  await expect.poll(() => git(ws, 'stash', 'list')).toContain('半成品');
  await expect.poll(() => git(ws, 'status', '--porcelain')).toBe('');

  await page.getByTestId('git-view-log').click();
  await page.getByTestId('git-log-mode-stashes').click();
  await page.getByTestId('git-stash-row').click();
  await expect(page.getByTestId('git-stash-detail')).toContainText('半成品');
  await screenshots(page, info, 'git-stash');
  await page.getByTestId('git-stash-pop').click();
  await expect.poll(() => git(ws, 'stash', 'list')).toBe('');
  expect(await readFile(path.join(ws, 'notes.txt'), 'utf8')).toBe('remember the tests\n');

  // Delete feature/login on the remote: asked natively, then pushed back from the notice.
  await page.getByTestId('git-view-commit').click();
  await page.getByTestId('git-branch-button').click();
  await page.getByTestId('git-branch-search').fill('origin/feature');
  await page.locator('[data-testid=git-branch-row][data-branch="origin/feature/login"]').click();
  await answerNext(app, true);
  await page.getByTestId('git-branch-delete-remote').click();
  await expect
    .poll(async () => (await confirmations(app)).at(-1)?.message ?? '')
    .toBe('Delete feature/login on origin?');
  await expect.poll(() => git(bare, 'branch', '--list', 'feature/login')).toBe('');
  const local = await git(ws, 'rev-parse', 'feature/login');
  await page.getByTestId('git-notice-restore-remote').click();
  // Until the push lands the branch is missing and rev-parse fails.
  await expect
    .poll(() => git(bare, 'rev-parse', '--verify', '--quiet', 'feature/login').catch(() => ''))
    .toBe(local);
});

test('an image diff and an automatic fetch', async ({ app, page, workspaces }, info) => {
  const { ws } = await openSession(app, page, workspaces, 'git-image', 'git-start', 'Start.', {
    'src/.keep': '',
  });
  await makeRepository(ws);
  const bare = await withRemote(ws);
  // A one-pixel PNG, committed, then replaced by another color.
  await writeFile(path.join(ws, 'logo.png'), png(255, 0, 0));
  await git(ws, 'add', 'logo.png');
  await git(ws, 'commit', '-q', '-m', 'feat: logo');
  await writeFile(path.join(ws, 'logo.png'), png(0, 160, 0));
  await idle(page);
  await openGit(page);
  await page.getByTestId('git-scope').click();
  await page.getByTestId('git-scope-uncommitted').click();
  const logo = page.locator('[data-testid=git-file-section][data-path="logo.png"]');
  // Binary files start open: the two pictures are there.
  await expect(logo.getByTestId('git-file-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(logo.getByTestId('git-image-before').locator('img')).toBeVisible();
  await expect(logo.getByTestId('git-image-after').locator('img')).toBeVisible();
  await expect(logo.getByTestId('git-image-after')).toContainText('1 × 1');
  await screenshots(page, info, 'git-image-diff');

  // Someone pushes to main; turning automatic fetch on fetches it without a click.
  const other = await mkdtemp(path.join(os.tmpdir(), 'piarc-clone-'));
  await git(other, 'clone', '-q', '-b', 'main', bare, 'c');
  const clone = path.join(other, 'c');
  await git(clone, 'config', 'user.name', 'Someone');
  await git(clone, 'config', 'user.email', 'someone@example.invalid');
  await writeFile(path.join(clone, 'remote.txt'), 'from elsewhere\n');
  await git(clone, 'add', 'remote.txt');
  await git(clone, 'commit', '-q', '-m', 'chore: from elsewhere');
  await git(clone, 'push', '-q', 'origin', 'HEAD:main');
  const pushed = await git(clone, 'rev-parse', 'HEAD');
  await focusMain(app);
  await prefer(page, { key: 'git.autoFetch', value: 5 });
  await expect.poll(() => git(ws, 'rev-parse', 'origin/main'), { timeout: 20_000 }).toBe(pushed);
});

/**
 * A focused text field shows one rounded edge: no square-cornered frame inside a rounded box.
 * The Log filter is a borderless input in a rounded field, so the field's border takes the
 * focus color and the input draws no outline; inputs with their own rounded border keep the
 * light outline, which follows that radius.
 */
test('focused text fields in the Git tool draw one rounded edge', async ({
  app,
  page,
  workspaces,
}, info) => {
  const { ws } = await openSession(app, page, workspaces, 'git-focus', 'git-start', 'Start.', {
    'src/.keep': '',
  });
  await makeRepository(ws);
  await idle(page);
  await openGit(page);
  const looks = (locator: ReturnType<Page['getByTestId']>) =>
    locator.evaluate((element) => {
      const style = getComputedStyle(element);
      const field = element.closest('.git-log-search');
      return {
        outline: style.outlineStyle,
        radius: parseFloat(style.borderTopLeftRadius),
        border: style.borderTopStyle,
        field: field === null ? '' : getComputedStyle(field).borderTopColor,
      };
    });

  await page.getByTestId('git-view-log').click();
  const filter = page.getByTestId('git-log-filter');
  await expect(filter).toBeVisible();
  const resting = (await looks(filter)).field;
  for (const how of ['pointer', 'keyboard'] as const) {
    if (how === 'pointer') {
      await filter.click();
    } else {
      await page.getByTestId('git-log-revs').focus();
      await page.keyboard.press('Shift+Tab');
    }
    await expect(filter).toBeFocused();
    const focused = await looks(filter);
    expect(focused.outline, `${how} focus draws no frame inside the field`).toBe('none');
    expect(focused.field, `${how} focus colors the field's edge`).not.toBe(resting);
  }
  await screenshots(page, info, 'git-focus-log-filter');

  const rounded = async (testId: string) => {
    const field = page.getByTestId(testId);
    await expect(field).toBeFocused();
    const style = await looks(field);
    // An outline is drawn only on a field with its own rounded border, and follows its radius.
    if (style.outline !== 'none') {
      expect(style.border, `${testId} has its own border`).toBe('solid');
      expect(style.radius, `${testId} is rounded`).toBeGreaterThan(0);
    }
  };
  await page.getByTestId('git-view-changes').click();
  await page.getByTestId('git-goto').click();
  await rounded('git-goto-input');
  await screenshots(page, info, 'git-focus-goto');
  await page.keyboard.press('Escape');

  await page.getByTestId('git-view-commit').click();
  await page.getByTestId('git-branch-button').click();
  await page.getByTestId('git-branch-search').click();
  await rounded('git-branch-search');
  await page.keyboard.press('Escape');
  await page.getByTestId('git-commit-message').click();
  await rounded('git-commit-message');
  await screenshots(page, info, 'git-focus-commit-message');
});
