// A05: navigation away from the app scheme is blocked whether it comes from `location`, a link
// or a redirect, and the window stays on the app page.
import type { Page } from '@playwright/test';

import { expect, test } from './fixtures.js';

const ENTRY_URL = 'app://piarc/index.html';

declare global {
  interface Window {
    __pageMarker?: string;
  }
}

/** Marks the current document so a test can tell whether it was replaced. */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__pageMarker = 'original document';
  });
}

// Checked inside the page: after a cancelled navigation Playwright's locators keep waiting for
// the navigation to finish.
async function expectOriginalDocument(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => ({
      url: window.location.href,
      marker: window.__pageMarker,
      shell: document.querySelector('[data-testid="app-shell"]') !== null,
    })),
  ).toEqual({ url: ENTRY_URL, marker: 'original document', shell: true });
}

test('blocks changing location to an external address', async ({ page, appLog }) => {
  await markDocument(page);
  await page.evaluate(() => {
    window.location.href = 'https://example.com/';
  });
  await appLog.waitFor(/\[security\] blocked navigation to https:\/\/example\.com/);
  await expectOriginalDocument(page);
});

test('blocks following an external link', async ({ page, appLog }) => {
  await markDocument(page);
  await page.evaluate(() => {
    const link = document.createElement('a');
    link.href = 'https://example.com/landing';
    link.textContent = 'external link';
    link.id = 'external-link';
    // Keep it inside the viewport; #root already fills the window.
    link.style.position = 'fixed';
    link.style.top = '8px';
    link.style.left = '8px';
    document.body.append(link);
  });
  // A real mouse click (a trusted user gesture). `locator.click` would wait for the cancelled
  // navigation to finish.
  const box = await page.locator('#external-link').boundingBox();
  if (box === null) {
    throw new Error('The injected link is not rendered');
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await appLog.waitFor(/\[security\] blocked navigation to https:\/\/example\.com/);
  await expectOriginalDocument(page);
});

test('blocks a redirect from an app page to an external address', async ({ app, page, appLog }) => {
  // Simulate a response that redirects: the first hop stays on the app origin, so
  // will-navigate allows it, and the redirect must be stopped by will-redirect.
  await app.evaluate(({ session }) => {
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['app://piarc/redirect-probe'] },
      (_details, callback) => {
        callback({ redirectURL: 'https://example.com/redirected' });
      },
    );
  });
  await markDocument(page);
  await page.evaluate(() => {
    window.location.href = 'app://piarc/redirect-probe';
  });
  await appLog.waitFor(/\[security\] blocked redirect to https:\/\/example\.com/);
  await expectOriginalDocument(page);
});

test('allows navigation within the app origin', async ({ page }) => {
  await markDocument(page);
  await Promise.all([
    page.waitForURL(`${ENTRY_URL}?reloaded=1`),
    page.evaluate((url) => {
      window.location.href = url;
    }, `${ENTRY_URL}?reloaded=1`),
  ]);
  await expect(page.getByTestId('app-shell')).toBeVisible();
  expect(await page.evaluate(() => window.__pageMarker)).toBeUndefined();
});
