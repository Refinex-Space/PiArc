// T31 with the real Core, Agent Host and mock provider: a subagent's approval card shows in the
// main session with its origin (A07); the subagent card shows the type, model, status, time and
// tool calls, opens the subagent's own transcript read-only, and stops a running subagent (A13);
// the settings window's Subagents page lists the types with their source, overrides, warnings
// and the files that are not valid definitions with their line (A01). The subagent's requests
// pick their mock script with the marker in the task prompt. Screenshots go to
// tmp/evidence/T31/ with PIARC_EVIDENCE_TASK=T31.
import type { ElectronApplication, Page } from '@playwright/test';

import { expect, focusMain, makeWorkspace, openFolder, startSession, test } from './sessions.js';
import { idle, openSession, prefer, requests, screenshots } from './t19.js';

const REVIEWER =
  '---\nname: reviewer\ndescription: Reviews the build.\ntools: Read, Bash\ncolor: blue\n' +
  'memory: project\n---\nYou review builds and report what you found.\n';

async function openAgentsPage(app: ElectronApplication, page: Page): Promise<Page> {
  const opened = app.waitForEvent('window');
  await page.getByTestId('open-settings').click();
  const settings = await opened;
  await settings.getByTestId('settings-window').waitFor();
  await settings.getByTestId('settings-nav-agents').click();
  await settings.getByTestId('agents-page').waitFor();
  return settings;
}

test('a subagent asks in the main session, and its card opens its transcript', async ({
  app,
  page,
  workspaces,
  mock,
}, info) => {
  test.setTimeout(120_000);
  await openSession(app, page, workspaces, 'subagent review', 't31-main', 'Review the build', {
    '.claude/agents/reviewer.md': REVIEWER,
  });
  // The subagent's command asks; the card is in the main session and names the subagent.
  const approval = page.getByTestId('approval-card');
  await expect(approval).toContainText('env echo build checked');
  await expect(approval.getByTestId('approval-origin')).toHaveText(
    'From subagent: Check the build (reviewer)',
  );
  const card = page.getByTestId('subagent-card');
  await expect(card).toHaveAttribute('data-status', 'running');
  await expect(card.getByTestId('subagent-type')).toHaveText('reviewer');
  await expect(card.getByTestId('subagent-warnings')).toContainText(
    'memory: not supported by PiArc, ignored',
  );
  await screenshots(page, info, 'approval-from-subagent');
  await approval.getByRole('button', { name: 'Allow once', exact: true }).click();
  await idle(page);

  await expect(card).toHaveAttribute('data-status', 'completed');
  await expect(card.getByTestId('subagent-status')).toHaveText('Done');
  await expect(card.getByTestId('subagent-title')).toHaveText('Check the build');
  await expect(card.getByTestId('subagent-model')).toHaveText('Model piarc-mock/mock-large');
  await expect(card.getByTestId('subagent-tools')).toHaveText('1 tool call');
  await expect(card.getByTestId('subagent-stop')).toHaveCount(0);
  await card.getByTestId('subagent-toggle').click();
  const transcript = card.getByTestId('subagent-transcript');
  await expect(transcript).toContainText('Run the build check and report.');
  await expect(transcript).toContainText('env echo build checked');
  await expect(transcript).toContainText('All checks passed.');
  // Read-only: no rewind or branch actions inside the subagent's transcript.
  await expect(transcript.getByTestId('rewind-here')).toHaveCount(0);
  await screenshots(page, info, 'subagent-card-transcript');

  // The child's first request had only its task, not the main session's history.
  const child = await requests(mock, 't31-child');
  const first = JSON.stringify(child[0]?.body ?? {});
  expect(first).toContain('Run the build check and report.');
  expect(first).not.toContain('Review the build');
  // The main session's reply came after the subagent's report.
  const main = await requests(mock, 't31-main');
  expect(JSON.stringify(main.at(-1)?.body ?? {})).toContain('All checks passed.');
});

test('a running subagent can be stopped from its card', async ({ app, page, workspaces }, info) => {
  test.setTimeout(120_000);
  await openSession(app, page, workspaces, 'subagent stop', 't31-stop', 'Survey the repo');
  const card = page.getByTestId('subagent-card');
  await expect(card).toHaveAttribute('data-status', 'running');
  await expect(card.getByTestId('subagent-type')).toHaveText('general-purpose');
  await expect(card.getByTestId('subagent-stop')).toBeVisible();
  await screenshots(page, info, 'subagent-running');
  await card.getByTestId('subagent-stop').click();
  await expect(card).toHaveAttribute('data-status', 'interrupted');
  await expect(card.getByTestId('subagent-status')).toHaveText('Interrupted');
  await idle(page);
  await expect(
    page.getByTestId('agent-message').getByText('The survey was stopped early.'),
  ).toBeVisible();
  await screenshots(page, info, 'subagent-stopped');
});

test('the Subagents page lists types, overrides, warnings and invalid files', async ({
  app,
  page,
  workspaces,
}, info) => {
  test.setTimeout(120_000);
  await prefer(page, { key: 'language', value: 'en' });
  const ws = await makeWorkspace(workspaces, 'subagent settings 设置', {
    '.claude/agents/reviewer.md': REVIEWER,
    '.piarc/agents/reviewer.md':
      '---\nname: reviewer\ndescription: Reviews with PiArc rules.\nmodel: fast\n' +
      'isolation: worktree\nskills: [review]\npermissionMode: bypassPermissions\n---\nReview carefully.\n',
    '.claude/agents/broken.md': '---\nname: broken\ndescription: [unclosed\n---\nBody.\n',
  });
  await openFolder(page, app, ws);
  await startSession(page, 'Hello', 't18-chat');
  await focusMain(app);
  await idle(page);
  const settings = await openAgentsPage(app, page);
  const reviewer = settings.locator('[data-testid="agent-row"][data-name="reviewer"]');
  await expect(reviewer.getByTestId('agent-source')).toHaveText('Project (.piarc)');
  await expect(reviewer).toContainText('Replaces');
  await expect(reviewer).toContainText('.claude');
  const warnings = reviewer.getByTestId('agent-warnings');
  // `isolation` works since T35; `skills` waits for T48 (I159).
  await expect(warnings).not.toContainText('isolation');
  await expect(warnings).toContainText('skills');
  await expect(warnings).toContainText('T48');
  await expect(warnings).toContainText('bypassPermissions');
  for (const builtIn of ['general-purpose', 'Explore', 'Plan']) {
    await expect(
      settings.locator(`[data-testid="agent-row"][data-name="${builtIn}"]`),
    ).toContainText('Built in');
  }
  const issues = settings.getByTestId('agent-issues');
  await expect(issues).toContainText('broken.md');
  await expect(issues).toContainText(/line \d+/u);
  // The page does not scroll sideways: a long workspace path shrinks the selector.
  expect(
    await settings
      .locator('.settings-page')
      .evaluate((page) => page.scrollWidth <= page.clientWidth),
  ).toBe(true);
  await settings.screenshot({ path: info.outputPath('settings-subagents.png') });
  await reviewer.screenshot({ path: info.outputPath('settings-subagents-reviewer.png') });
  await issues.screenshot({ path: info.outputPath('settings-subagents-issues.png') });
});
