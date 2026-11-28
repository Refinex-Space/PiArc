import { expect, test } from './sessions.js';
import { idle, openSession, screenshots } from './t19.js';

test('a fork asks in its parent conversation and reports the result', async ({
  app,
  page,
  workspaces,
}, info) => {
  await openSession(app, page, workspaces, 'fork approval', 't48-fork', 'Review the checklist.');
  const approval = page.getByTestId('approval-card');
  await expect(approval).toContainText('env echo checklist verified');
  await expect(approval.getByTestId('approval-origin')).toHaveText(
    'From subagent: Review a checklist (fork)',
  );
  await screenshots(page, info, 'fork-approval');
  await approval.getByRole('button', { name: 'Allow once', exact: true }).click();
  await idle(page);
  const card = page.getByTestId('subagent-card');
  await expect(card.getByTestId('subagent-type')).toHaveText('fork');
  await expect(card).toHaveAttribute('data-status', 'completed');
  await expect(page.getByTestId('agent-message').getByText('Fork finished.')).toBeVisible();
});
