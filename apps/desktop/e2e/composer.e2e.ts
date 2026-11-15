// T09-A08 and A09: the composer's key semantics, idle and running; mention chips that keep data,
// display and sent text apart; and the input method guard, driven through the Chrome DevTools
// Protocol (`Input.imeSetComposition`, then key events with keyCode 229) because Playwright has
// no input method API.
import type { CDPSession, Page } from '@playwright/test';

import { expect, test } from './fixtures.js';
import { actions, clearActions, openLab, setRunning } from './transcript.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

test.beforeEach(async ({ page }) => {
  await openLab(page);
  await page.getByTestId('composer-input').click();
});

function editor(page: Page) {
  return page.getByTestId('composer-input');
}

async function paragraphs(page: Page): Promise<string[]> {
  return editor(page).locator('p').allTextContents();
}

test('idle: Enter sends, Shift+Enter adds a line, Mod+Enter sends, Esc does nothing', async ({
  page,
}) => {
  await page.keyboard.type('first line');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('second line');
  expect(await paragraphs(page)).toEqual(['first line', 'second line']);
  await page.keyboard.press('Escape');
  expect(await actions(page)).toEqual([]);
  await page.keyboard.press('Enter');
  expect(await actions(page)).toEqual([
    { kind: 'send', text: 'first line\nsecond line', mentions: [] },
  ]);
  expect(await paragraphs(page)).toEqual(['']);
  await expect(page.getByTestId('user-message')).toHaveText('first line\nsecond line');

  await clearActions(page);
  await page.keyboard.type('with mod');
  await page.keyboard.press(`${MOD}+Enter`);
  expect(await actions(page)).toEqual([{ kind: 'send', text: 'with mod', mentions: [] }]);

  await clearActions(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type('   ');
  await page.keyboard.press('Enter');
  expect(await actions(page)).toEqual([]);
});

test('running: Enter steers, Mod+Enter queues, Esc stops', async ({ page }) => {
  await setRunning(page, true);
  await expect(page.getByTestId('composer')).toHaveAttribute('data-running', 'true');
  await page.keyboard.type('steer this');
  await page.keyboard.press('Enter');
  await page.keyboard.type('queue that');
  await page.keyboard.press(`${MOD}+Enter`);
  await page.keyboard.press('Escape');
  await page.keyboard.type('two');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('lines');
  expect(await paragraphs(page)).toEqual(['two', 'lines']);
  expect(await actions(page)).toEqual([
    { kind: 'steer', text: 'steer this', mentions: [] },
    { kind: 'queue', text: 'queue that', mentions: [] },
    { kind: 'stop' },
  ]);
  await setRunning(page, false);
  await clearActions(page);
  await page.keyboard.press('Enter');
  expect(await actions(page)).toEqual([{ kind: 'send', text: 'two\nlines', mentions: [] }]);
});

test('a mention keeps its data, chip and sent text apart', async ({ page }, testInfo) => {
  await page.keyboard.type('look at ');
  await page.keyboard.type('@');
  await expect(page.getByTestId('mention-popup')).toBeVisible();
  await page.keyboard.type('main');
  await expect(page.getByRole('option')).toHaveText(['@main.tsapps/desktop/src/main/main.ts']);
  await page.screenshot({ path: testInfo.outputPath('mention-popup.png') });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('mention-popup')).toBeHidden();
  const chip = editor(page).locator('.mention-chip');
  await expect(chip).toHaveText('@main.ts');
  await expect(chip).toHaveAttribute('data-piarc-mention', 'main');
  await page.keyboard.type('please');
  await page.keyboard.press('Enter');
  expect(await actions(page)).toEqual([
    { kind: 'mentionOpened' },
    { kind: 'mentionChosen', path: 'apps/desktop/src/main/main.ts' },
    {
      kind: 'send',
      text: 'look at @apps/desktop/src/main/main.ts please',
      mentions: ['apps/desktop/src/main/main.ts'],
    },
  ]);
  // The transcript echoes the display form: a chip with the label, not the path.
  await expect(page.getByTestId('user-message').locator('.mention-chip')).toHaveText('@main.ts');
});

test('Esc closes the mention picker before it stops anything', async ({ page }) => {
  await setRunning(page, true);
  await page.keyboard.type('@rea');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('mention-popup')).toBeHidden();
  expect(await actions(page)).toEqual([{ kind: 'mentionOpened' }]);
  await page.keyboard.press('Escape');
  expect(await actions(page)).toEqual([{ kind: 'mentionOpened' }, { kind: 'stop' }]);
});

test('/ in an empty composer asks for the command list', async ({ page }) => {
  await page.keyboard.type('/');
  expect(await actions(page)).toEqual([{ kind: 'command' }]);
  await page.keyboard.type('x /');
  expect(await actions(page)).toEqual([{ kind: 'command' }]);
});

// --- Input method composition ------------------------------------------------------------

async function compose(cdp: CDPSession, text: string): Promise<void> {
  await cdp.send('Input.imeSetComposition', {
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
  });
}

/** A key the input method consumes: keyCode 229, as Chromium reports it during composition. */
async function processKey(cdp: CDPSession, key: string, code: string): Promise<void> {
  for (const type of ['rawKeyDown', 'keyUp'] as const) {
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      key,
      code,
      windowsVirtualKeyCode: 229,
      nativeVirtualKeyCode: 229,
    });
  }
}

