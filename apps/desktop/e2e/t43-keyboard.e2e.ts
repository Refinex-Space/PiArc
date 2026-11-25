// T43-A06 and A07 with the real Core, Agent Host and mock provider.
// A06: only the keyboard: a new session and its first message, the four kinds of approval card,
// the Changes panel and a comment, a setting in the settings window, into and out of the
// terminal; Tab walks the regions in order (sidebar, main area, side panels, tool tiles)
// with a visible focus ring; a dialog gives focus back to what opened it.
// A07: reduced motion (system and the app's switch), more contrast and forced colors.
// Screenshots go to tmp/evidence/T43/ with PIARC_EVIDENCE_TASK=T43.
import type { BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Locator, Page } from '@playwright/test';

import { expect, focusMain, makeWorkspace, openFolder, test } from './sessions.js';
import { COLORS } from '../src/shared/design-tokens.js';
import { idle, openSession, prefer } from './t19.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const EVIDENCE = path.join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'tmp',
  'evidence',
  process.env.PIARC_EVIDENCE_TASK ?? 'L4',
);

async function shoot(page: Page, name: string): Promise<void> {
  await mkdir(EVIDENCE, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE, `${name}.png`) });
}

/** Presses Tab (or Shift+Tab) until `target` has focus. */
async function tabTo(page: Page, target: Locator, backwards = false, max = 120): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press(backwards ? 'Shift+Tab' : 'Tab');
  }
  await expect(target).toBeFocused();
}

/** Where the focused element is: its region and whether its focus ring shows. */
function focusInfo(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || el === document.body) return null;
    const region = el.closest('nav.sidebar')
      ? 'sidebar'
      : el.closest('[data-testid="panel-area-rail"]')
        ? 'rail'
        : el.closest('[data-testid="tile-changes"]')
          ? 'tools'
          : el.closest('main')
            ? 'main'
            : 'other';
    // The composer's editor shows its focus on the box around it, a visually hidden input
    // (the attach button's file input) on its label.
    const shown = el.classList.contains('composer-editor')
      ? el.closest('.composer-box')
      : el.classList.contains('visually-hidden')
        ? el.closest('label')
        : el;
    const style = getComputedStyle(shown ?? el);
    const ring =
      (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) ||
      style.boxShadow !== 'none';
    return { region, ring, name: el.getAttribute('data-testid') ?? el.tagName };
  });
}

/** The approval card of `kind` once it shows. */
async function card(page: Page, kind: string): Promise<Locator> {
  const found = page.locator(`[data-approval-card="${kind}"]`);
  await expect(found).toBeVisible({ timeout: 30_000 });
  await expect(found).toBeFocused();
  // The shortcuts answer 400 ms after a card appears.
  await page.waitForTimeout(450);
  return found;
}

async function openSettingsByKeyboard(page: Page): Promise<Page> {
  await page.keyboard.press(`${MOD}+Comma`);
  const settings = page;
  await settings.getByTestId('settings-window').waitFor();
  return settings;
}

