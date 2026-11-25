// T46-A07, A08, A09, A11: Auto review end to end with the real Core and Agent Host and a mock
// reviewer model. The mode menu explains why Auto review cannot be chosen until the settings
// enable it; enabling needs a reviewer model and a native confirmation; the reviewer's allow and
// refusal show on the calls with their reasons, an unsure or paused review comes back as a card
// that says why, the card under review takes no answer, three refusals pause review and the
// environment bar says so, a reviewer that cannot be used shows there too; the audit lists the
// reviewer's decisions and the usage page counts the reviews as "Review". Screenshots in both
// themes go to tmp/evidence/T46/.
import { openSettings, closeSettings } from './settings-panel.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';

import { expect, test } from './sessions.js';
import { idle, openSession, openToolGroups, prefer, requests, send } from './t19.js';

const EVIDENCE = path.join(import.meta.dirname, '..', '..', '..', 'tmp', 'evidence', 'T46');
const REVIEWER = 'piarc-mock/mock-reviewer';

/** Screenshots of `target` (a page or one element) in the light and the dark theme. */
async function shots(page: Page, target: Page | Locator, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await prefer(page, { key: 'appearance.theme', value: theme });
    await expect(page.locator('html')).toHaveAttribute('data-color-mode', theme);
    await target.screenshot({ path: path.join(EVIDENCE, `${name}-${theme}.png`) });
  }
  await prefer(page, { key: 'appearance.theme', value: 'system' });
}

/** Answers native message boxes with `responses` in turn and records message and detail. */
async function scriptDialogs(app: ElectronApplication, responses: number[]): Promise<void> {
  await app.evaluate(({ dialog }, answers) => {
    const seen: string[] = [];
    (globalThis as { t46Dialogs?: string[] }).t46Dialogs = seen;
    dialog.showMessageBox = (...args: unknown[]) => {
      const options = args.at(-1) as { message?: string; detail?: string };
      seen.push(`${options.message ?? ''}\n${options.detail ?? ''}`);
      return Promise.resolve({ response: answers[seen.length - 1] ?? 1, checkboxChecked: false });
    };
  }, responses);
}

function dialogs(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as { t46Dialogs?: string[] }).t46Dialogs ?? []);
}

/** The reviewer: a second mock model with strict tool arguments, scripted by header. */
async function addReviewer(dataDir: string): Promise<void> {
  const file = path.join(dataDir, 'pi', 'models.json');
  const models = JSON.parse(await readFile(file, 'utf8')) as {
    providers: Record<string, { models: Record<string, unknown>[] }>;
  };
  models.providers['piarc-mock']?.models.push({
    id: 'mock-reviewer',
    name: 'mock-reviewer',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
    compat: { supportsStrictTools: true },
    headers: { 'x-piarc-scenario': 't46-review' },
  });
  await writeFile(file, JSON.stringify(models));
  // A user price for the reviewer, so the usage page shows the reviews' cost (A09).
  await writeFile(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({
      modelPrices: {
        [REVIEWER]: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
      },
    }),
  );
}

test.beforeEach(async ({ userDataDir }) => {
  await mkdir(EVIDENCE, { recursive: true });
  await addReviewer(userDataDir);
});

