// T19-A04–A07: the composer against the real Core — `@` mentions from Core's fuzzy file search
// (ignore files honored, chips kept apart from the text the model reads), the `/` palette with
// fuzzy filtering, the input method guard, image and PDF attachments by drop and paste (and the
// limits), and steering, queueing, editing and deleting queued inputs, and stopping a turn.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { CDPSession, Page } from '@playwright/test';

import { expect, test } from './sessions.js';
import {
  idle,
  lastUserBlocks,
  openSession,
  requests,
  roles,
  screenshots,
  send,
  typeInComposer,
  userTexts,
} from './t19.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const FIXTURES = path.join(import.meta.dirname, '..', '..', '..', 'tests', 'scenarios', 'fixtures');

const FILES = {
  '.gitignore': 'build/\n*.log\n',
  'src/main.ts': 'export {};\n',
  'src/mention/MainView.tsx': 'export {};\n',
  'build/main.js': '// built\n',
  'debug.log': 'noise\n',
  'README.md': '# Readme\n',
};

test.beforeEach(async ({ userDataDir }) => {
  // A model that accepts images (attachments go to it as image content).
  const file = path.join(userDataDir, 'pi', 'models.json');
  const models = JSON.parse(await readFile(file, 'utf8')) as {
    providers: Record<string, { models: { input: string[] }[] }>;
  };
  for (const provider of Object.values(models.providers)) {
    for (const model of provider.models) {
      model.input = ['text', 'image'];
    }
  }
  await writeFile(file, JSON.stringify(models));
});

async function cdpOf(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

/** Starts an input method composition showing `text`. */
async function compose(cdp: CDPSession, text: string): Promise<void> {
  await cdp.send('Input.imeSetComposition', {
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
  });
}

/** A key the input method consumes (keyCode 229). */
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

/** Drops (or pastes) files into the composer, built in the page from bytes. */
async function giveFiles(
  page: Page,
  how: 'drop' | 'paste',
  files: { name: string; type: string; base64: string }[],
): Promise<void> {
  await page.getByTestId('composer-input').evaluate(
    (target, { how: kind, files: list }) => {
      const transfer = new DataTransfer();
      for (const file of list) {
        const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
        transfer.items.add(new File([bytes], file.name, { type: file.type }));
      }
      const event =
        kind === 'drop'
          ? new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true })
          : new ClipboardEvent('paste', {
              clipboardData: transfer,
              bubbles: true,
              cancelable: true,
            });
      target.dispatchEvent(event);
    },
    { how, files },
  );
}

async function fixture(name: string): Promise<string> {
  return (await readFile(path.join(FIXTURES, name))).toString('base64');
}

test('@ mentions come from Core, honor ignore files and stay apart from the sent text', async ({
  app,
  page,
  mock,
  workspaces,
}, testInfo) => {
  await openSession(app, page, workspaces, 'mention 提及', 't19-input', 'Hello', FILES);
  await idle(page);
  await typeInComposer(page, 'Compare @main');
  const popup = page.getByTestId('mention-popup');
  await expect(popup.getByRole('option').first()).toContainText('main.ts');
  const shown = await popup.locator('.mention-path').allTextContents();
  expect(shown).toContain('src/main.ts');
  expect(shown).not.toContain('build/main.js');
  await page.screenshot({ path: testInfo.outputPath('mention-popup.png') });
  // Fuzzy: the letters in order, across the path.
  await page.keyboard.type('Vi');
  await expect(popup.locator('.mention-path')).toHaveText(['src/mention/MainView.tsx']);
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid="composer-input"] .mention-chip')).toHaveText(
    '@MainView.tsx',
  );
  await page.keyboard.type('and the readme');
  await page.keyboard.press('Enter');
  await idle(page);

  // Display: the chip; data: the path; sent text: `@path` in place.
  const message = page.getByTestId('user-message').nth(1);
  const chip = message.getByTestId('mention-chip');
  await expect(chip).toHaveText('@MainView.tsx');
  await expect(chip).toHaveAttribute('data-path', 'src/mention/MainView.tsx');
  const sent = await requests(mock, 't19-input');
  expect(userTexts(sent.at(-1)?.body ?? {}).at(-1)).toBe(
    'Compare @src/mention/MainView.tsx and the readme',
  );
  await screenshots(page, testInfo, 'mention-sent');
});

test('the / palette lists Core’s commands; an input method composition triggers nothing', async ({
  app,
  page,
  workspaces,
}, testInfo) => {
  await openSession(app, page, workspaces, 'palette 面板', 't19-chat', 'Hello');
  await idle(page);
  await typeInComposer(page, '/');
  const palette = page.getByTestId('command-popup');
  await expect(palette.getByRole('option')).toHaveCount(3);
  await expect(palette.locator('[data-command]')).toHaveText([/\/clear/u, /\/compact/u, /\/help/u]);
  await page.screenshot({ path: testInfo.outputPath('command-palette.png') });
  await page.keyboard.type('hl');
  await expect(palette.locator('[data-command]')).toHaveText([/\/help/u]);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('help-commands')).toBeVisible();
  await page.keyboard.press('Escape');

  // During a composition: `/`, `@`, Enter and Esc do nothing.
  const cdp = await cdpOf(page);
  await page.getByTestId('composer-input').click();
  const before = await page.getByTestId('user-message').count();
  await compose(cdp, '/');
  await processKey(cdp, '/', 'Slash');
  await compose(cdp, '/@');
  await processKey(cdp, '@', 'Digit2');
  await processKey(cdp, 'Enter', 'Enter');
  await processKey(cdp, 'Escape', 'Escape');
  await expect(palette).toHaveCount(0);
  await expect(page.getByTestId('mention-popup')).toHaveCount(0);
  await cdp.send('Input.insertText', { text: '你好' });
  await expect(page.getByTestId('composer-input')).toHaveText('你好');
  expect(await page.getByTestId('user-message').count()).toBe(before);
  // After the composition, Enter sends.
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('user-message')).toHaveCount(before + 1);
});

