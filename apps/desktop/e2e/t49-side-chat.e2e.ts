import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './sessions.js';
import { idle, openSession, prefer, requests, screenshots, send, typeInComposer } from './t19.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

test('a docked side chat uses completed history while the main turn and its queue stay live', async ({
  app,
  page,
  mock,
  workspaces,
}, info) => {
  const scenario = 't49-side-chat';
  // A visible approval card owns Mod+Enter. Hold PreToolUse until the follow-up has
  // been queued through the composer, then let the real approval card hold the main turn.
  const { ws } = await openSession(
    app,
    page,
    workspaces,
    'side chat',
    scenario,
    'What is the milestone?',
    {
      '.piarc/settings.json': JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'node wait-for-queue.cjs' }] },
          ],
        },
      }),
      'wait-for-queue.cjs':
        "const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync('queue-ready')) clearInterval(timer); }, 50);",
    },
  );
  await idle(page);
  await send(page, 'Check readiness.');
  const approval = page.getByRole('button', { name: 'Allow once', exact: true });
  await expect(page.getByTestId('composer')).toHaveAttribute('data-running', 'true');
  await typeInComposer(page, 'Then finish the queued work.');
  await page.keyboard.press(`${MOD}+Enter`);
  const queued = page.getByTestId('queue-item').filter({ hasText: 'Then finish the queued work.' });
  await expect(queued).toHaveAttribute('data-kind', 'followUp');
  await writeFile(path.join(ws, 'queue-ready'), '');
  await expect(approval).toBeVisible();
  await page.keyboard.press(`${MOD}+Semicolon`);
  const panel = page.getByTestId('side-chat');
  await panel.getByRole('textbox').fill('Private side question.');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(panel.getByTestId('side-chat-answer')).toHaveText('Private side answer.');
  await expect(approval).toBeVisible();
  await expect(queued).toHaveAttribute('data-kind', 'followUp');
  await expect(page.getByTestId('composer')).toHaveAttribute('data-running', 'true');
  const side = (await requests(mock, scenario))[2]?.body;
  expect(JSON.stringify(side?.messages)).toContain('The release milestone is Friday.');
  expect(JSON.stringify(side?.messages)).not.toContain('Check readiness.');
  await screenshots(page, info, 'side-chat-while-main-waits');
  await panel.getByRole('button', { name: 'Close side chat' }).click();
  await approval.click();
  await expect(page.getByTestId('agent-message').getByText('Queued work finished.')).toBeVisible();
  await idle(page);
  const recorded = await requests(mock, scenario);
  expect(recorded).toHaveLength(5);
  for (const request of recorded.slice(3))
    expect(JSON.stringify(request.body)).not.toContain('Private side');
  await send(page, '/btw');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('side-chat-answer')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Close side chat' }).click();
  await prefer(page, { key: 'keybinding', command: 'session.sideChat', value: 'Mod+Shift+J' });
  await page.keyboard.press(`${MOD}+Semicolon`);
  await expect(panel).toHaveCount(0);
  await page.keyboard.press(`${MOD}+Shift+KeyJ`);
  await expect(panel).toBeVisible();
});
