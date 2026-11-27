// The preview panel's B1 leftovers (design addendum B1.3.1, B1.3.9, B1.4.3, B1.6.1): a refused
// local server is retried until it starts, the zoom of a site follows its tabs, the console
// drawer lists, filters, clears and adds messages to the conversation, and a workspace page
// reloads after its file changes. The agent's files are in browser-files.e2e.ts.
import { rename, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import type { ElectronApplication, Page } from '@playwright/test';

import type { BrowserObservation } from '../src/shared/test-hooks.js';
import { expect, test } from './sessions.js';
import { idle, openSession } from './t19.js';

const PAGES: Record<string, string> = {
  '/': '<!doctype html><title>Zoom home</title><p>home</p>',
  '/other': '<!doctype html><title>Zoom other</title><p>other</p>',
  '/logs':
    '<!doctype html><title>Logs</title><script>console.log("hello from the page");' +
    'console.warn("slow request");setTimeout(() => { throw new TypeError("boom") }, 0);</script>',
};

async function serve(port = 0): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    // No favicon, without the 404 Chromium would log to the console.
    if (request.url === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }
    const body = PAGES[request.url ?? '/'];
    if (body === undefined) {
      response.writeHead(404).end('missing');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    server,
    origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
  };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
}

async function observe(app: ElectronApplication, sessionId: string): Promise<BrowserObservation> {
  return app.evaluate(async (_electron, id) => {
    const hooks = globalThis.__piarcTestHooks;
    if (hooks === undefined) throw new Error('No test hooks: build the development flavor');
    return hooks.browser(id);
  }, sessionId);
}

async function openPreview(page: Page): Promise<void> {
  await page.getByTestId('tool-preview').click();
  await expect(page.getByTestId('tile-preview')).toBeVisible();
}

async function go(page: Page, address: string): Promise<void> {
  const input = page.getByTestId('browser-address');
  await input.click();
  await input.fill(address);
  await input.press('Enter');
}

async function moreMenu(page: Page, item: string | RegExp): Promise<void> {
  await page.getByTestId('browser-more').click();
  await page.getByRole('menuitem', { name: item }).click();
}

test('B1.3.1 a refused local server is retried until it starts', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(120_000);
  // A port nobody listens on yet.
  const probe = await serve();
  const port = Number(new URL(probe.origin).port);
  await close(probe.server);
  await openSession(app, page, workspaces, 'Browser retry', 't18-chat', 'Hello');
  await idle(page);
  await openPreview(page);
  await go(page, `127.0.0.1:${String(port)}`);
  await expect(page.getByTestId('browser-error')).toBeVisible();
  await expect(page.getByTestId('browser-error-waiting')).toBeVisible();
  const late = await serve(port);
  try {
    await expect(page.getByTestId('browser-tab')).toHaveText(['Zoom home'], { timeout: 40_000 });
    await expect(page.getByTestId('browser-error')).toHaveCount(0);
  } finally {
    await close(late.server);
  }
});

test('B1.3.9 the zoom of a site follows its tabs', async ({ app, page, workspaces }) => {
  test.setTimeout(120_000);
  const { server, origin } = await serve();
  try {
    const { id } = await openSession(app, page, workspaces, 'Browser zoom', 't18-chat', 'Hello');
    await idle(page);
    await openPreview(page);
    await go(page, origin);
    await expect(page.getByTestId('browser-tab')).toHaveText(['Zoom home']);
    await moreMenu(page, 'Zoom in');
    await moreMenu(page, 'Zoom in');
    await expect.poll(async () => (await observe(app, id)).tabs[0]?.zoom).toBe(125);
    // A new tab on the same site starts at the site's zoom; another site stays at 100.
    await page.getByTestId('browser-new-tab').click();
    await go(page, `${origin}/other`);
    await expect(page.getByTestId('browser-tab')).toHaveText(['Zoom home', 'Zoom other']);
    await expect.poll(async () => (await observe(app, id)).tabs[1]?.zoom).toBe(125);
    await expect(page.getByTestId('browser-zoom')).toBeVisible();
    // Zooming one tab of the site zooms the other one too.
    await moreMenu(page, 'Zoom out');
    await expect
      .poll(async () => (await observe(app, id)).tabs.map((tab) => tab.zoom))
      .toEqual([110, 110]);
  } finally {
    await close(server);
  }
});

test('B1.4.3 the console drawer lists, filters, clears and adds to the message', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(120_000);
  const { server, origin } = await serve();
  try {
    await openSession(app, page, workspaces, 'Browser console', 't18-chat', 'Hello');
    await idle(page);
    await openPreview(page);
    await go(page, `${origin}/logs`);
    await expect(page.getByTestId('browser-tab')).toHaveText(['Logs']);
    await moreMenu(page, 'Console');
    const drawer = page.getByTestId('browser-console');
    await expect(drawer.getByTestId('browser-console-entry')).toHaveCount(3);
    await expect(drawer).toContainText('hello from the page');
    await expect(drawer).toContainText('Uncaught TypeError: boom');
    await drawer.getByText('Errors', { exact: true }).click();
    await expect(drawer.getByTestId('browser-console-entry')).toHaveCount(1);
    await drawer.getByTestId('browser-console-attach').click();
    await expect(page.getByTestId('composer-input')).toContainText('Console · 1 line');
    await drawer.getByText('All', { exact: true }).click();
    await drawer.getByTestId('browser-console-search').fill('slow');
    await expect(drawer.getByTestId('browser-console-entry')).toHaveCount(1);
    await drawer.getByTestId('browser-console-clear').click();
    await expect(drawer.getByTestId('browser-console-entry')).toHaveCount(0);
    // The page's next message arrives after the clear.
    await go(page, `${origin}/logs`);
    await drawer.getByTestId('browser-console-search').fill('');
    await expect(drawer.getByTestId('browser-console-entry')).toHaveCount(3);
  } finally {
    await close(server);
  }
});

test('B1.6.1 a workspace page reloads after its file changes', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(120_000);
  const { ws } = await openSession(app, page, workspaces, 'Browser live', 't18-chat', 'Hello', {
    'site/index.html':
      '<!doctype html><title>Version one</title><link rel="stylesheet" href="a.css">',
    'site/a.css': 'body { color: rgb(1, 2, 3); }',
  });
  await idle(page);
  await openPreview(page);
  await go(page, './site/index.html');
  await expect(page.getByTestId('browser-tab')).toHaveText(['Version one']);
  await writeFile(path.join(ws, 'site', 'index.html'), '<!doctype html><title>Version two</title>');
  await expect(page.getByTestId('browser-tab')).toHaveText(['Version two'], { timeout: 10_000 });
  // An editor that replaces the file (write a copy, rename over it) is followed too.
  const temporary = path.join(ws, 'site', 'index.html.tmp');
  await writeFile(temporary, '<!doctype html><title>Version three</title>');
  await rename(temporary, path.join(ws, 'site', 'index.html'));
  await expect(page.getByTestId('browser-tab')).toHaveText(['Version three'], { timeout: 10_000 });
});
