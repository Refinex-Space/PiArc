// B4 of the built-in browser (ADR-0092, design addendum B1.1.1, B1.2.3, B1.6.2, B4.1–B4.5): the
// preview's start page runs and stops launch configurations, opens a ready server, reports a
// failed one (log, copy, retry, send to agent), announces a port a session terminal starts
// listening on (toast and tool button dot, once per port), notes an untrusted project, lists
// recent pages, suggests addresses, and opens HTML files from the native dialog (a file outside
// the workspace only until its tab closes).
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import path from 'node:path';

import type { ElectronApplication, Page } from '@playwright/test';

import type { BrowserObservation } from '../src/shared/test-hooks.js';
import {
  expect,
  focusMain,
  makeWorkspace,
  openFolder,
  startSession,
  stubFolderDialog,
  test,
} from './sessions.js';
import { idle, openSession } from './t19.js';
import { readClipboard, withSavedClipboard } from './transcript.js';

/** A tiny server: `--port N`, else `PORT`; one page whose title names the port. */
const SERVER_JS = [
  "const http = require('node:http');",
  "const at = process.argv.indexOf('--port');",
  'const port = Number(at > 0 ? process.argv[at + 1] : process.env.PORT);',
  'http',
  '  .createServer((request, response) => {',
  "    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });",
  "    response.end('<!doctype html><title>Dev fixture ' + port + '</title><h1>dev</h1>');",
  '  })',
  "  .listen(port, '127.0.0.1', () => console.log('listening on ' + port));",
  '',
].join('\n');

/** A server that fails at once with a recognizable line. */
const FAIL_JS = "console.error('boom: the fixture cannot start');\nprocess.exit(3);\n";

/** A loopback port nothing listens on right now. */
async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  return port;
}

/** Whether something answers HTTP on `port` (from the test process, outside the app). */
async function answers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function launchJson(web: number, broken: number): string {
  return [
    '{',
    '  // JSONC: comments and trailing commas are allowed (B4.1).',
    '  "version": "0.2.0",',
    '  "configurations": [',
    `    { "name": "web", "runtimeExecutable": "node", "program": "server.js", "args": ["--port", "${String(web)}"], "port": ${String(web)} },`,
    `    { "name": "broken", "runtimeExecutable": "node", "program": "fail.js", "port": ${String(broken)} },`,
    '  ],',
    '}',
    '',
  ].join('\n');
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
  await expect(page.getByTestId('browser-start')).toBeVisible();
}

async function go(page: Page, address: string): Promise<void> {
  const input = page.getByTestId('browser-address');
  await input.click();
  await input.fill(address);
  await input.press('Enter');
}

function server(page: Page, name: string) {
  return page.locator(`[data-testid="browser-server"][data-name="${name}"]`);
}

/** The next "Open HTML file…" dialog answers `file` (the panel's native open dialog). */
async function stubOpenDialog(app: ElectronApplication, file: string): Promise<void> {
  await stubFolderDialog(app, file);
}

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

test('runs a launch configuration from the start page, opens it, and stop ends its tree', async ({
  app,
  page,
  workspaces,
}, info) => {
  test.setTimeout(180_000);
  const web = await freePort();
  const broken = await freePort();
  const { id } = await openSession(app, page, workspaces, 'Dev server', 't18-chat', 'Hello', {
    'server.js': SERVER_JS,
    'fail.js': FAIL_JS,
    '.piarc/launch.json': launchJson(web, broken),
  });
  await idle(page);
  await openPreview(page);
  // B1.1.1: the address bar has the focus on the start page.
  await expect(page.getByTestId('browser-address')).toBeFocused();
  await expect(server(page, 'web')).toHaveAttribute('data-status', 'idle');
  await expect(server(page, 'web')).toContainText(`server.js --port ${String(web)}`);

  // A user's click starts it without a card (B4.2); it is ready once its tree listens (B4.3).
  await server(page, 'web').getByTestId('browser-server-run').click();
  await expect(server(page, 'web')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
  await expect(page.getByTestId('approval-card')).toHaveCount(0);
  expect(await answers(web)).toBe(true);
  // The start page lists it as a local service (B4.4).
  await expect(
    page.locator(`[data-testid="browser-service"][data-port="${String(web)}"]`),
  ).toBeVisible({ timeout: 10_000 });
  // It is a background task of kind devServer (B4.3).
  await page.getByTestId('tool-more').click();
  await page.getByTestId('tool-background-tasks').click();
  await expect(page.getByText(/Development server|开发服务器/u).first()).toBeVisible();
  await page.keyboard.press('Escape');

  await server(page, 'web').getByTestId('browser-server-open').click();
  await expect(page.getByTestId('browser-tab')).toHaveText([`Dev fixture ${String(web)}`]);
  await expect.poll(async () => (await observe(app, id)).tabs[0]?.host).toBe('panel');
  await page.screenshot({ path: info.outputPath('devserver-open.png') });

  // Stop from a new tab's start page: the whole tree ends, the port no longer answers.
  await page.getByTestId('browser-new-tab').click();
  await expect(page.getByTestId('browser-start')).toBeVisible();
  await server(page, 'web').getByTestId('browser-server-stop').click();
  await expect(server(page, 'web')).toHaveAttribute('data-status', 'stopped', { timeout: 20_000 });
  await expect.poll(() => answers(web), { timeout: 15_000 }).toBe(false);
});

test('a failed server shows its log; copy, retry and send to agent work', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(180_000);
  const web = await freePort();
  const broken = await freePort();
  await openSession(app, page, workspaces, 'Dev server failed', 't18-chat', 'Hello', {
    'server.js': SERVER_JS,
    'fail.js': FAIL_JS,
    '.piarc/launch.json': launchJson(web, broken),
  });
  await idle(page);
  await openPreview(page);
  await server(page, 'broken').getByTestId('browser-server-run').click();
  const card = page.locator('[data-testid="browser-server-failed"][data-name="broken"]');
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card.getByTestId('browser-server-failed-log')).toContainText(
    'boom: the fixture cannot start',
  );
  await expect(card).toContainText('3');

  await withSavedClipboard(app, async () => {
    await card.getByTestId('browser-server-copy').click();
    await expect.poll(() => readClipboard(app)).toContain('boom: the fixture cannot start');
  });

  // Retry starts it again: a new failure gets a new card.
  await card.getByTestId('browser-server-retry').click();
  await expect(card).toBeVisible({ timeout: 60_000 });

  // "Send to agent" puts the log into the message box as a snippet; the user sends it.
  await card.getByTestId('browser-server-send').click();
  await expect(page.locator('.snippet-chip')).toContainText('broken');
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId('composer')).toHaveAttribute('data-running', 'false');
});

