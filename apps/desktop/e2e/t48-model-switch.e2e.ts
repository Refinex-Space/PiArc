// T48: the model picker releases focus after a confirmed switch so its PreModelSwitch hook
// can ask a question in the session's approval ledger while the original call waits.
import { closeSettings } from './settings-panel.js';
import { addEndpoint, settingsWindow } from './provider-settings.js';
import { expect, makeWorkspace, openFolder, startSession, test } from './sessions.js';
import { idle } from './t19.js';

test.use({ seedMockModel: false });

test('a model switch hook can ask after the cost preview and either keep or switch the model', async ({
  app,
  page,
  mock,
  workspaces,
}, info) => {
  test.setTimeout(120_000);
  const settings = await settingsWindow(page);
  await addEndpoint(settings, 'relay-a', mock.baseUrl, 'anthropic-messages', 'first');
  await addEndpoint(settings, 'relay-b', mock.baseUrl + '/v1', 'openai-completions', 'second');
  await closeSettings(settings);
  const workspace = await makeWorkspace(workspaces, 'model switch hook', {
    'note.txt': 'A note from the mock workspace.',
    '.piarc/settings.json': JSON.stringify({
      hooks: {
        PreModelSwitch: [
          { matcher: 'second', hooks: [{ type: 'command', command: 'node confirm.mjs' }] },
        ],
      },
    }),
    'confirm.mjs': `process.stdin.resume(); process.stdin.on('end',()=>console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreModelSwitch',permissionDecision:'ask',permissionDecisionReason:'Confirm the destination model.'}})));`,
  });
  await openFolder(page, app, workspace);
  await page.getByTestId('home-model').click();
  await page.getByTestId('model-option-relay-a/first').click();
  await startSession(page, 'Read note.txt', 't21-models', 'trust');
  await expect(
    page.getByTestId('agent-message').filter({ hasText: 'First protocol read the note.' }),
  ).toBeVisible();
  await idle(page);
  const change = async () => {
    await page.getByTestId('session-model').click();
    await page.getByTestId('model-option-relay-b/second').click();
    await page.getByTestId('model-switch-confirm').click();
    const card = page
      .getByTestId('approval-card')
      .filter({ hasText: 'Confirm the destination model.' });
    await expect(card).toBeVisible();
    await expect(page.getByTestId('model-switch-confirm')).toHaveCount(0);
    return card;
  };
  const first = await change();
  await first.screenshot({ path: info.outputPath('switch-hook-question.png') });
  await first.getByTestId('question-decline').click();
  await expect(page.getByTestId('session-model')).toHaveAttribute('title', 'relay-a/first');
  const second = await change();
  await second.getByLabel('relay-b/second', { exact: true }).check();
  await second.getByTestId('question-submit').click();
  await expect(page.getByTestId('session-model')).toHaveAttribute('title', 'relay-b/second');
});
