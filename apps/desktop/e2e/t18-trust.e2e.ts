// T18-A08: the trust dialog lists a fixture workspace's executable configuration by category;
// "don't trust" keeps the project's Pi extension out of the model's tools, trusting brings it
// in, and an item added later is the only one asked about again.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, makeWorkspace, mockRequests, openFolder, startSession, test } from './sessions.js';

/** The project's Pi extension registers a tool the model sees only when the project is trusted. */
const EXTENSION = `export default function (pi: any) {
  pi.registerTool({
    name: 'fixture_probe',
    label: 'Fixture probe',
    description: 'Registered by the project extension fixture.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return { content: [{ type: 'text', text: 'probe answered' }], details: {} };
    },
  });
}
`;

const FILES = {
  '.pi/extensions/probe-tool.ts': EXTENSION,
  '.mcp.json': JSON.stringify({ mcpServers: { 'fixture-db': { command: 'fixture-db-server' } } }),
  '.piarc/settings.json': JSON.stringify({
    permissions: { allow: ['Bash(npm test)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo checked' }] }],
    },
  }),
};

test('the trust dialog lists the items; the decision decides what the model gets', async ({
  app,
  page,
  mock,
  workspaces,
}, testInfo) => {
  test.setTimeout(150_000);
  const ws = await makeWorkspace(workspaces, 'trust 信任', FILES);
  await openFolder(page, app, ws);

  // First session: the dialog lists every category with its source file.
  await page.getByTestId('home-input').fill('Which tools? [[piarc-scenario:t18-chat#untrusted]]');
  await page.getByTestId('home-start').click();
  const dialog = page.getByTestId('trust-dialog');
  await expect(dialog).toBeVisible();
  const groups = await dialog
    .locator('[data-category]')
    .evaluateAll((sections) => sections.map((section) => section.getAttribute('data-category')));
  expect(groups).toEqual(['hook', 'mcpServer', 'allowRule', 'piExtension']);
  const items = await dialog.getByTestId('trust-item').allTextContents();
  expect(items.join('\n')).toContain('Bash(npm test)');
  expect(items.join('\n')).toContain('fixture-db');
  expect(items.join('\n')).toContain('probe-tool.ts');
  expect(items.join('\n')).toContain('.piarc/settings.json');
  await expect(dialog).toContainText(/memory|AGENTS\.md/);
  await dialog.screenshot({ path: testInfo.outputPath('trust-dialog.png') });

  // Don't trust: the session runs restricted; the extension's tool is not offered.
  await page.getByTestId('trust-deny').click();
  await expect(page.getByTestId('agent-message')).toHaveText(/Done\./, { timeout: 30_000 });
  const untrusted = await mockRequests(mock, 't18-chat#untrusted');
  expect(untrusted.length).toBeGreaterThan(0);
  expect(untrusted[0]?.tools).toEqual(expect.arrayContaining(['Read', 'Bash']));
  expect(untrusted[0]?.tools).not.toContain('fixture_probe');

  // A denied project is not asked again; trust it from the folder's menu.
  await page.getByTestId('workspace-group').locator('.workspace-header').hover();
  await page.getByTestId('workspace-actions').click();
  await page.getByTestId('menu-trust').click();
  await expect(page.getByTestId('trust-current')).toBeVisible();
  await page.getByTestId('trust-accept').click();
  await expect(dialog).toHaveCount(0);
  await page.getByTestId('new-session').click();
  await startSession(page, 'Which tools now?', 't18-chat#trusted', 'none');
  await expect(page.getByTestId('agent-message')).toHaveText(/Done\./, { timeout: 30_000 });
  const trusted = await mockRequests(mock, 't18-chat#trusted');
  expect(trusted[0]?.tools).toContain('fixture_probe');

  // A new executable item: only it is listed, and the project waits for the confirmation.
  const settingsFile = path.join(ws, '.piarc', 'settings.json');
  const settings = JSON.parse(await readFile(settingsFile, 'utf8')) as {
    permissions: { allow: string[] };
  };
  settings.permissions.allow.push('Bash(curl *)');
  await writeFile(settingsFile, JSON.stringify(settings));
  await page.getByTestId('new-session').click();
  await page.getByTestId('home-input').fill('Again [[piarc-scenario:t18-chat#confirmed]]');
  await page.getByTestId('home-start').click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('trust-item')).toHaveCount(1);
  await expect(dialog.getByTestId('trust-item')).toContainText('Bash(curl *)');
  await dialog.screenshot({ path: testInfo.outputPath('trust-new-items.png') });
  settings.permissions.allow.push('Bash(node --version)');
  await writeFile(settingsFile, JSON.stringify(settings));
  await page.getByTestId('trust-accept').click();
  await expect(dialog.getByTestId('trust-item')).toHaveCount(2);
  await expect(dialog.getByRole('status')).toHaveText(/configuration changed|配置已变化/);
  await expect(dialog).toContainText('Bash(node --version)');
  await page.getByTestId('trust-accept').click();
  await expect(page.getByTestId('agent-message')).toHaveText(/Done\./, { timeout: 30_000 });
  const confirmed = await mockRequests(mock, 't18-chat#confirmed');
  expect(confirmed[0]?.tools).toContain('fixture_probe');
});