test('a port a session terminal listens on is announced once, with a dot while the preview is closed', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(180_000);
  const port = await freePort();
  await openSession(app, page, workspaces, 'Dev server terminal', 't34-panel', 'Hello', {
    'server.js': SERVER_JS,
  });
  await idle(page);
  await page.keyboard.press('Control+Backquote');
  await expect(page.getByTestId('terminal-panel')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => globalThis.__piarcTerminalPanel?.screenText() ?? ''), {
      timeout: 20_000,
    })
    .not.toBe('');
  await page.keyboard.type(`node server.js --port ${String(port)}`);
  await page.keyboard.press('Enter');

  // Within 2 s of listening (B4.4): the toast and the dot on the preview button.
  const toast = page.getByTestId('toast').filter({ hasText: `localhost:${String(port)}` });
  await expect(toast).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('tool-preview-dot')).toBeVisible();
  await toast.getByTestId('toast-action').click();
  await expect(page.getByTestId('tile-preview')).toBeVisible();
  await expect(page.getByTestId('browser-tab').last()).toHaveText(`Dev fixture ${String(port)}`);
  await expect(page.getByTestId('tool-preview-dot')).toHaveCount(0);

  // Stopped and started again in the same session: listed again, not announced again.
  // Back to the terminal (its button toggles the panel) and its canvas takes the keys.
  if (!(await page.getByTestId('terminal-panel').isVisible())) {
    await page.getByTestId('tool-terminal').click();
  }
  await page.getByTestId('terminal-canvas').click();
  await page.keyboard.press('Control+C');
  await expect.poll(() => answers(port), { timeout: 15_000 }).toBe(false);
  await page.keyboard.type(`node server.js --port ${String(port)}`);
  await page.keyboard.press('Enter');
  await expect.poll(() => answers(port), { timeout: 15_000 }).toBe(true);
  // The preview button toggles the tool: open it only when it is not showing.
  if (!(await page.getByTestId('tile-preview').isVisible())) {
    await page.getByTestId('tool-preview').click();
  }
  await page.getByTestId('browser-new-tab').click();
  await expect(
    page.locator(`[data-testid="browser-service"][data-port="${String(port)}"]`),
  ).toBeVisible({ timeout: 15_000 });
  await expect(toast).toHaveCount(0);
});

test('an untrusted project shows why its configurations do not run', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(120_000);
  const web = await freePort();
  const ws = await makeWorkspace(workspaces, 'Dev server untrusted', {
    'server.js': SERVER_JS,
    '.piarc/launch.json': launchJson(web, await freePort()),
  });
  await openFolder(page, app, ws);
  await startSession(page, 'Hello', 't18-chat', 'deny');
  await focusMain(app);
  await idle(page);
  await openPreview(page);
  await expect(page.getByTestId('browser-start-untrusted')).toBeVisible();
  await expect(server(page, 'web').getByTestId('browser-server-run')).toBeDisabled();
});

