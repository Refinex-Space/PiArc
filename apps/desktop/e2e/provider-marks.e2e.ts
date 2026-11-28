// Providers' brand marks (ADR-0107) where a user meets them: the "Add a service" cards, the
// connection list, and the grouped model menu and its search, in light and dark. Endpoints point
// at the strict mock with synthetic keys. Screenshots go to tmp/evidence/<task>/ with
// PIARC_EVIDENCE_TASK set.
import { addEndpoint, settingsWindow } from './provider-settings.js';
import { closeSettings } from './settings-panel.js';
import { expect, makeWorkspace, openFolder, test } from './sessions.js';
import { prefer } from './t19.js';

test.use({ seedMockModel: false });

test('provider marks show in the chooser, the connection list and the model menu', async ({
  app,
  page,
  mock,
  workspaces,
}, testInfo) => {
  test.setTimeout(120_000);
  const settings = await settingsWindow(page);
  // A custom provider named after a brand shows its mark; an unnamed one the neutral globe.
  await addEndpoint(settings, 'deepseek-relay', mock.baseUrl, 'anthropic-messages', 'flash');
  await addEndpoint(settings, 'lab', `${mock.baseUrl}/v1`, 'openai-completions', 'second');
  const deepseek = settings.getByTestId('provider-row-deepseek-relay');
  await expect(deepseek.locator('.provider-row-mark svg')).toHaveAttribute('data-mark', 'deepseek');
  await expect(
    settings.getByTestId('provider-row-lab').locator('.provider-row-mark svg'),
  ).not.toHaveAttribute('data-mark');

  for (const theme of ['light', 'dark'] as const) {
    await prefer(page, { key: 'appearance.theme', value: theme });
    await settings.getByTestId('provider-add').click();
    const chooser = settings.getByTestId('service-chooser');
    await expect(chooser).toBeVisible();
    // Built-in and sign-in providers, including the ones without a Pi mark of their own.
    for (const [choice, mark] of [
      ['provider-choice-openai', 'openai'],
      ['provider-choice-anthropic', 'anthropic'],
      ['provider-choice-amazon-bedrock', 'bedrock'],
      ['login-radius', 'pi'],
      ['login-github-copilot', 'githubcopilot'],
    ] as const) {
      await expect(chooser.getByTestId(choice).locator('svg.provider-mark')).toHaveAttribute(
        'data-mark',
        mark,
      );
    }
    await settings.screenshot({ path: testInfo.outputPath(`chooser-${theme}.png`) });
    await chooser.getByTestId('service-search').fill('qwen');
    await settings.screenshot({ path: testInfo.outputPath(`chooser-search-${theme}.png`) });
    await settings.keyboard.press('Escape');
    await expect(chooser).toHaveCount(0);
    await settings.screenshot({ path: testInfo.outputPath(`connections-${theme}.png`) });
  }
  await prefer(page, { key: 'appearance.theme', value: 'light' });
  await closeSettings(settings);

  const ws = await makeWorkspace(workspaces, 'provider marks', { 'note.txt': 'note' });
  await openFolder(page, app, ws);
  await page.getByTestId('home-model').click();
  await expect(
    page.getByTestId('model-provider-deepseek-relay').locator('svg.provider-mark'),
  ).toHaveAttribute('data-mark', 'deepseek');
  await page.screenshot({ path: testInfo.outputPath('model-menu.png') });
  // A searched model keeps its provider's mark.
  await page.keyboard.type('flash');
  await expect(
    page.getByTestId('model-option-deepseek-relay/flash').locator('svg.provider-mark'),
  ).toHaveAttribute('data-mark', 'deepseek');
  await page.screenshot({ path: testInfo.outputPath('model-menu-search.png') });
  await page.keyboard.press('Escape');
});
