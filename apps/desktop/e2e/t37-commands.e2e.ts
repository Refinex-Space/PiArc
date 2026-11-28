// T37 with the real Core, Agent Host and mock provider: the composer's `/` palette (groups by
// source, fuzzy search, argument hints, keyboard choice, no palette from an input method's
// `/`), the built-in commands, the output style switched mid-session (an appended reminder, the
// system prompt unchanged) and the Mod+K palette (actions, sessions, the session's commands, a
// changed shortcut). Screenshots go to tmp/evidence/T37/ with PIARC_EVIDENCE_TASK=T37.
import { openSettings, closeSettings } from './settings-panel.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Page, TestInfo } from '@playwright/test';

import { expect, focusMain, test } from './sessions.js';
import {
  idle,
  lastUserBlocks,
  openSession,
  prefer,
  requests,
  send,
  typeInComposer,
} from './t19.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const FILES = {
  '.claude/commands/frontend/component.md':
    "---\ndescription: Make a UI component\nargument-hint: '[name]'\n---\nCreate the component $1 in the UI kit.\n",
  '.claude/skills/greet/SKILL.md': '---\ndescription: Greet someone warmly\n---\nSay hello.\n',
  '.piarc/commands/release.md': '---\ndescription: Cut a release\n---\nRelease the build.\n',
};

async function shoot(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
}

function lastUserText(body: Record<string, unknown>): string {
  return lastUserBlocks(body)
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('\n');
}

test('the / palette groups by source, searches fuzzily, hints arguments and ignores an IME /', async ({
  app,
  page,
  workspaces,
  mock,
}, info) => {
  await openSession(app, page, workspaces, 'palette 命令', 't37-chat#palette', 'Hello', FILES);
  await idle(page);
  await typeInComposer(page, '/');
  const popup = page.getByTestId('command-popup');
  await expect(popup).toBeVisible();
  await expect(popup.getByTestId('command-group')).toHaveCount(3);
  const groups = await popup
    .getByTestId('command-group')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-source')));
  expect(groups).toEqual(['builtIn', 'projectPiarc', 'projectClaude']);
  const component = popup.locator('[data-command="frontend:component"]');
  await expect(component.getByTestId('command-hint')).toHaveText(/\[name\]/u);
  await expect(popup.locator('[data-command="greet"]')).toHaveAttribute('data-kind', 'skill');
  await expect(popup.locator('[data-command="output-style"]')).toBeVisible();
  await shoot(page, info, 'palette-groups');

  // Fuzzy: `fc` finds frontend:component; Enter puts it in the input for its arguments.
  await page.keyboard.type('fc');
  await expect(popup.getByRole('option')).toHaveCount(1);
  await expect(popup.getByRole('option').first()).toHaveAttribute(
    'data-command',
    'frontend:component',
  );
  await shoot(page, info, 'palette-fuzzy');
  await page.keyboard.press('Enter');
  await expect(popup).toBeHidden();
  await expect(page.getByTestId('composer-input')).toHaveText('/frontend:component ');
  await page.keyboard.type('Button');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('agent-message').getByText('Component made.')).toBeVisible();
  await idle(page);
  await expect(page.getByTestId('user-message').last()).toContainText('/frontend:component Button');
  const sent = await requests(mock, 't37-chat#palette');
  expect(lastUserText(sent[1]?.body ?? {})).toContain('Create the component Button in the UI kit.');
  await shoot(page, info, 'command-sent');

  // An input method's composition that is just `/` opens no palette.
  const cdp = await page.context().newCDPSession(page);
  await page.getByTestId('composer-input').click();
  await cdp.send('Input.imeSetComposition', { text: '/', selectionStart: 1, selectionEnd: 1 });
  await expect(popup).toBeHidden();
  await cdp.send('Input.insertText', { text: '/' });
  await expect(popup).toBeHidden();
  await shoot(page, info, 'ime-slash-no-palette');
});