/** A key with its own key code, pressed while the composition is still open. */
async function plainKey(
  cdp: CDPSession,
  key: string,
  code: string,
  keyCode: number,
): Promise<void> {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  });
}

interface CompositionLog {
  composing: boolean[];
  events: string[];
}

declare global {
  var __piarcCompositionLog: CompositionLog | undefined;
}

async function watchComposition(page: Page): Promise<void> {
  await page.evaluate(() => {
    const log: CompositionLog = { composing: [], events: [] };
    globalThis.__piarcCompositionLog = log;
    const target = document.querySelector('[data-testid="composer-input"]');
    for (const type of ['compositionstart', 'compositionend']) {
      target?.addEventListener(type, () => log.events.push(type));
    }
    target?.addEventListener(
      'keydown',
      (event) => {
        if (event instanceof KeyboardEvent) {
          // `keyCode` is deprecated but still the signal input methods give (architecture 8.5).
          const fields: { readonly isComposing: boolean; readonly keyCode: number } = event;
          log.composing.push(fields.isComposing || fields.keyCode === 229);
        }
      },
      { capture: true },
    );
  });
}

async function compositionLog(page: Page): Promise<CompositionLog> {
  return page.evaluate(() => globalThis.__piarcCompositionLog ?? { composing: [], events: [] });
}

test('keys during an input method composition trigger nothing', async ({ page }, testInfo) => {
  const cdp = await page.context().newCDPSession(page);
  await watchComposition(page);
  for (const running of [false, true]) {
    await setRunning(page, running);
    await clearActions(page);
    await compose(cdp, 'ni');
    await compose(cdp, 'nihao');
    // Keys the input method consumes (keyCode 229) …
    await processKey(cdp, 'Enter', 'Enter');
    await processKey(cdp, 'Escape', 'Escape');
    await processKey(cdp, '/', 'Slash');
    await processKey(cdp, '@', 'Digit2');
    // … and the composition text itself may contain the trigger characters.
    await compose(cdp, 'nihao@/');
    // A key with its own code while the composition is open (isComposing is set).
    await plainKey(cdp, 'Enter', 'Enter', 13);
    await plainKey(cdp, 'Escape', 'Escape', 27);
    await expect(page.getByTestId('mention-popup')).toBeHidden();
    expect(await actions(page), `running=${String(running)}`).toEqual([]);
    if (!running) {
      await page.screenshot({ path: testInfo.outputPath('composition.png') });
    }
    await cdp.send('Input.insertText', { text: '你好' });
    expect(await actions(page), `running=${String(running)}`).toEqual([]);
    expect(await paragraphs(page)).toEqual([running ? '你好你好' : '你好']);
  }
  const log = await compositionLog(page);
  expect(log.events).toEqual([
    'compositionstart',
    'compositionend',
    'compositionstart',
    'compositionend',
  ]);
  expect(log.composing.length).toBeGreaterThan(0);
  expect(log.composing.every(Boolean)).toBe(true);
});

test('keyCode 229 keys arriving before compositionstart trigger nothing', async ({ page }) => {
  // Chromium sends the first key of a composition as keyCode 229 before compositionstart, so
  // ProseMirror does not consider the editor composing yet; only the guard stops these.
  const cdp = await page.context().newCDPSession(page);
  await page.keyboard.type('draft');
  await processKey(cdp, 'Enter', 'Enter');
  await setRunning(page, true);
  await processKey(cdp, 'Enter', 'Enter');
  await processKey(cdp, 'Escape', 'Escape');
  expect(await actions(page)).toEqual([]);
  expect(await paragraphs(page)).toEqual(['draft']);
});

test('a composition that is just @ or / starts no mention and no command', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await compose(cdp, '/');
  await compose(cdp, '');
  await cdp.send('Input.insertText', { text: '' });
  await compose(cdp, '@');
  await expect(page.getByTestId('mention-popup')).toBeHidden();
  await cdp.send('Input.insertText', { text: '@' });
  await expect(page.getByTestId('mention-popup')).toBeHidden();
  expect(await actions(page)).toEqual([]);
  expect(await paragraphs(page)).toEqual(['@']);
});

test('after the composition ends, keys and triggers work again', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await compose(cdp, 'nihao');
  await processKey(cdp, 'Enter', 'Enter');
  await cdp.send('Input.insertText', { text: '你好' });
  expect(await actions(page)).toEqual([]);
  await page.keyboard.type(' @');
  await expect(page.getByTestId('mention-popup')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  expect(await actions(page)).toEqual([
    { kind: 'mentionOpened' },
    { kind: 'send', text: '你好 @', mentions: [] },
  ]);
  // Japanese: a cancelled composition leaves the composer empty, and / works again.
  await clearActions(page);
  await compose(cdp, 'にほん');
  await processKey(cdp, 'Escape', 'Escape');
  await compose(cdp, '');
  await cdp.send('Input.insertText', { text: '' });
  expect(await actions(page)).toEqual([]);
  await page.keyboard.type('/');
  expect(await actions(page)).toEqual([{ kind: 'command' }]);
});