test('images and PDFs by drop and paste reach the model; refused files say why', async ({
  app,
  page,
  mock,
  workspaces,
}, testInfo) => {
  await openSession(app, page, workspaces, 'attach 附件', 't19-input', 'Hello');
  await idle(page);
  const png = await fixture('pixel.png');
  const pdf = await fixture('report.pdf');
  await giveFiles(page, 'drop', [{ name: 'pixel 像素.png', type: 'image/png', base64: png }]);
  await page.getByTestId('composer-input').click();
  await giveFiles(page, 'paste', [{ name: 'report.pdf', type: 'application/pdf', base64: pdf }]);
  await expect(page.getByTestId('pending-attachment')).toHaveCount(2);
  // Not accepted: another type, and an image over Core's limit.
  const big = Buffer.alloc(6 * 1024 * 1024, 1).toString('base64');
  await giveFiles(page, 'drop', [
    { name: 'notes.txt', type: 'text/plain', base64: Buffer.from('x').toString('base64') },
    { name: 'huge.png', type: 'image/png', base64: big },
  ]);
  const problems = page.getByTestId('composer-problems');
  await expect(problems).toContainText('notes.txt cannot be attached');
  await expect(problems).toContainText('huge.png is too large');
  await expect(page.getByTestId('pending-attachment')).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath('attachments-pending.png') });
  await send(page, 'What is in these?');
  await idle(page);

  const chips = page.getByTestId('user-message').nth(1).getByTestId('attachment-chip');
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(0)).toHaveAttribute('data-kind', 'image');
  await expect(chips.nth(1)).toContainText('PDF report.pdf, 12 pages');
  const sent = await requests(mock, 't19-input');
  const blocks = lastUserBlocks(sent.at(-1)?.body ?? {});
  const image = blocks.find((block) => block.type === 'image') as
    { source?: { media_type?: string; data?: string } } | undefined;
  expect(image?.source?.media_type).toBe('image/png');
  expect(image?.source?.data).toBe(png);
  const text = blocks
    .filter((block) => block.type === 'text')
    .map((block) => String(block.text))
    .join('\n');
  expect(text.startsWith('What is in these?')).toBe(true);
  expect(text).toContain('<attachment name="report.pdf" type="application/pdf" pages="12"');
  expect(text).toContain('Report page 12');
  await screenshots(page, testInfo, 'attachments-sent');
});

test('running: Enter steers, Mod+Enter queues (edit, delete), Esc stops', async ({
  app,
  page,
  mock,
  workspaces,
}, testInfo) => {
  test.setTimeout(90_000);
  await openSession(app, page, workspaces, 'steer 插话', 't19-steer', 'Wait for the signal');
  const composer = page.getByTestId('composer');
  await expect(composer).toHaveAttribute('data-running', 'true', { timeout: 20_000 });
  await expect(page.getByTestId('bash-card')).toBeVisible();
  await page.getByRole('button', { name: 'Allow once', exact: true }).click();
  // Enter while running: a steering message for this turn.
  await send(page, 'Also mention the steer');
  // Mod+Enter: queued for after the turn; edited, then a second one deleted.
  await typeInComposer(page, 'Then follow up');
  await page.keyboard.press(`${MOD}+Enter`);
  await typeInComposer(page, 'Never mind');
  await page.keyboard.press(`${MOD}+Enter`);
  const queued = page.getByTestId('queue-item').filter({ hasText: 'Then follow up' });
  await expect(queued).toHaveAttribute('data-kind', 'followUp');
  await page.screenshot({ path: testInfo.outputPath('queue.png') });
  await queued.getByTestId('queue-edit').click();
  await page.getByTestId('queue-editor').fill('Then follow up, edited');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('queue-item').filter({ hasText: 'edited' })).toHaveCount(1);
  await page
    .getByTestId('queue-item')
    .filter({ hasText: 'Never mind' })
    .getByTestId('queue-delete')
    .click();
  await expect(page.getByTestId('queue-item').filter({ hasText: 'Never mind' })).toHaveCount(0);
  await idle(page, 40_000);
  await expect(
    page.getByTestId('agent-message').filter({ hasText: 'queued follow-up' }),
  ).toHaveCount(1, {
    timeout: 20_000,
  });
  const sent = await requests(mock, 't19-steer');
  // The steer reached the model in the running turn (after the command's result) …
  // Pi sends the tool result and the steer as adjacent user messages (ADR-0026).
  expect(sent.map(roles)).toEqual([
    ['user'],
    ['user', 'assistant', 'user', 'user'],
    ['user', 'assistant', 'user', 'user', 'assistant', 'user'],
  ]);
  expect(userTexts(sent[1]?.body ?? {})).toContain('Also mention the steer');
  // … and the follow-up started the next turn, as edited; the deleted one never went out.
  expect(userTexts(sent[2]?.body ?? {}).at(-1)).toBe('Then follow up, edited');
  expect(sent.flatMap((request) => userTexts(request.body))).not.toContain('Never mind');
});

test('Esc stops the running turn', async ({ app, page, workspaces }) => {
  await openSession(app, page, workspaces, 'stop 停止', 't19-stop', 'Write a long answer');
  await expect(page.getByTestId('composer')).toHaveAttribute('data-running', 'true', {
    timeout: 20_000,
  });
  await page.getByTestId('composer-input').click();
  await page.keyboard.press('Escape');
  await idle(page);
  await expect(page.getByTestId('agent-message').first()).toHaveClass(/is-interrupted/u);
});
