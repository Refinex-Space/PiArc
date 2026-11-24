// In-process layout only. Pop-out, pinning and redocking are exercised by the native-window
// journey; these assertions use actual CSS-pixel geometry and live terminal/side-chat state.
import { waitForPanel } from './terminal-panel.js';
import type { BrowserWindow } from 'electron';
import type { Locator, Page } from '@playwright/test';
import { expect, makeWorkspace, openFolder, startSession, test } from './sessions.js';
import { idle, openSession } from './t19.js';

async function box(item: Locator) {
  const bounds = await item.boundingBox();
  if (!bounds) throw new Error('Expected a visible layout element: ' + String(item));
  return bounds;
}

async function dragLeftOf(page: Page, handle: Locator, target: Locator, cancel = false) {
  const from = await box(handle);
  const to = await box(target);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + Math.min(12, to.width / 8), to.y + to.height / 2, { steps: 15 });
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
}

test('live tools split to the right, resize, move, maximize and restore without losing the shell', async ({
  app,
  page,
  workspaces,
}, info) => {
  test.setTimeout(120_000);
  const owner = await app.browserWindow(page);
  await owner.evaluate((win: BrowserWindow) => {
    win.setContentSize(1440, 840);
  });
  await openSession(app, page, workspaces, 'Tool tiles', 't18-chat', 'Check the workspace');
  await idle(page);
  const main = page.getByTestId('shell-main');
  const composer = page.locator('.composer-box');
  const before = await box(composer);
  const tile = (name: string) => page.getByTestId('tile-' + name);
  const term = tile('terminal');
  const changes = tile('changes');
  const tab = page.getByTestId('terminal-tab');
  const rail = page.getByTestId('panel-area-rail');
  await expect(rail).toBeVisible();
  await page.getByTestId('tool-terminal').click();
  await expect(tab).toHaveCount(1);
  const shell = await tab.getAttribute('data-task');
  if (!shell) throw new Error('The terminal tab has no Core task identity');
  const firstTool = await box(term);
  const firstMain = await box(main);
  expect(firstTool.x).toBeGreaterThanOrEqual(firstMain.x + firstMain.width - 1);
  expect(firstTool.height).toBeGreaterThan(firstMain.height * 0.9);
  const after = await box(composer);
  expect(Math.abs(after.y + after.height - (before.y + before.height))).toBeLessThanOrEqual(2);
  // A keyboard move of the main divider gives the primary panel more space.
  const divider = page.getByTestId('tile-divider-main');
  await expect(divider).toHaveAttribute('aria-orientation', 'vertical');
  await divider.press('ArrowRight');
  await expect.poll(async () => (await box(term)).width).toBeLessThan(firstTool.width);

  await page.getByTestId('tool-changes').click();
  await expect(changes).toBeVisible();
  const stacked = await box(changes);
  const upper = await box(term);
  expect(stacked.y).toBeGreaterThanOrEqual(upper.y + upper.height - 1);
  expect(Math.abs(stacked.x - upper.x)).toBeLessThanOrEqual(1);
  const split = page.getByTestId('tile-divider-tools');
  await expect(split).toHaveAttribute('aria-orientation', 'horizontal');
  await split.press('ArrowDown');
  await expect.poll(async () => (await box(term)).height).toBeGreaterThan(upper.height);
  const line = await box(split);
  await page.mouse.move(line.x + line.width / 2, line.y + line.height / 2);
  await page.mouse.down();
  await page.mouse.move(line.x + line.width / 2, line.y + line.height / 2 - 72, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await box(term)).height).toBeLessThan(upper.height);
  await split.dblclick();
  await expect
    .poll(async () => Math.abs((await box(term)).height - (await box(changes)).height))
    .toBeLessThanOrEqual(1);
  await waitForPanel(page, (text) => text.trim().length > 0, 'the running shell prompt');
  await page.screenshot({ path: info.outputPath('terminal-and-changes.png') });

  const grip = page.getByTestId('tile-move-changes');
  await dragLeftOf(page, grip, term, true);
  await expect(split).toHaveAttribute('aria-orientation', 'horizontal');
  await dragLeftOf(page, grip, term);
  await expect(split).toHaveAttribute('aria-orientation', 'vertical');
  // The same placement actions are reachable by keyboard through the move handle.
  await grip.press('ArrowUp');
  await expect(page.getByTestId('tile-drop-zone')).toHaveAttribute('data-edge', 'above');
  await grip.press('Escape');
  await expect(page.getByTestId('tile-drop-zone')).toHaveCount(0);
  await grip.press('Space');
  const moveMenu = page.getByRole('menu');
  await moveMenu.press('ArrowDown');
  await moveMenu.press('ArrowDown');
  await expect(page.getByTestId('menu-move-terminal-above')).toHaveClass(/is-active/);
  await moveMenu.press('Enter');
  await expect(split).toHaveAttribute('aria-orientation', 'horizontal');
  await expect.poll(async () => (await box(changes)).y < (await box(term)).y).toBe(true);
  await grip.press('Enter');
  await moveMenu.press('Enter');
  await expect(split).toHaveAttribute('aria-orientation', 'vertical');
  const left = await box(changes);
  const right = await box(term);
  expect(right.x).toBeGreaterThanOrEqual(left.x + left.width - 1);
  expect(Math.abs(right.y - left.y)).toBeLessThanOrEqual(1);
  await expect(tab).toHaveAttribute('data-task', shell);
  await page.getByTestId('tile-maximize-changes').click();
  await expect(page.getByTestId('shell-sidebar')).toBeVisible();
  await expect(term).toBeHidden();
  await expect(main).toBeHidden();
  expect((await box(changes)).width).toBeGreaterThan(left.width);
  await page.getByTestId('tile-maximize-changes').click();
  await expect(term).toBeVisible();
  expect(Math.abs((await box(changes)).width - left.width)).toBeLessThanOrEqual(1);
  await expect(tab).toHaveAttribute('data-task', shell);

  // At minimum desktop width the open tools share the compact tool switcher; restoring
  // the wide viewport brings back the split and both original instances.
  await owner.evaluate((win: BrowserWindow) => {
    win.setContentSize(960, 720);
  });
  const visibleTools = page.locator(
    '[data-testid="tile-terminal"]:visible, [data-testid="tile-changes"]:visible',
  );
  await expect(visibleTools).toHaveCount(1);
  await expect(page.getByTestId('tool-terminal')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('tool-changes')).toHaveAttribute('aria-pressed', 'true');
  await owner.evaluate((win: BrowserWindow) => {
    win.setContentSize(1440, 840);
  });
  await expect(visibleTools).toHaveCount(2);
  await page.getByTestId('new-session').click();
  await expect(term).toBeHidden();
  await page.getByTestId('session-title').first().click();
  await expect(tab).toHaveAttribute('data-task', shell);
  await expect(split).toHaveAttribute('aria-orientation', 'vertical');
  await page.reload();
  await page.getByTestId('session-title').first().click();
  await expect(tab).toHaveAttribute('data-task', shell);
  await expect(split).toHaveAttribute('aria-orientation', 'vertical');
  await page.getByTestId('tile-close-changes').click();
  await expect(changes).toHaveCount(0);
  await expect(term).toBeVisible();
  await expect(tab).toHaveAttribute('data-task', shell);
  await page.getByTestId('tile-close-terminal').click();
  await expect(term).toHaveCount(0);
  await expect(rail).toBeVisible();
});