test('auto review: enabling, decisions on calls, cards, pause, status, audit and usage', async ({
  app,
  page,
  workspaces,
  mock,
  userDataDir,
}) => {
  test.setTimeout(240_000);
  await openSession(
    app,
    page,
    workspaces,
    'auto review 自动',
    't46-main',
    'Check the environment.',
    {
      'notes.txt': 'keep\n',
      'run.sh': 'echo from-script\n',
    },
  );
  await idle(page);

  // Not enabled yet: the menu lists Auto review, disabled, with the reason.
  await page.getByTestId('permission-mode').click();
  const autoItem = page.getByTestId('menu-auto');
  await expect(autoItem).toHaveAttribute('aria-disabled', 'true');
  await expect(autoItem).toContainText('Enable Auto review in the permission settings first');
  await shots(page, page, 'mode-menu-disabled');
  await page.keyboard.press('Escape');

  // Settings: only the reviewer-capable model is offered; the switch waits for it and asks.
  const settings = await openSettings(page);
  await settings.getByTestId('settings-nav-permissions').click();
  const section = settings.getByTestId('auto-review-section');
  const toggle = section.getByTestId('setting-enable-auto');
  await expect(toggle).toBeDisabled();
  const model = section.getByTestId('auto-review-model');
  await expect(model.locator('option')).toHaveText(['Choose a reviewer model', /mock-reviewer/u]);
  await model.selectOption(REVIEWER);
  await expect(toggle).toBeEnabled();
  await scriptDialogs(app, [0]);
  // Controlled: it changes once the main process confirmed and Core wrote the setting.
  await toggle.click();
  await expect(toggle).toBeChecked();
  expect(await dialogs(app)).toEqual([
    expect.stringContaining(`Enable Auto review?\nThe reviewer model ${REVIEWER} will answer`),
  ]);
  await section.getByTestId('auto-review-input-environment').fill('github.com/acme');
  await section.getByTestId('auto-review-input-environment').press('Enter');
  await expect(section.getByTestId('auto-review-list-environment')).toContainText(
    'github.com/acme',
  );
  await shots(settings, section, 'settings-auto-review');
  const userFile = JSON.parse(
    await readFile(path.join(userDataDir, 'settings.json'), 'utf8'),
  ) as Record<string, unknown>;
  expect(userFile).toMatchObject({
    permissions: { enableAutoMode: true },
    autoMode: { model: REVIEWER, environment: ['github.com/acme'] },
  });

  // Choosing Auto review is recorded in the transcript.
  await closeSettings(settings);
  await page.getByTestId('permission-mode').click();
  await expect(page.getByTestId('menu-auto')).not.toHaveAttribute('aria-disabled', 'true');
  await page.getByTestId('menu-auto').click();
  await expect(page.getByTestId('permission-mode')).toContainText('Auto review');
  await expect(page.getByTestId('mode-change-row').last()).toContainText('Auto review');

  await send(page, 'Do the work.');
  // An unsure review comes back as an ordinary card that says why.
  const unsure = page.getByTestId('approval-card');
  await expect(unsure.getByTestId('approval-review')).toContainText(
    "The reviewer could not decide: The script's contents are not visible here.",
  );
  await shots(page, unsure, 'card-unsure');
  await unsure.getByRole('button', { name: 'Allow once' }).click();
  // The next review is slow: the card shows the review in progress and takes no answer.
  const reviewing = page.getByTestId('approval-reviewing');
  await expect(reviewing).toBeVisible();
  await expect(page.getByTestId('approval-card').getByRole('button')).toHaveCount(0);
  await shots(page, page.getByTestId('approval-card'), 'card-reviewing');
  // Three refusals in a row pause review: the bar says so and the next card names the pause.
  const status = page.getByTestId('env-auto-review');
  await expect(status).toHaveAttribute('data-state', 'paused', { timeout: 30_000 });
  await expect(status).toContainText('Auto review paused after 3 refusals');
  const paused = page.getByTestId('approval-card');
  await expect(paused.getByTestId('approval-review')).toHaveAttribute(
    'data-fallback',
    'pausedConsecutive',
  );
  await shots(page, page, 'paused');
  await paused.getByRole('button', { name: 'Allow once' }).click();
  await idle(page);
  await expect(status).toHaveCount(0);

  // The reviewer's decisions show on the calls, with the reason behind a disclosure.
  await openToolGroups(page);
  const allowed = page.locator('[data-testid="bash-card"]', { hasText: 'printenv HOME' }).first();
  await expect(allowed.getByTestId('tool-review')).toHaveAttribute('data-verdict', 'allow');
  const refused = page.locator('[data-testid="bash-card"]', { hasText: 'sed -i.bak' });
  const note = refused.getByTestId('tool-review');
  await expect(note).toHaveAttribute('data-verdict', 'deny');
  await note.locator('summary').click();
  await expect(note.getByTestId('tool-review-reason')).toContainText(
    'Rewrites a file the user only asked to read.',
  );
  await shots(page, page, 'transcript-review');
  expect(await requests(mock, 't46-review')).toHaveLength(7);

  // A reviewer that cannot be used: the card says so and the bar shows the state.
  await prefer(page, { key: 'autoMode.model', value: 'piarc-mock/missing' });
  await send(page, 'One more.');
  const unavailable = page.getByTestId('approval-card');
  await expect(unavailable.getByTestId('approval-review')).toHaveAttribute(
    'data-fallback',
    'unavailable',
  );
  await expect(status).toHaveAttribute('data-reason', 'unknownModel');
  await shots(page, page, 'reviewer-unavailable');
  await unavailable.getByRole('button', { name: 'Decline' }).click();
  await idle(page);

  // The audit lists the reviewer's decisions under their own category.
  await openSettings(page);
  await settings.getByTestId('settings-nav-permissions').click();
  await settings.getByTestId('audit-kind').selectOption('autoReview');
  const rows = settings.getByTestId('audit-row');
  await expect(rows).toHaveCount(8);
  await expect(settings.getByTestId('permission-audit')).toContainText('Refused');
  await expect(settings.getByTestId('permission-audit')).toContainText(
    'Rewrites a file the user only asked to read.',
  );
  await shots(settings, settings.getByTestId('permission-audit'), 'audit-reviewer');

  // Usage: the reviews are one line of their own, "Review", priced with the user's price.
  await settings.getByTestId('settings-nav-usage').click();
  const review = settings
    .getByTestId('usage-session-auxiliary')
    .filter({ hasText: 'Review' })
    .first();
  await expect(review).toBeVisible();
  await expect(review).toContainText('$');
  await shots(settings, settings.getByTestId('usage-sessions'), 'usage-review');
});
