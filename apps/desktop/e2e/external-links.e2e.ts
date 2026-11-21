// A06: new windows are denied; `window.piarc.openExternal` only calls `shell.openExternal`
// after the confirmation dialog, and only for https:, http: and mailto:. The dialog and
// shell.openExternal are replaced in the main process with recording doubles, so no browser
// is opened.
import type { ElectronApplication } from '@playwright/test';

import { expect, test } from './fixtures.js';

interface Recorder {
  __externalLinkCalls?: string[];
}

/** Replaces the dialog and shell.openExternal; the dialog answers with `response`. */
async function replaceExternalSideEffects(
  app: ElectronApplication,
  response: 0 | 1,
): Promise<void> {
  await app.evaluate(({ dialog, shell }, answer) => {
    const recorder = globalThis as Recorder;
    recorder.__externalLinkCalls = [];
    const calls = recorder.__externalLinkCalls;
    // The options object is the last argument, with or without a parent window.
    dialog.showMessageBox = (...args: unknown[]) => {
      const options: unknown = args.at(-1);
      const field = (name: string): unknown =>
        typeof options === 'object' && options !== null && name in options
          ? (options as Record<string, unknown>)[name]
          : undefined;
      const detail = field('detail');
      const buttons = field('buttons');
      calls.push(
        `confirm ${typeof detail === 'string' ? detail : ''} [${Array.isArray(buttons) ? buttons.join('|') : ''}]`,
      );
      return Promise.resolve({ response: answer, checkboxChecked: false });
    };
    shell.openExternal = (url: string) => {
      calls.push(`open ${url}`);
      return Promise.resolve();
    };
  }, response);
}

async function recordedCalls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as Recorder).__externalLinkCalls ?? []);
}

test('denies window.open and target=_blank links', async ({ app, page, appLog }) => {
  await replaceExternalSideEffects(app, 0);
  expect(await page.evaluate(() => window.open('https://example.com/popup') === null)).toBe(true);
  await appLog.waitFor(/\[security\] denied new window for https:\/\/example\.com/);
  expect(await page.evaluate(() => window.open('app://piarc/index.html') === null)).toBe(true);
  await page.evaluate(() => {
    const link = document.createElement('a');
    link.href = 'https://example.org/new-tab';
    link.target = '_blank';
    link.textContent = 'new tab link';
    link.id = 'blank-link';
    link.style.position = 'fixed';
    link.style.top = '8px';
    link.style.left = '8px';
    document.body.append(link);
  });
  const box = await page.locator('#blank-link').boundingBox();
  if (box === null) {
    throw new Error('The injected link is not rendered');
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await appLog.waitFor(/\[security\] denied new window for https:\/\/example\.org/);
  expect(app.windows()).toHaveLength(1);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  expect(await recordedCalls(app)).toEqual([]);
});

test('opens a link only after the user confirms', async ({ app, page }) => {
  await replaceExternalSideEffects(app, 0);
  expect(await page.evaluate(() => window.piarc.openExternal('https://example.com/docs?q=1'))).toBe(
    true,
  );
  // The dialog is in the app's language (T43): English or Chinese buttons.
  expect(await recordedCalls(app)).toEqual([
    expect.stringMatching(
      /^confirm https:\/\/example\.com\/docs\?q=1 \[(Open\|Cancel|打开\|取消)\]$/u,
    ),
    'open https://example.com/docs?q=1',
  ]);
});

test('does not open a link the user cancels', async ({ app, page }) => {
  await replaceExternalSideEffects(app, 1);
  expect(await page.evaluate(() => window.piarc.openExternal('mailto:someone@example.com'))).toBe(
    false,
  );
  expect(await recordedCalls(app)).toEqual([
    expect.stringMatching(/^confirm mailto:someone@example\.com \[(Open\|Cancel|打开\|取消)\]$/u),
  ]);
});

test('rejects javascript:, file: and other schemes without asking', async ({
  app,
  page,
  appLog,
}) => {
  await replaceExternalSideEffects(app, 0);
  const urls = [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,hello',
    'ftp://example.com/file',
    'piarc://open',
    'app://piarc/index.html',
    'not a url',
  ];
  const results = await page.evaluate(
    (values) => Promise.all(values.map((url) => window.piarc.openExternal(url))),
    urls,
  );
  expect(results).toEqual(urls.map(() => false));
  expect(await recordedCalls(app)).toEqual([]);
  await appLog.waitFor(/\[security\] rejected external link/);
});
