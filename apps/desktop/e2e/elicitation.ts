// T48: exercise both interactive MCP modes in a trusted test workspace.
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect } from './sessions.js';
import { idle, openSession } from './t19.js';

export async function exerciseElicitation(
  app: ElectronApplication,
  page: Page,
  workspaces: string,
  observe: (state: 'approval:elicitation' | 'dialog:elicitation') => Promise<void>,
) {
  const fixture = path.join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    'packages',
    'testkit',
    'src',
    'mcp-echo-server.ts',
  );
  await openSession(app, page, workspaces, 'MCP input', 't48-elicitation', 'Ask the server.', {
    '.mcp.json': JSON.stringify({
      mcpServers: {
        alpha: {
          command: process.execPath,
          args: [fixture, 'alpha'],
          env: { MCP_ECHO_ELICIT: '1' },
        },
      },
    }),
    '.piarc/settings.json': JSON.stringify({ permissions: { allow: ['mcp__alpha__*'] } }),
  });
  const review = page.getByRole('button', { name: 'Review request' });
  await expect(review).toBeVisible({ timeout: 30000 });
  await observe('approval:elicitation');
  await review.click();
  const modal = page.getByRole('dialog', { name: /MCP request.*alpha/u });
  await expect(modal).toBeVisible();
  await observe('dialog:elicitation');
  await modal.getByRole('textbox', { name: 'Release name' }).fill('Desktop');
  await modal.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByText('Open the preview in your browser.', { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await review.click();
  await expect(
    modal.getByText('https://example.invalid/mcp/preview', { exact: true }),
  ).toBeVisible();
  await app.evaluate(({ dialog, shell }) => {
    const log: { shown: string[]; opened: string[] } = { shown: [], opened: [] };
    (globalThis as { __t48Urls?: typeof log }).__t48Urls = log;
    dialog.showMessageBox = (...args: unknown[]) => {
      const options = args.at(-1) as { detail?: string };
      log.shown.push(options.detail ?? '');
      return Promise.resolve({ response: 0, checkboxChecked: false });
    };
    shell.openExternal = (url: string) => {
      log.opened.push(url);
      return Promise.resolve();
    };
  });
  await modal.getByRole('button', { name: 'Open', exact: true }).click();
  await idle(page);
  const log = await app.evaluate(
    () => (globalThis as { __t48Urls?: { shown: string[]; opened: string[] } }).__t48Urls,
  );
  expect(log).toEqual({
    shown: ['https://example.invalid/mcp/preview'],
    opened: ['https://example.invalid/mcp/preview'],
  });
}