test('side chat keeps its unsent draft across sibling tools and maximization', async ({
  app,
  page,
  workspaces,
}, info) => {
  await openSession(app, page, workspaces, 'Side draft', 't18-chat', 'Start a conversation');
  await idle(page);
  await page.getByTestId('tool-more').click();
  await page.getByTestId('tool-side-chat').click();
  const input = page.getByTestId('side-chat-question');
  await input.fill('A question to finish later');
  await page.getByTestId('side-chat-new').click();
  const drafts = page.locator('[data-testid="side-chat-question"]:visible');
  await expect(drafts).toHaveCount(1);
  await expect(drafts).toHaveValue('');
  await drafts.fill('A different private draft');
  await page.getByTestId('side-chat-tab').first().click();
  await expect(drafts).toHaveValue('A question to finish later');
  await page.getByTestId('side-chat-tab').first().press('ArrowRight');
  await expect(page.getByTestId('side-chat-tab').last()).toBeFocused();
  await expect(drafts).toHaveValue('A different private draft');
  await page.getByTestId('side-chat-close-tab').click();
  await expect(input).toHaveValue('A question to finish later');
  await page.getByTestId('tool-files').click();
  await page.getByTestId('tool-preview').click();
  const preview = page.getByTestId('tile-preview');
  const files = page.getByTestId('tile-files');
  await expect(preview).toBeVisible();
  const empty = await box(preview.getByTestId('preview-placeholder'));
  const body = await box(preview.getByTestId('tile-body-preview'));
  expect(Math.abs(body.y + body.height / 2 - (empty.y + empty.height / 2))).toBeLessThanOrEqual(1);
  await expect(files).toBeVisible();
  await expect(input).toBeVisible();
  await page.getByTestId('tile-maximize-files').click();
  await expect(input).toBeHidden();
  await expect(preview).toBeHidden();
  await page.getByTestId('tile-maximize-files').click();
  await expect(input).toHaveValue('A question to finish later');
  await page.screenshot({ path: info.outputPath('side-chat-files-preview.png') });
  await page.getByTestId('tile-close-preview').click();
  await expect(preview).toHaveCount(0);
  await expect(files).toBeVisible();
  await expect(input).toHaveValue('A question to finish later');
});

test('the terminal tab close control works inside a draggable tile header', async ({
  app,
  page,
  workspaces,
}) => {
  await openFolder(page, app, await makeWorkspace(workspaces, 'Terminal header'));
  await startSession(page, 'Start a session', 't18-chat');
  await idle(page);
  await page.getByTestId('tool-terminal').click();
  const tabs = page.getByTestId('terminal-tab');
  await expect(tabs).toHaveCount(1);
  const first = await tabs.first().getAttribute('data-task');
  await page.getByTestId('terminal-new').click();
  await expect(tabs).toHaveCount(2);
  await page.getByTestId('tool-changes').click();
  await expect(page.getByTestId('tile-changes')).toBeVisible();
  await tabs.first().focus();
  await tabs.first().press('End');
  await tabs.last().press('Shift+F10');
  await expect(page.getByTestId('menu-terminal-rename-tab')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tabs.last()).toBeFocused();
  await page.getByTestId('terminal-tab-close').last().click();
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toHaveAttribute('data-task', first ?? '');
  await expect(page.getByTestId('tile-changes')).toBeVisible();
});