test('the start page lists recent pages and the address bar suggests them', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(150_000);
  const pages: Record<string, string> = {
    '/': '<!doctype html><title>Fixture home</title><p>home</p>',
    '/second': '<!doctype html><title>Second page</title><p>second</p>',
  };
  const fixture: Server = createHttpServer((request, response) => {
    const body = pages[request.url ?? '/'];
    response
      .writeHead(body === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' })
      .end(body ?? 'missing');
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${String((fixture.address() as AddressInfo).port)}`;
  try {
    const { id } = await openSession(app, page, workspaces, 'Browser recents', 't18-chat', 'Hi');
    await idle(page);
    await openPreview(page);
    await go(page, `${origin}/`);
    await expect(page.getByTestId('browser-tab')).toHaveText(['Fixture home']);
    await go(page, `${origin}/second`);
    await expect(page.getByTestId('browser-tab')).toHaveText(['Second page']);

    // A new tab's start page lists this workspace's recent pages, newest first (B1.1.1).
    await page.getByTestId('browser-new-tab').click();
    const recents = page.getByTestId('browser-recent');
    await expect(recents.first()).toHaveAttribute('data-url', `${origin}/second`);
    await expect(recents.nth(1)).toHaveAttribute('data-url', `${origin}/`);
    await recents.nth(1).click();
    await expect(page.getByTestId('browser-tab').nth(1)).toHaveText('Fixture home');

    // Suggestions (B1.2.3): history and open tabs match; arrows choose, Enter opens.
    const input = page.getByTestId('browser-address');
    await input.click();
    await input.fill('Second');
    const list = page.getByTestId('browser-suggestions');
    await expect(list).toBeVisible();
    await expect(list.getByTestId('browser-suggestion').first()).toHaveAttribute(
      'data-url',
      `${origin}/second`,
    );
    await input.press('ArrowDown');
    await expect(list.getByTestId('browser-suggestion').first()).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await input.press('Enter');
    await expect(page.getByTestId('browser-tab').nth(1)).toHaveText('Second page');
    await expect(list).toHaveCount(0);

    // Mod+Enter opens the chosen suggestion in a new tab.
    await input.click();
    await input.fill('Fixture');
    await expect(list).toBeVisible();
    await input.press('ArrowDown');
    await input.press(`${MOD}+Enter`);
    await expect(page.getByTestId('browser-tab')).toHaveCount(3);
    await expect(page.getByTestId('browser-tab').nth(2)).toHaveText('Fixture home');

    // Escape closes the list first, then restores the address.
    await input.click();
    await input.fill('Second');
    await expect(list).toBeVisible();
    await input.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(input).toBeFocused();

    // Nothing is suggested while an input method composes.
    await input.fill('');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', {
      text: 'Seco',
      selectionStart: 4,
      selectionEnd: 4,
    });
    await expect(list).toHaveCount(0);
    await cdp.send('Input.insertText', { text: '' });
    await cdp.detach();
    expect((await observe(app, id)).tabs).toHaveLength(3);
  } finally {
    await new Promise<void>((resolve) =>
      fixture.close(() => {
        resolve();
      }),
    );
  }
});

test('"Open HTML file…" opens a workspace file, and an outside file only until its tab closes', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(150_000);
  const { id, ws } = await openSession(app, page, workspaces, 'Browser HTML', 't18-chat', 'Hi', {
    'site/inside.html': '<!doctype html><title>Inside page</title><p>inside</p>',
  });
  // A folder next to the workspace, not inside it.
  const outside = path.join(workspaces, 'outside-html 页面');
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'style.css'), '#p { color: rgb(4, 5, 6); }');
  await writeFile(
    path.join(outside, 'index.html'),
    '<!doctype html><title>Outside page</title><link rel="stylesheet" href="style.css">' +
      '<p id="p">styled</p><script>addEventListener("load", () => { document.title = ' +
      '"Outside page " + getComputedStyle(document.getElementById("p")).color; });</script>',
  );
  await idle(page);
  await openPreview(page);

  // A file inside the workspace opens through the workspace's own URL.
  await stubOpenDialog(app, path.join(ws, 'site', 'inside.html'));
  await page.getByTestId('browser-open-html').click();
  await expect(page.getByTestId('browser-tab')).toHaveText(['Inside page']);
  const inside = (await observe(app, id)).tabs[0]?.pageUrl ?? '';
  expect(inside).toMatch(/^piarc-browse:\/\/[0-9a-f]{16}\/site\/inside\.html$/);

  // A file outside: its directory loads (the stylesheet applies) under a host of its own.
  await page.getByTestId('browser-new-tab').click();
  await stubOpenDialog(app, path.join(outside, 'index.html'));
  await page.getByTestId('browser-open-html').click();
  await expect(page.getByTestId('browser-tab').nth(1)).toHaveText('Outside page rgb(4, 5, 6)');
  const granted = (await observe(app, id)).tabs[1]?.pageUrl ?? '';
  expect(granted).toMatch(/^piarc-browse:\/\/[0-9a-f]{32}\/index\.html$/);
  // Closing its tab ends the grant: the same address no longer loads the file.
  // The close control is for the pointer (keys close a focused tab with Delete).
  await page.getByTestId('browser-tab').nth(1).getByTestId('browser-tab-close').click();
  await expect(page.getByTestId('browser-tab')).toHaveCount(1);
  await page.getByTestId('browser-new-tab').click();
  await go(page, granted);
  await expect(page.getByTestId('browser-tab').nth(1)).not.toHaveText(/Outside page/);
  // `file://` still never loads in a guest.
  await go(page, `file://${path.join(outside, 'index.html')}`);
  await expect(page.getByTestId('browser-tab').nth(1)).not.toHaveText(/Outside page/);
});
