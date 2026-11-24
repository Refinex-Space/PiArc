// Drives the same provider configuration and session paths a user takes, with a strict mock
// at both endpoints and synthetic API keys. No pre-seeded Pi provider.
import { closeSettings } from './settings-panel.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { addEndpoint, settingsWindow } from './provider-settings.js';
import {
  expect,
  makeWorkspace,
  openFolder,
  startSession,
  stubMessageBox,
  test,
} from './sessions.js';
import { idle, send } from './t19.js';

test.use({ seedMockModel: false });

test('two configured endpoints complete tool turns; a text-only model refuses an image', async ({
  app,
  page,
  mock,
  workspaces,
  userDataDir,
}, testInfo) => {
  test.setTimeout(120_000);
  const settings = await settingsWindow(page);
  await addEndpoint(settings, 'relay-a', mock.baseUrl, 'anthropic-messages', 'first\nextra');
  await addEndpoint(settings, 'relay-b', `${mock.baseUrl}/v1`, 'openai-completions', 'second');
  await settings.screenshot({ path: testInfo.outputPath('configured-providers.png') });
  await closeSettings(settings);
  const ws = await makeWorkspace(workspaces, 'model settings', {
    'note.txt': 'A note from the mock workspace.',
  });
  await openFolder(page, app, ws);
  await page.getByTestId('home-model').click();
  await page.getByTestId('model-option-relay-a/first').click();
  await startSession(page, 'Read note.txt', 't21-models');
  await expect(
    page.getByTestId('agent-message').filter({ hasText: 'First protocol read the note.' }),
  ).toBeVisible();
  await idle(page);
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${mod}+Shift+KeyI`);
  await page.getByTestId('model-option-relay-b/second').click();
  await expect(page.getByTestId('model-switch-confirm')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('switch-preview.png') });
  await page.getByTestId('model-switch-confirm').click();
  await expect(page.getByTestId('session-model')).toContainText('second');
  await page.keyboard.press(`${mod}+Shift+KeyE`);
  await expect(page.getByTestId('menu-effort-off')).toBeVisible();
  await expect(page.getByTestId('menu-effort-high')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.getByTestId('composer-input').evaluate((target) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['image fixture'], 'diagram.png', { type: 'image/png' }));
    target.dispatchEvent(
      new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.getByTestId('composer-problems')).toBeVisible();
  await expect(page.getByTestId('pending-attachment')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('image-refused.png') });
  await send(page, 'Read note.txt again.');
  await expect(
    page.getByTestId('agent-message').filter({ hasText: 'Second protocol read the note.' }),
  ).toBeVisible();
  await idle(page);
  const response = await fetch(`${mock.baseUrl}/_piarc/requests`);
  const records = (await response.json()) as {
    scenario: string;
    format: string;
    body: string;
    violations: unknown[];
  }[];
  const requests = records.filter((r) => r.scenario === 't21-models');
  expect(requests.map((r) => r.format)).toEqual([
    'anthropic_messages',
    'anthropic_messages',
    'openai_chat_completions',
    'openai_chat_completions',
  ]);
  expect(requests.map((r) => (JSON.parse(r.body) as { model: string }).model)).toEqual([
    'first',
    'first',
    'second',
    'second',
  ]);
  for (const record of requests) {
    expect(record.violations).toEqual([]);
    expect(record.body).not.toContain('image_url');
  }
  for (const index of [1, 3])
    expect(requests[index]?.body).toContain('A note from the mock workspace.');
  const config = await readFile(path.join(userDataDir, 'pi', 'models.json'), 'utf8');
  expect(config).toContain('extra');
  expect(config).not.toMatch(/"apiKey":\s*"[0-9a-f]{8}-/u);
});

test('provider settings validate, edit, and remove built-in, cloud, and keyless local configurations', async ({
  app,
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const settings = await settingsWindow(page);
  await stubMessageBox(app, 0);
  for (const [kind, id] of [
    ['builtin', 'anthropic'],
    ['cloud', 'amazon-bedrock'],
    ['local', 'local-models'],
  ] as const) {
    await settings.getByTestId('provider-add').click();
    await settings.getByTestId('provider-kind').selectOption(kind);
    if (kind === 'local') {
      await settings.getByTestId('provider-id').fill(id);
      await settings.getByTestId('provider-url').fill('http://127.0.0.1:11434/v1');
      await settings.getByTestId('provider-models').fill('local-one');
    } else {
      await settings.getByTestId('provider-id').selectOption(id);
      if (kind === 'cloud') await settings.getByTestId('provider-region').fill('us-east-1');
      await settings
        .getByTestId('provider-key')
        .fill(kind === 'builtin' ? 'sk-ant-oat-test-only' : '');
      await settings.getByTestId('provider-save').click();
      await expect(settings.getByTestId('provider-key')).toHaveAttribute('aria-invalid', 'true');
      await settings.screenshot({ path: testInfo.outputPath(`${kind}-field-error.png`) });
      await settings.getByTestId('provider-key').fill(randomUUID());
    }
    await settings.getByTestId('provider-save').click();
    await settings.getByTestId(`provider-edit-${id}`).click();
    await expect(settings.getByTestId('provider-key')).toHaveValue('');
    if (kind === 'local')
      await settings.getByTestId('provider-models').fill('local-one\nlocal-two');
    else if (kind === 'cloud') await settings.getByTestId('provider-region').fill('us-west-2');
    else await settings.getByTestId('provider-key').fill(randomUUID());
    await settings.getByTestId('provider-save').click();
    await settings.getByTestId(`provider-delete-${id}`).click();
    await expect(settings.getByTestId(`provider-edit-${id}`)).toHaveCount(0);
  }
});
