// T09-A07: model output with XSS payloads renders as text, nothing it carries runs or loads,
// links go through the main process's confirmation, and the CSP is the one T03 set.
import { PRODUCTION_CSP } from '../src/main/security/csp.js';
import { XSS_PAYLOADS, xssMessage } from '../src/shared/xss-payloads.js';
import { expect, test } from './fixtures.js';
import {
  addMessage,
  expectInert,
  inspect,
  openLab,
  streamTurn,
  watchMarkup,
} from './transcript.js';

test.beforeEach(async ({ page }) => {
  await openLab(page);
  await watchMarkup(page);
});

test('renders every payload of a finished message as inert text', async ({ page }, testInfo) => {
  for (const payload of XSS_PAYLOADS) {
    await addMessage(page, payload.markdown);
  }
  const combined = await addMessage(page, xssMessage());
  const row = page.locator(`[data-row-id="${combined}"]`);
  // Interact with what the payloads target: hover the element with onmouseover, click the
  // javascript: link (rendered without a target).
  await row.getByText('hover me').first().hover();
  await row.getByText('click me').first().click();
  expectInert(await inspect(page));
  await page.screenshot({ path: testInfo.outputPath('xss.png') });
});

test('renders the payloads inertly while they stream', async ({ page }) => {
  await streamTurn(page, { tokensPerSecond: 400, messages: [xssMessage()] });
  expectInert(await inspect(page));
});

test('shows remote images as links and never loads them', async ({ page }) => {
  const id = await addMessage(page, '![tracking pixel](https://example.com/pixel.png "title")');
  const link = page.locator(`[data-row-id="${id}"] a.md-link`);
  await expect(link).toHaveAttribute('href', 'https://example.com/pixel.png');
  await expect(link).toHaveText('Image: tracking pixel');
  const result = await inspect(page);
  expect(result.forbidden).toEqual([]);
  expect(result.remoteRequests).toEqual([]);
});

test('opens links only through the main process confirmation', async ({ app, page }) => {
  await app.evaluate(({ dialog, shell }) => {
    const calls: string[] = [];
    (globalThis as { __linkCalls?: string[] }).__linkCalls = calls;
    dialog.showMessageBox = (...args: unknown[]) => {
      const options = args.at(-1);
      const detail =
        typeof options === 'object' && options !== null && 'detail' in options
          ? String(options.detail)
          : '';
      calls.push(`confirm ${detail}`);
      return Promise.resolve({ response: 1, checkboxChecked: false });
    };
    shell.openExternal = (url: string) => {
      calls.push(`open ${url}`);
      return Promise.resolve();
    };
  });
  const id = await addMessage(page, 'See [the docs](https://example.com/docs?q=1) for details.');
  const before = page.url();
  await page.locator(`[data-row-id="${id}"] a.md-link`).click();
  await expect
    .poll(() => app.evaluate(() => (globalThis as { __linkCalls?: string[] }).__linkCalls ?? []))
    .toEqual(['confirm https://example.com/docs?q=1']);
  // Cancelled in the dialog: nothing opened, and the window stayed on the app.
  expect(page.url()).toBe(before);
});

test('serves the page and its workers with the CSP of T03', async ({ page }) => {
  const headers = await page.evaluate(async () => {
    // The worker scripts are named in the entry chunk (`new URL(..., import.meta.url)`).
    const entry = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
    const source = entry === null ? '' : await (await fetch(entry.src)).text();
    const workerUrls = [...source.matchAll(/[\w./-]*(?:markdown|highlight)\.worker-[\w-]+\.js/gu)]
      .map((match) => new URL(match[0].replace(/^.*?assets\//u, '/assets/'), location.href).href)
      .filter((url, index, all) => all.indexOf(url) === index);
    const urls = ['/index.html', ...workerUrls];
    return Promise.all(
      urls.map(async (url) => {
        const response = await fetch(url);
        return { url, csp: response.headers.get('content-security-policy') };
      }),
    );
  });
  expect(headers.length).toBe(3);
  for (const { url, csp } of headers) {
    expect(csp, url).toBe(PRODUCTION_CSP);
  }
});
