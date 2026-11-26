// B1 of the built-in browser (ADR-0088, design addendum section 3.1): the preview tool opens
// pages of a local fixture server in its own partition, keeps the native view on the panel's
// viewport, hides it behind a still frame while a menu covers it, and keeps guests away from
// the app's preload and the terminal's real-input rule.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ElectronApplication, Page } from '@playwright/test';

import type { BrowserObservation } from '../src/shared/test-hooks.js';
import { expect, test } from './sessions.js';
import { idle, openSession } from './t19.js';

const PAGES: Record<string, string> = {
  '/': '<!doctype html><title>Fixture home</title><h1>Fixture home</h1><a href="/second">Second page</a><a href="/popup" target="_blank">Popup</a>',
  '/second': '<!doctype html><title>Second page</title><p>Second</p>',
  '/popup': '<!doctype html><title>Popup page</title><p>Popup</p>',
  '/probe':
    '<!doctype html><title>Probe</title><script>document.title = [typeof window.piarc, typeof require, typeof process].join(",")</script>',
};

let server: Server;
let origin = '';

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const body = PAGES[request.url ?? '/'];
    if (body === undefined) {
      response.writeHead(404).end('missing');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
});

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
  await expect(page.getByTestId('browser-start')).toBeVisible();
}

async function go(page: Page, address: string): Promise<void> {
  const input = page.getByTestId('browser-address');
  await input.click();
  await input.fill(address);
  await input.press('Enter');
}

test('opens local pages in tabs on the panel viewport, follows links and popups', async ({
  app,
  page,
  workspaces,
}, info) => {
  test.setTimeout(120_000);
  const { id } = await openSession(app, page, workspaces, 'Browser basic', 't18-chat', 'Hello');
  await idle(page);
  await openPreview(page);
  await go(page, origin.replace('http://', ''));
  await expect(page.getByTestId('browser-tab')).toHaveText(['Fixture home']);
  await expect.poll(async () => (await observe(app, id)).tabs[0]?.host).toBe('panel');
  const seen = await observe(app, id);
  const viewport = await page.getByTestId('browser-viewport').boundingBox();
  const bounds = seen.tabs[0]?.bounds;
  expect(viewport).not.toBeNull();
  expect(bounds).not.toBeNull();
  // The workbench runs at zoom 1, so CSS pixels are the window's DIPs (B1.5.1).
  if (viewport !== null && bounds !== null && bounds !== undefined) {
    expect(Math.abs(bounds.x - viewport.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds.y - viewport.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds.width - viewport.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds.height - viewport.height)).toBeLessThanOrEqual(1);
  }
  expect(seen.partition).toMatch(/^persist:piarc-browser-[0-9a-f]{16}$/);
  await expect(page.getByTestId('browser-site')).toHaveAttribute('data-security', 'local');

  // Navigation and history.
  await go(page, `${origin}/second`);
  await expect(page.getByTestId('browser-tab')).toHaveText(['Second page']);
  await page.getByTestId('browser-back').click();
  await expect(page.getByTestId('browser-tab')).toHaveText(['Fixture home']);
  await page.screenshot({ path: info.outputPath('browser-basic.png') });

  // New tab, switch, close.
  await page.getByTestId('browser-new-tab').click();
  await expect(page.getByTestId('browser-tab')).toHaveCount(2);
  await expect(page.getByTestId('browser-address')).toBeFocused();
  await go(page, `${origin}/second`);
  await expect(page.getByTestId('browser-tab').nth(1)).toHaveText('Second page');
  await page.getByTestId('browser-tab').first().click();
  await expect
    .poll(async () => {
      const tabs = (await observe(app, id)).tabs;
      return tabs.map((tab) => tab.host);
    })
    .toEqual(['panel', 'parking']);
  await page.getByTestId('browser-tab').nth(1).getByRole('button').click();
  await expect(page.getByTestId('browser-tab')).toHaveCount(1);
});

test('THR-11 guests reach neither the preload nor Node', async ({ app, page, workspaces }) => {
  test.setTimeout(120_000);
  const { id } = await openSession(app, page, workspaces, 'Browser isolation', 't18-chat', 'Hello');
  await idle(page);
  await openPreview(page);
  await go(page, `${origin}/probe`);
  await expect(page.getByTestId('browser-tab')).toHaveText(['undefined,undefined,undefined']);
  const seen = await observe(app, id);
  expect(seen.tabs[0]?.pageUrl).toBe(`${origin}/probe`);
});

test('a menu over the page hides it behind a still frame', async ({ app, page, workspaces }) => {
  test.setTimeout(120_000);
  const { id } = await openSession(app, page, workspaces, 'Browser occlusion', 't18-chat', 'Hello');
  await idle(page);
  await openPreview(page);
  await go(page, origin);
  await expect(page.getByTestId('browser-tab')).toHaveText(['Fixture home']);
  await expect.poll(async () => (await observe(app, id)).tabs[0]?.visible).toBe(true);
  await page.getByTestId('browser-more').click();
  await expect(page.getByRole('menu')).toBeVisible();
  await expect.poll(async () => (await observe(app, id)).placement?.occluded).toBe(true);
  await expect.poll(async () => (await observe(app, id)).tabs[0]?.visible).toBe(false);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await observe(app, id)).tabs[0]?.visible).toBe(true);
});

test('closing the tool parks the page and reopening shows it again', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(120_000);
  const { id } = await openSession(app, page, workspaces, 'Browser parking', 't18-chat', 'Hello');
  await idle(page);
  await openPreview(page);
  await go(page, origin);
  await expect(page.getByTestId('browser-tab')).toHaveText(['Fixture home']);
  await page.getByTestId('tile-close-preview').click();
  await expect.poll(async () => (await observe(app, id)).tabs[0]?.host).toBe('parking');
  await page.getByTestId('tool-preview').click();
  await expect(page.getByTestId('browser-tab')).toHaveText(['Fixture home']);
  await expect.poll(async () => (await observe(app, id)).tabs[0]?.host).toBe('panel');
});

test('workspace files open through the workspace scheme with their relative resources', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(120_000);
  const { id } = await openSession(app, page, workspaces, 'Browser files', 't18-chat', 'Hello', {
    'site/index.html':
      '<!doctype html><title>Workspace page</title><link rel="stylesheet" href="style.css">' +
      '<p id="p">styled</p><script>addEventListener("load", () => { document.title = ' +
      '"Workspace page " + getComputedStyle(document.getElementById("p")).color; });</script>',
    'site/style.css': '#p { color: rgb(1, 2, 3); }',
  });
  await idle(page);
  await openPreview(page);
  await go(page, './site/index.html');
  await expect(page.getByTestId('browser-tab')).toHaveText(['Workspace page rgb(1, 2, 3)']);
  const seen = await observe(app, id);
  expect(seen.tabs[0]?.pageUrl).toMatch(/^piarc-browse:\/\/[0-9a-f]{16}\/site\/index\.html$/);
  await expect(page.getByTestId('browser-site')).toHaveAttribute('data-security', 'file');
  // A path outside the workspace is refused before anything loads.
  await go(page, '/etc/hosts');
  await expect(
    page.getByText('Only files inside this session’s workspace open in the browser.'),
  ).toBeVisible();
});