test('everything with the keyboard: session, approvals, Changes, settings and the terminal', async ({
  app,
  page,
  workspaces,
}) => {
  test.setTimeout(240_000);
  await prefer(page, { key: 'language', value: 'en' });
  await writeFile(path.join(workspaces, 'outside 外部.txt'), 'outside\n');
  const owner = await app.browserWindow(page);
  await owner.evaluate((window: BrowserWindow) => {
    window.setContentSize(1440, 820);
  });
  const ws = await makeWorkspace(workspaces, 'keyboard 键盘', {});
  await openFolder(page, app, ws);
  await focusMain(app);

  // A new session: Mod+N focuses the message; Enter starts it; the trust dialog by keyboard.
  await page.keyboard.press(`${MOD}+KeyN`);
  await expect(page.getByTestId('home-input')).toBeFocused();
  await page.keyboard.type('Do the work. [[piarc-scenario:t43-tools]]');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('trust-dialog')).toBeVisible();
  await tabTo(page, page.getByTestId('trust-accept'));
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('conversation')).toBeVisible({ timeout: 30_000 });

  // The four kinds of card: Mod+Enter allows the first three; the question form by keys.
  for (const kind of ['command', 'fileChange', 'permissionExpansion']) {
    await card(page, kind);
    await page.keyboard.press(`${MOD}+Enter`);
  }
  const form = await card(page, 'question');
  await tabTo(page, form.getByRole('radio', { name: /^SQLite/u }));
  await page.keyboard.press('Space');
  await page.keyboard.press(`${MOD}+Enter`);
  await idle(page);
  await expect(page.getByTestId('agent-message').last()).toContainText('All done.');

  // Tab walks the regions in order and always shows where focus is.
  await page.getByTestId('composer-input').focus();
  await page.keyboard.press(`${MOD}+Shift+KeyD`);
  await expect(page.getByTestId('changes-panel')).toBeVisible();
  // Give the conversation and its session rail enough room for the full keyboard tour.
  const divider = page.getByTestId('tile-divider-main');
  await tabTo(page, divider);
  await page.keyboard.press('End');
  await expect(page.getByTestId('panel-area-rail')).toBeVisible();
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  const walk: { region: string; ring: boolean; name: string }[] = [];
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press('Tab');
    const info = await focusInfo(page);
    if (info !== null) walk.push(info);
  }
  const order = ['sidebar', 'main', 'rail', 'tools'];
  const regions = walk.map((w) => w.region).filter((r) => r !== 'other');
  const entered = regions.filter((r, i) => r !== regions[i - 1]);
  // Every region is reached, each from the one before it (Tab wraps from the tool tiles
  // back to the sidebar).
  expect(new Set(entered)).toEqual(new Set(order));
  for (let i = 1; i < entered.length; i++) {
    expect(order.indexOf(entered[i] ?? ''), `${entered[i - 1] ?? ''} → ${entered[i] ?? ''}`).toBe(
      (order.indexOf(entered[i - 1] ?? '') + 1) % order.length,
    );
  }
  expect(walk.filter((w) => !w.ring)).toEqual([]);
  await shoot(page, 'keyboard-focus-ring');

  // A comment on the written file from the keyboard.
  const made = page.locator('[data-testid=changes-file][data-path="made.txt"]');
  await tabTo(
    page,
    made.locator('[data-testid=changes-comment-add][data-side=new][data-line="1"]'),
  );
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('changes-comment-input')).toBeFocused();
  await page.keyboard.type('Say more than that.');
  await tabTo(page, page.getByTestId('changes-comment-save'));
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('changes-comment')).toContainText('Say more than that.');

  // A dialog gives focus back to what opened it.
  await page.getByTestId('composer-input').focus();
  await page.keyboard.press(`${MOD}+KeyK`);
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('composer-input')).toBeFocused();

  // Into the terminal and out of it again.
  await page.keyboard.press('Control+Backquote');
  await expect(page.getByRole('textbox', { name: /Terminal|终端/u })).toBeFocused();
  await page.keyboard.press('Control+Backquote');
  await expect(page.getByTestId('terminal-panel')).toHaveCount(0);
  await expect(page.getByTestId('composer-input')).toBeFocused();

  // A setting in the settings window.
  const settings = await openSettingsByKeyboard(page);
  await tabTo(settings, settings.getByTestId('settings-nav-appearance'));
  await settings.keyboard.press('Enter');
  await expect(settings.getByTestId('settings-page-appearance')).toBeVisible();
  const themes = settings.getByTestId('setting-theme').getByRole('radiogroup');
  const dark = themes.getByRole('radio', { name: 'Dark' });
  await tabTo(settings, themes.getByRole('radio', { checked: true }));
  await settings.keyboard.press('ArrowRight');
  await settings.keyboard.press('ArrowRight');
  await expect(dark).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-color-mode', 'dark');
  await shoot(settings, 'keyboard-settings');
  await prefer(page, { key: 'appearance.theme', value: 'system' });
});

