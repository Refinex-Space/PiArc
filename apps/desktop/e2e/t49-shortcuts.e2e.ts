// The fixed Windows tasks and the native App Intent deliver only navigation to the running
// app. The workspace trust flow stays in the window. Only the user's Send creates a session.
import { spawn } from 'node:child_process';
import { appCommand } from './app.js';
import { expect, makeWorkspace, openFolder, test } from './sessions.js';
import { requests } from './t19.js';

test('external drafts preserve unsent text, ask about trust and never send', async ({
  app,
  page,
  appForm,
  userDataDir,
  mock,
  workspaces,
}, info) => {
  const original = await makeWorkspace(workspaces, 'original');
  await openFolder(page, app, original);
  await page.getByTestId('home-input').fill('Existing private draft');
  const target = await makeWorkspace(workspaces, 'external 草稿');
  const prompt = '/help [[piarc-scenario:t49-external]]';
  const link = new URL('piarc://draft');
  link.searchParams.set('path', target);
  link.searchParams.set('text', prompt);
  link.searchParams.set('send', '1');
  const nextWindow = app.waitForEvent('window');
  const { command, args } = appCommand(appForm, ['--user-data-dir=' + userDataDir, link.href]);
  const second = spawn(command, args, {
    env: { ...process.env, PIARC_TEST_MEMORY_KEYCHAIN: '1' },
    stdio: 'ignore',
  });
  expect(
    await new Promise<number | null>((resolve, reject) => {
      second.once('error', reject);
      second.once('exit', resolve);
    }),
  ).toBe(0);
  const draft = await nextWindow;
  await expect(draft.getByTestId('trust-dialog')).toBeVisible();
  await draft.getByTestId('trust-deny').click();
  await expect(draft.getByTestId('home-workspace')).toHaveAttribute('value', target);
  await expect(draft.getByTestId('home-input')).toHaveText(prompt);
  await expect(page.getByTestId('home-input')).toHaveText('Existing private draft');
  await expect(draft.getByTestId('session-row')).toHaveCount(0);
  expect(await requests(mock, 't49-external')).toHaveLength(0);
  await draft.screenshot({ path: info.outputPath('external-draft.png') });
});
