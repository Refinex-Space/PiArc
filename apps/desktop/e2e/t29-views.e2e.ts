// T29-A09 with the real Core, Agent Host and mock provider: the transcript's three views. Normal
// shows the tool calls as a collapsed summary and no thinking; thinking adds the collapsed
// thinking block; detailed expands everything and shows the system reminder the model received
// (the subdirectory's memory file after the Read). Screenshots of the three views go to
// tmp/evidence/T29/ with PIARC_EVIDENCE_TASK=T29.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from './sessions.js';
import { idle, openSession } from './t19.js';

const EVIDENCE = path.join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'tmp',
  'evidence',
  process.env.PIARC_EVIDENCE_TASK ?? 'L4',
);

async function shoot(page: Page, name: string): Promise<void> {
  await mkdir(EVIDENCE, { recursive: true });
  await page.getByTestId('conversation').screenshot({ path: path.join(EVIDENCE, `${name}.png`) });
}

async function choose(page: Page, detail: 'normal' | 'thinking' | 'detailed'): Promise<void> {
  await page
    .getByTestId('detail-switch')
    .locator('label')
    .filter({ has: page.getByTestId(`detail-${detail}`) })
    .click();
  await expect(page.getByTestId(`detail-${detail}`)).toBeChecked();
}

test('normal, thinking and detailed views of one turn', async ({ page, app, workspaces }) => {
  await openSession(app, page, workspaces, 'views', 't29-views', 'What do the notes say?', {
    'sub/CLAUDE.md': 'Notes directory rule: dates are written as weekdays.',
    'sub/notes.txt': 'Release on Friday.\n',
  });
  await idle(page);
  await expect(
    page.getByTestId('agent-message').getByText('The notes say the release is on Friday.'),
  ).toBeVisible();

  // The default is the thinking view: thinking collapsed, tools summarized, no reminders.
  await expect(page.getByTestId('detail-thinking')).toBeChecked();
  await expect(page.getByTestId('thinking-block')).toHaveAttribute('data-expanded', 'false');
  await expect(page.getByTestId('tool-group')).toHaveCount(1);
  await expect(page.getByTestId('tool-group-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('reminder-row')).toHaveCount(0);
  await shoot(page, 'views-thinking');

  await choose(page, 'normal');
  await expect(page.getByTestId('thinking-block')).toHaveCount(0);
  await expect(page.getByTestId('tool-group-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('reminder-row')).toHaveCount(0);
  await shoot(page, 'views-normal');

  await choose(page, 'detailed');
  await expect(page.getByTestId('thinking-block')).toHaveAttribute('data-expanded', 'true');
  await expect(page.getByTestId('tool-group-toggle')).toHaveAttribute('aria-expanded', 'true');
  const reminder = page.getByTestId('reminder-row');
  await expect(reminder).toHaveCount(1);
  await expect(reminder).toContainText('System reminder: memory');
  await expect(reminder).toContainText('Notes directory rule: dates are written as weekdays.');
  await shoot(page, 'views-detailed');

  // Collapsing in the detailed view stays there; the other views keep their own state.
  await page.getByTestId('tool-group-toggle').click();
  await expect(page.getByTestId('tool-group-toggle')).toHaveAttribute('aria-expanded', 'false');
  await choose(page, 'thinking');
  await expect(page.getByTestId('reminder-row')).toHaveCount(0);
  await expect(page.getByTestId('thinking-block')).toHaveAttribute('data-expanded', 'false');
});
