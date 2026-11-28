// T35 L4: several windows on one Core (an approval shown in two windows takes one answer),
// running in the background with no window open (the tray's counts, quitting asks first),
// links, Dock drops and a second start opening folders and sessions in the running app, and
// the window's position restored after a restart. Screenshots go to tmp/evidence/T35/ with
// PIARC_EVIDENCE_TASK=T35.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ElectronApplication, Page } from '@playwright/test';

import { appCommand } from './app.js';
import {
  expect,
  focusMain,
  makeWorkspace,
  relaunch,
  row,
  stubMessageBox,
  test,
} from './sessions.js';
import type { TrayObservation } from '../src/shared/test-hooks.js';
import { idle, openSession, prefer, requests } from './t19.js';

async function tray(app: ElectronApplication): Promise<TrayObservation | undefined> {
  return app.evaluate(() => globalThis.__piarcTestHooks?.tray());
}

async function mainWindows(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => globalThis.__piarcTestHooks?.mainWindows().length ?? 0);
}

async function messageBoxes(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    () => (globalThis as { __piarcMessageBoxes?: string[] }).__piarcMessageBoxes ?? [],
  );
}

/** Closes every app window as the user would; the app keeps running. */
async function closeWindows(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.close();
  });
  await expect.poll(() => mainWindows(app)).toBe(0);
}

/** Opens a window through a launch target (as the tray or a link does) and returns its page. */
async function openWindowAt(
  app: ElectronApplication,
  target: { kind: 'session'; sessionId: string } | { kind: 'workspace'; path: string },
): Promise<Page> {
  const opened = app.waitForEvent('window');
  await app.evaluate((_electron, t) => {
    globalThis.__piarcTestHooks?.launch(t);
  }, target);
  const page = await opened;
  await page.getByTestId('app-shell').waitFor();
  return page;
}

test('one approval in two windows takes the first answer and leaves both', async ({
  app,
  page,
  workspaces,
  mock,
}, info) => {
  const { id } = await openSession(app, page, workspaces, 'two windows', 't35-approve', 'Run it');
  const first = page.getByTestId('approval-card');
  await expect(first).toContainText('env echo from both windows');
  const opened = app.waitForEvent('window');
  await row(page, id).getByTestId('session-actions').click();
  await page.getByRole('menuitem', { name: 'Open in new window', exact: true }).click();
  const other = await opened;
  await other.getByTestId('app-shell').waitFor();
  await expect(other.getByTestId('conversation')).toHaveAttribute('data-session-id', id);
  const second = other.getByTestId('approval-card');
  await expect(second).toContainText('env echo from both windows');
  expect(await mainWindows(app)).toBe(2);
  await page.screenshot({ path: info.outputPath('approval-window-1.png') });
  await other.screenshot({ path: info.outputPath('approval-window-2.png') });

  // Both windows answer at once: Core's ledger takes the first, the cards go in both.
  const results = await Promise.allSettled([
    first.getByRole('button', { name: 'Allow once', exact: true }).click({ timeout: 5_000 }),
    second.getByRole('button', { name: 'Decline', exact: true }).click({ timeout: 5_000 }),
  ]);
  expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
  await expect(first).toHaveCount(0);
  await expect(second).toHaveCount(0);
  await idle(page);
  await idle(other);
  await page.screenshot({ path: info.outputPath('approval-answered-window-1.png') });
  await other.screenshot({ path: info.outputPath('approval-answered-window-2.png') });
  // The model got exactly one result for the call: allowed or declined, not both.
  const sent = await requests(mock, 't35-approve');
  const last = JSON.stringify(sent.at(-1)?.body ?? {});
  const ran = last.includes('from both windows\\n');
  const declined = last.includes('declined') || last.includes('denied');
  expect(ran !== declined).toBe(true);
  expect((last.match(/"tool_use_id":"both"/gu) ?? []).length).toBe(1);
});

test('keeps running with no window, counts in the tray and asks before quitting', async ({
  app,
  page,
  workspaces,
}, info) => {
  await prefer(page, { key: 'language', value: 'en' });
  // A session that waits for an approval, then one that streams for a few seconds.
  const waiting = await openSession(app, page, workspaces, 'waits', 't35-wait', 'Wait for me');
  await expect(page.getByTestId('approval-card')).toBeVisible();
  const slow = await openSession(app, page, workspaces, 'streams', 't35-slow', 'Keep going');
  await expect.poll(async () => (await tray(app))?.activity.running).toBe(2);
  await closeWindows(app);

  // No window: the app runs on, the tray shows both counts and the waiting session.
  expect(await app.evaluate(() => process.pid)).toBeGreaterThan(0);
  const busy = await tray(app);
  expect(busy?.activity.awaiting).toBe(1);
  expect(busy?.items).toContain(`tray.session.${waiting.id}`);
  if (process.platform === 'darwin') expect(busy?.title).toMatch(/▸2 \?1|▸1 \?1/u);
  expect(busy?.tooltip).toMatch(/running, 1 waiting for approval/u);
  // The streaming session finishes in the background.
  await expect.poll(async () => (await tray(app))?.activity.running, { timeout: 30_000 }).toBe(1);
  const left = await tray(app);
  if (process.platform === 'darwin') expect(left?.title).toBe('▸1 ?1');
  await writeEvidence(info.outputPath('tray.json'), { busy, left });

  // Quitting with a session still in its turn asks; cancelling keeps the app.
  await stubMessageBox(app, 1);
  await app.evaluate(() => {
    globalThis.__piarcTestHooks?.quit();
  });
  await expect.poll(() => messageBoxes(app)).toEqual(['Quit PiArc?']);
  expect(await app.evaluate(() => process.pid)).toBeGreaterThan(0);

  // The tray opens the waiting session; its approval and the finished stream are there.
  const reopened = await openWindowAt(app, { kind: 'session', sessionId: waiting.id });
  await focusMain(app);
  await reopened.getByTestId('approval-card').getByRole('button', { name: 'Allow once' }).click();
  await idle(reopened);
  await row(reopened, slow.id).getByTestId('session-title').click();
  await expect(reopened.getByTestId('conversation')).toContainText(
    'Still working in the background while no window is open.',
  );
  await expect
    .poll(async () => (await tray(app))?.activity)
    .toEqual({
      running: 0,
      awaiting: 0,
      awaitingSessions: [],
    });
  await reopened.screenshot({ path: info.outputPath('reopened-from-tray.png') });
});