test('built-in commands open their features and /output-style switches the style mid-session', async ({
  app,
  page,
  workspaces,
  mock,
}, info) => {
  const { ws } = await openSession(
    app,
    page,
    workspaces,
    'builtins 内置',
    't37-chat#builtins',
    'Hello',
    FILES,
  );
  await idle(page);
  await send(page, '/context');
  await expect(page.getByTestId('context-panel')).toBeVisible();
  await send(page, '/model');
  await expect(page.getByTestId('model-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await send(page, '/rewind');
  await expect(page.getByTestId('rewind-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await send(page, '/help');
  const help = page.getByTestId('global-search');
  await expect(page.getByTestId('global-search-tab-shortcuts')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(help.getByTestId('help-commands')).toContainText('/output-style');
  await page.keyboard.press('Escape');

  // /output-style without a name: the dialog; choosing writes the folder's local settings.
  await send(page, '/output-style');
  const dialog = page.getByTestId('output-style-dialog');
  await expect(dialog).toBeVisible();
  await shoot(page, info, 'output-style-dialog');
  await dialog.locator('[data-style="Concise"]').click();
  const local = path.join(ws, '.piarc', 'settings.local.json');
  await expect
    .poll(async () => (await readFile(local, 'utf8').catch(() => '')).includes('"Concise"'))
    .toBe(true);
  await send(page, 'After the switch');
  await expect(page.getByTestId('agent-message').getByText('Component made.')).toBeVisible();
  await idle(page);
  const sent = await requests(mock, 't37-chat#builtins');
  expect(sent).toHaveLength(2);
  expect(lastUserText(sent[1]?.body ?? {})).toContain(
    'The user switched the output style to "Concise"',
  );
  // The system prompt sent first is the one sent after the switch, byte for byte.
  expect(JSON.stringify(sent[1]?.body.system)).toBe(JSON.stringify(sent[0]?.body.system));
  await shoot(page, info, 'style-switched');

  // With a name it switches directly.
  await send(page, '/output-style Explanatory');
  await expect
    .poll(async () => (await readFile(local, 'utf8')).includes('"Explanatory"'))
    .toBe(true);
  // /clear starts a new conversation in the same folder.
  await send(page, '/clear');
  await expect(page.getByTestId('home')).toBeVisible();
});

test('global search dismisses to its opener and scrolls only its results', async ({
  page,
}, info) => {
  await prefer(page, { key: 'language', value: 'en' });
  await page.setViewportSize({ width: 960, height: 350 });
  // Short enough to scroll the results, wide enough to keep the sidebar and its search button.
  const opener = page.getByTestId('open-search');
  const openSearch = async () => {
    await opener.click();
  };
  const dialog = page.getByTestId('global-search');
  const input = page.getByTestId('global-search-input');
  const list = page.getByTestId('global-search-results');
  await openSearch();
  await expect(input).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
  // The commands tab lists every action: enough to scroll in a small window.
  await page.getByTestId('global-search-tab-commands').click();
  await expect(input).toBeFocused();
  // A long tab fills the dialog: the results give way, the tabs are not squeezed or cut off.
  const tabsFit = await dialog.evaluate((el) => {
    const filters = el.querySelector('.workspace-search-filters');
    const tab = el.querySelector('.workspace-search-tab');
    if (!(filters instanceof HTMLElement) || !tab) return false;
    const outer = filters.getBoundingClientRect();
    const inner = tab.getBoundingClientRect();
    return filters.scrollHeight <= filters.clientHeight && inner.top >= outer.top - 0.5;
  });
  expect(tabsFit).toBe(true);
  const headerTop = (await input.boundingBox())?.y;
  await input.press('ArrowUp');
  await expect(list.locator('.search-destination').last()).toBeInViewport({ ratio: 1 });
  expect((await input.boundingBox())?.y).toBe(headerTop);
  const geometry = await list.evaluate((el) => {
    const option = el.querySelector('.search-destination.is-selected');
    if (!option) throw new Error('No active command');
    return {
      scrolled: el.scrollTop,
      trailingSpace: el.getBoundingClientRect().right - option.getBoundingClientRect().right,
      dialogScroll: el.closest('[role="dialog"]')?.scrollTop,
    };
  });
  expect(geometry.scrolled).toBeGreaterThan(0);
  expect(geometry.trailingSpace).toBeGreaterThanOrEqual(12);
  expect(geometry.dialogScroll).toBe(0);
  await dialog.screenshot({ path: info.outputPath('scrolled-global-search.png') });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await openSearch();
  await page.mouse.click(4, 4);
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await openSearch();
  await input.fill('no matching action');
  await input.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await openSearch();
  await page.keyboard.press(`${MOD}+KeyK`);
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('Mod+K runs actions, switches sessions and commands; its shortcut can change', async ({
  app,
  page,
  workspaces,
}, info) => {
  test.setTimeout(120_000);
  const first = await openSession(
    app,
    page,
    workspaces,
    'palette 面板',
    't37-chat#one',
    'First session',
    FILES,
  );
  await idle(page);
  await page.keyboard.press(`${MOD}+KeyN`);
  await page.getByTestId('home-input').fill('Second session [[piarc-scenario:t37-chat#two]]');
  await page.getByTestId('home-start').click();
  await expect(page.getByTestId('conversation')).not.toHaveAttribute('data-session-id', first.id);
  await idle(page);

  await page.keyboard.press(`${MOD}+KeyK`);
  const palette = page.getByTestId('global-search');
  await expect(palette).toBeVisible();
  await expect(page.getByTestId('global-search-tab-all')).toHaveAttribute('aria-selected', 'true');
  // The commands tab: every action and the session's slash commands.
  await page.getByTestId('global-search-tab-commands').click();
  const list = page.getByTestId('global-search-results');
  await expect(list.locator('[data-entry="command:frontend:component"]')).toBeAttached();
  await page.keyboard.press('ArrowUp');
  await expect(list.locator('.search-destination').last()).toHaveClass(/is-selected/u);
  await expect(list.locator('.search-destination').last()).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId('global-search-input')).toBeFocused();
  await page.getByTestId('global-search-tab-all').click();
  await page.keyboard.type('first sess');
  await shoot(page, info, 'mod-k-session');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('conversation')).toHaveAttribute('data-session-id', first.id);

  await page.keyboard.press(`${MOD}+KeyK`);
  await page.keyboard.type('keyboard shortcuts');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('global-search-tab-shortcuts')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Escape');

  await page.keyboard.press(`${MOD}+KeyK`);
  await page.keyboard.type('/output');
  await shoot(page, info, 'mod-k-command');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('output-style-dialog')).toBeVisible();
  await page.keyboard.press('Escape');

  // Rebinding in the settings window applies at once.
  const settings = await openSettings(page);
  await settings.getByTestId('settings-nav-shortcuts').click();
  await settings.getByTestId('shortcut-key-app.commandPalette').click();
  await settings.keyboard.press(`${MOD}+Shift+KeyK`);
  await expect(settings.getByTestId('shortcut-problem')).toHaveCount(0);
  await closeSettings(settings);
  await focusMain(app);
  await page.keyboard.press(`${MOD}+KeyK`);
  await expect(palette).toHaveCount(0);
  await page.keyboard.press(`${MOD}+Shift+KeyK`);
  await expect(palette).toBeVisible();
  await shoot(page, info, 'mod-k-rebound');
});

test('the Skills & plugins page lists skills with source, overrides and warnings', async ({
  app,
  page,
  workspaces,
}, info) => {
  await openSession(app, page, workspaces, 'skills 技能', 't37-chat#skills', 'Hello', {
    ...FILES,
    '.claude/skills/fix/SKILL.md':
      '---\ndescription: Fix an issue\nallowed-tools: Bash(git *)\ncontext: fork\nunknown-setting: custom\n---\nBranch: !`git branch`\n',
  });
  await idle(page);
  const settings = await openSettings(page);
  await settings.getByTestId('settings-nav-skills').click();
  const list = settings.getByTestId('skill-list');
  await expect(list.locator('[data-name="greet"]')).toBeVisible();
  const fix = list.locator('[data-name="fix"]');
  await expect(fix.getByTestId('skill-warning-note')).toBeVisible();
  await settings.screenshot({ path: info.outputPath('skills-page.png'), fullPage: true });
  // The skill's page: its pre-approved tools and what PiArc ignores.
  await fix.getByTestId('skill-row-open').click();
  const detail = settings.getByTestId('skill-detail');
  await expect(detail.getByTestId('skill-allowed')).toContainText('Bash(git *)');
  await expect(detail.getByTestId('skill-warnings')).toContainText('unknown-setting');
  await expect(detail.getByTestId('skill-warnings')).not.toContainText('context');
  await expect(detail.getByTestId('skill-warnings')).toContainText('!`command`');
  await settings.getByTestId('skills-view-installed').click();
  await settings.getByTestId('skills-tab-styles').check({ force: true });
  await expect(settings.getByTestId('output-style-section')).toBeVisible();
});