test('reduced motion, more contrast and forced colors', async ({ app, page, workspaces }) => {
  test.setTimeout(120_000);
  await openSession(app, page, workspaces, 'modes 模式', 't43-rows', 'Read the notes.', {
    'notes.txt': 'The release is on Friday.\n',
  });
  await idle(page);
  const html = page.locator('html');
  // The hover actions of a message fade; reduced motion makes it instant.
  const fade = () =>
    page
      .locator('.row-actions.reveal-actions')
      .first()
      .evaluate((el) => getComputedStyle(el).transitionDuration);
  await expect(html).toHaveAttribute('data-reduce-motion', 'false');
  expect(await fade()).not.toBe('0s');

  // The system's reduced motion.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(html).toHaveAttribute('data-reduce-motion', 'true');
  expect(await fade()).toBe('0s');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(html).toHaveAttribute('data-reduce-motion', 'false');
  // The app's own switch.
  await prefer(page, { key: 'appearance.reduceMotion', value: 'on' });
  await expect(html).toHaveAttribute('data-reduce-motion', 'true');
  expect(await fade()).toBe('0s');
  await prefer(page, { key: 'appearance.reduceMotion', value: 'system' });

  // More contrast: the high-contrast tokens.
  await prefer(page, { key: 'appearance.theme', value: 'light' });
  await page.emulateMedia({ contrast: 'more' });
  await expect(html).toHaveAttribute('data-color-mode', 'lightHighContrast');
  const secondary = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--piarc-text-secondary').trim(),
    );
  expect(await secondary()).toBe(COLORS.lightHighContrast['text.secondary']);
  await shoot(page, 'contrast-more');
  await page.emulateMedia({ contrast: 'no-preference' });
  await expect(html).toHaveAttribute('data-color-mode', 'light');

  // Forced colors: system colors, and states that keep a shape or text, not only a color.
  await page.emulateMedia({ forcedColors: 'active' });
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--piarc-text-primary').trim(),
      ),
    )
    .toBe('CanvasText');
  const step = page.getByTestId('tool-group').first();
  await expect(step).toHaveAttribute('data-status', 'completed');
  expect(
    await step
      .locator('.step-caret')
      .first()
      .evaluate((el) => getComputedStyle(el).color),
  ).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/u);
  expect(
    await step.getByTestId('tool-summary').evaluate((el) => getComputedStyle(el).color),
  ).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/u);
  // Primary buttons take the system's button colors: text over the backplate stays readable.
  expect(
    await page.getByTestId('composer-send').evaluate((el) => {
      const probe = document.createElement('span');
      probe.style.color = 'ButtonText';
      probe.style.backgroundColor = 'ButtonFace';
      document.body.append(probe);
      const want = getComputedStyle(probe);
      const got = getComputedStyle(el);
      const same = got.color === want.color && got.backgroundColor === want.backgroundColor;
      probe.remove();
      return same;
    }),
  ).toBe(true);
  await shoot(page, 'forced-colors');
  await page.emulateMedia({ forcedColors: 'none' });
  await prefer(page, { key: 'appearance.theme', value: 'system' });
});

test('pointer editing and keyboard navigation give exactly one visible focus indicator', async ({
  app,
  page,
  workspaces,
}) => {
  await openSession(app, page, workspaces, 'focus', 't43-rows', 'Read the notes.', {
    'notes.txt': 'Focus test.',
  });
  await idle(page);
  const editor = page.getByTestId('composer-input');
  const box = page.locator('.composer-box');
  const attach = page.locator('.composer-attach');
  const filter = page.getByTestId('session-filter');

  for (const theme of ['light', 'dark'] as const) {
    await prefer(page, { key: 'appearance.theme', value: theme });
    await expect(page.locator('html')).toHaveAttribute('data-color-mode', theme);
    await page.getByTestId('open-search').click();
    await filter.click();
    await expect(filter).toHaveCSS('outline-width', '1px');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(filter).toBeFocused();
    await expect(filter).toHaveCSS('outline-width', '2px');
    await page.keyboard.press('Escape');

    await editor.click();
    await page.keyboard.type('x');
    await expect(editor).toHaveCSS('outline-style', 'none');
    await expect(box).toHaveCSS('outline-width', '1px');
    await page.keyboard.press('Shift+Tab');
    await expect(attach).toBeFocused();
    await expect(attach).toHaveCSS('outline-width', '2px');
    await expect(box).toHaveCSS('outline-style', 'none');
    await page.keyboard.press('Tab');
    await expect(editor).toBeFocused();
    await expect(box).toHaveCSS('outline-width', '2px');
    await expect(box).toHaveCSS('outline-offset', '-2px');
  }

  await page.getByTestId('permission-mode').focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu');
  await page.keyboard.press('ArrowDown');
  await expect(menu).toBeFocused();
  await expect(menu).toHaveCSS('outline-style', 'none');
  await expect(menu.locator('.is-active')).toHaveCSS('outline-width', '2px');
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+Backquote');
  const surface = page.getByTestId('terminal-surface');
  await expect(page.getByTestId('terminal-input')).toBeFocused();
  await expect(surface).toHaveCSS('outline-width', '2px');
  await page.getByTestId('terminal-canvas').click();
  await expect(page.getByTestId('terminal-input')).toBeFocused();
  await expect(surface).toHaveCSS('outline-style', 'none');
  await page.keyboard.press('Control+Backquote');

  const settings = await openSettingsByKeyboard(page);
  await settings.getByTestId('settings-nav-appearance').click();
  const light = settings.locator('label').filter({ has: settings.getByTestId('theme-light') });
  await light.click();
  await expect(light).toHaveCSS('outline-style', 'none');
  await settings.keyboard.press('ArrowRight');
  const dark = settings.locator('label').filter({ has: settings.getByTestId('theme-dark') });
  await expect(settings.getByTestId('theme-dark')).toBeFocused();
  await expect(dark).toHaveCSS('outline-width', '2px');
  await expect(dark).toHaveCSS('box-shadow', 'none');
});