async function writeEvidence(file: string, value: unknown): Promise<void> {
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

test('links, Dock drops and a second start open folders and sessions in the running app', async ({
  app,
  page,
  workspaces,
  userDataDir,
  appForm,
  mock,
}, info) => {
  await prefer(page, { key: 'language', value: 'en' });
  // An untrusted folder with a project allow rule: the trust dialog shows.
  const linked = await makeWorkspace(workspaces, 'linked 链接', {
    '.piarc/settings.json': '{"permissions":{"allow":["Bash(env echo *)"]}}',
  });
  const link = `piarc://open?path=${encodeURIComponent(linked)}&prompt=${encodeURIComponent('run rm -rf /')}`;
  await app.evaluate((_electron, url) => {
    _electron.app.emit('open-url', { preventDefault: () => undefined }, url);
  }, link);
  await expect(page.getByTestId('trust-dialog')).toBeVisible();
  await expect(page.getByTestId('home-workspace')).toHaveAttribute('value', linked);
  await page.screenshot({ path: info.outputPath('link-trust-dialog.png') });
  await page.getByTestId('trust-deny').click();
  // Nothing ran: no session, no model request.
  await expect(page.getByTestId('session-row')).toHaveCount(0);
  expect(await requests(mock, 't35-link')).toHaveLength(0);

  // A folder dropped on the Dock icon.
  const dropped = await makeWorkspace(workspaces, 'dropped 拖入');
  await app.evaluate((_electron, dir) => {
    _electron.app.emit('open-file', { preventDefault: () => undefined }, dir);
  }, dropped);
  await expect(page.getByTestId('home-workspace')).toHaveAttribute('value', dropped);
  // A folder without a decision asks before its first session, as any folder does.
  await expect(page.getByTestId('trust-dialog')).toContainText('dropped 拖入');
  await page.getByTestId('trust-deny').click();

  // A second start with a folder hands it to the running app and exits.
  const second = await makeWorkspace(workspaces, 'second 第二');
  const { command, args } = appCommand(appForm, [`--user-data-dir=${userDataDir}`, second]);
  const child = spawn(command, args, {
    env: { ...process.env, PIARC_TEST_MEMORY_KEYCHAIN: '1' },
    stdio: 'ignore',
  });
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  expect(code).toBe(0);
  await expect(page.getByTestId('home-workspace')).toHaveAttribute('value', second);
  expect(await mainWindows(app)).toBe(1);
  await page.getByTestId('trust-accept').click();

  // A session link shows the session.
  const { id } = await openSessionIn(app, page, second, 't35-link');
  await page.getByTestId('new-session').click();
  await app.evaluate((_electron, url) => {
    _electron.app.emit('open-url', { preventDefault: () => undefined }, url);
  }, `piarc://session/${id}`);
  await expect(page.getByTestId('conversation')).toHaveAttribute('data-session-id', id);
});

async function openSessionIn(
  app: ElectronApplication,
  page: Page,
  dir: string,
  scenario: string,
): Promise<{ id: string }> {
  await expect(page.getByTestId('home-workspace')).toHaveAttribute('value', dir);
  await page.getByTestId('home-input').fill(`Opened [[piarc-scenario:${scenario}]]`);
  await page.getByTestId('home-start').click();
  const conversation = page.getByTestId('conversation');
  await expect(conversation).toBeVisible({ timeout: 30_000 });
  await focusMain(app);
  const id = await conversation.getAttribute('data-session-id');
  if (id === null) throw new Error('no session id');
  await idle(page);
  return { id };
}

test('a main window comes back where it was after a restart', async ({
  app,
  page,
  appForm,
  userDataDir,
}) => {
  await page.getByTestId('app-shell').waitFor();
  // Bounds inside the primary display's work area: the system moves a window that does not fit
  // (CI runners have 1024-pixel-wide screens), which would hide whether the state was restored.
  const wanted = await app.evaluate(({ screen }) => {
    const area = screen.getPrimaryDisplay().workArea;
    // Above the main window's minimum size (960 × 600).
    const width = Math.min(1100, area.width - 40);
    const height = Math.min(720, area.height - 40);
    return { x: area.x + 20, y: area.y + 20, width, height };
  });
  await app.evaluate(({ BrowserWindow }, bounds) => {
    BrowserWindow.getAllWindows()[0]?.setBounds(bounds);
  }, wanted);
  await app.close();
  const saved = JSON.parse(await readFile(path.join(userDataDir, 'window-state.json'), 'utf8')) as {
    main: Record<string, unknown>;
  };
  expect(saved.main).toMatchObject(wanted);
  const next = await relaunch(appForm, userDataDir);
  try {
    const bounds = await next.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getBounds(),
    );
    expect(bounds).toEqual(wanted);
  } finally {
    await next.app.close();
  }
});
