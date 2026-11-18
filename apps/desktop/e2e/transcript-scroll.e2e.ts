// T09-A11: scroll following. At the bottom, growth keeps the view at the bottom; scrolling up
// (wheel, keyboard, scrollbar) beyond the release distance stops following; scrolling back
// within the resume distance follows again; beyond the button distance "Back to bottom" shows.
import { writeFile } from 'node:fs/promises';

import type { Page } from '@playwright/test';

import { expect, test } from './fixtures.js';
import {
  addMessage,
  loadHistory,
  openLab,
  scrollState,
  scrollThresholds,
  streamTurn,
} from './transcript.js';

/** Largest distance from the bottom seen after each painted frame for `ms`. */
async function maxDistanceWhileGrowing(
  page: Page,
  ms: number,
): Promise<{ max: number; grew: number; samples: number }> {
  return page.evaluate(async (duration) => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="transcript-scroller"]');
    if (scroller === null) {
      throw new Error('no scroller');
    }
    const startHeight = scroller.scrollHeight;
    let max = 0;
    let samples = 0;
    const end = performance.now() + duration;
    while (performance.now() < end) {
      // Sample after the frame was painted: requestAnimationFrame, then a task.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => setTimeout(resolve, 0));
      samples += 1;
      max = Math.max(max, scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight);
    }
    return { max, grew: scroller.scrollHeight - startHeight, samples };
  }, ms);
}

/** Marks user input (a wheel event that does not scroll) and sets the scroll position. */
async function userScrollTo(page: Page, distanceFromBottom: number): Promise<void> {
  await page.evaluate((distance) => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="transcript-scroller"]');
    if (scroller === null) {
      throw new Error('no scroller');
    }
    const next = scroller.scrollHeight - scroller.clientHeight - distance;
    if (next === scroller.scrollTop) return;
    const changed = new Promise<void>((resolve) => {
      scroller.addEventListener(
        'scroll',
        () => {
          resolve();
        },
        { once: true },
      );
    });
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 0, bubbles: true }));
    scroller.scrollTop = next;
    return changed;
  }, distanceFromBottom);
}

/** Follow is allowed to pin after the configured user-input grace period. */
async function waitForFollowAfterInput(page: Page): Promise<void> {
  await expect(page.getByTestId('transcript')).toHaveAttribute('data-following', 'true');
  await page.evaluate(async () => {
    const threshold = globalThis.__piarcTranscriptLab?.scrollThresholds().userInputWindowMs;
    if (threshold === undefined) throw new Error('missing scroll thresholds');
    const until = performance.now() + threshold;
    while (performance.now() <= until) await new Promise(requestAnimationFrame);
  });
}

test.beforeEach(async ({ page }) => {
  await openLab(page);
  await loadHistory(page, 200);
});

test('keeps the bottom in view while a reply streams', async ({ app, page }, testInfo) => {
  const displays = await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error('No transcript window');
    const current = screen.getDisplayMatching(window.getBounds());
    const fastest = screen
      .getAllDisplays()
      .reduce(
        (best, display) => (display.displayFrequency > best.displayFrequency ? display : best),
        current,
      );
    if (fastest.id !== current.id) window.setPosition(fastest.workArea.x, fastest.workArea.y);
    return {
      availableHz: screen.getAllDisplays().map((display) => display.displayFrequency),
      windowHz: screen.getDisplayMatching(window.getBounds()).displayFrequency,
    };
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const streaming = streamTurn(page, { tokensPerSecond: 200, seconds: 4 });
  await page.locator('[data-testid="agent-message"][aria-busy="true"]').first().waitFor();
  const measurement = await maxDistanceWhileGrowing(page, 2_000);
  await writeFile(
    testInfo.outputPath('scroll-follow.json'),
    JSON.stringify({ ...displays, cpuThrottlingRate: 4, ...measurement }, null, 2),
  );
  const { max, grew } = measurement;
  expect(grew).toBeGreaterThan(200);
  expect(max).toBeLessThanOrEqual(1);
  await streaming;
  expect((await scrollState(page)).following).toBe(true);
});

test('the wheel releases and resumes following', async ({ page }, testInfo) => {
  const streaming = streamTurn(page, { tokensPerSecond: 200, seconds: 5 });
  await page.locator('[data-testid="agent-message"][aria-busy="true"]').first().waitFor();
  const box = await page.getByTestId('transcript').boundingBox();
  if (box === null) {
    throw new Error('no transcript box');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -600);
  await expect(page.getByTestId('transcript')).toHaveAttribute('data-following', 'false');
  const released = await scrollState(page);
  expect(released.following).toBe(false);
  await expect(page.getByTestId('back-to-bottom')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('released.png') });
  // Growth no longer moves the view.
  await expect
    .poll(async () => (await scrollState(page)).scrollHeight)
    .toBeGreaterThan(released.scrollHeight);
  const later = await scrollState(page);
  expect(later.scrollTop).toBe(released.scrollTop);
  expect(later.scrollHeight).toBeGreaterThan(released.scrollHeight);

  await page.mouse.wheel(0, 100_000);
  await waitForFollowAfterInput(page);
  expect((await scrollState(page)).following).toBe(true);
  const { max } = await maxDistanceWhileGrowing(page, 800);
  expect(max).toBeLessThanOrEqual(1);
  await expect(page.getByTestId('back-to-bottom')).toBeHidden();
  await streaming;
});

test('the keyboard releases following and "Back to bottom" restores it', async ({ page }) => {
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('[data-testid="transcript-scroller"]')?.focus();
  });
  await page.keyboard.press('PageUp');
  await expect(page.getByTestId('transcript')).toHaveAttribute('data-following', 'false');
  expect((await scrollState(page)).following).toBe(false);
  await page.getByTestId('back-to-bottom').click();
  const state = await scrollState(page);
  expect(state.following).toBe(true);
  expect(state.distanceFromBottom).toBeLessThanOrEqual(1);
  await expect(page.getByTestId('back-to-bottom')).toBeHidden();
  await addMessage(page, 'A new reply after jumping back.\n\nWith a second paragraph.');
  expect((await scrollState(page)).distanceFromBottom).toBeLessThanOrEqual(1);
});

test('dragging the scrollbar releases following', async ({ page }) => {
  // Following, so the scrollbar thumb sits at the bottom end of the track.
  const geometry = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="transcript-scroller"]');
    if (scroller === null) {
      throw new Error('no scroller');
    }
    const box = scroller.getBoundingClientRect();
    return {
      x: box.right - (scroller.offsetWidth - scroller.clientWidth) / 2,
      y: box.top + scroller.clientHeight - 4,
      scrollbar: scroller.offsetWidth - scroller.clientWidth,
    };
  });
  // The transcript styles its scrollbar, so it is never a hidden overlay scrollbar.
  expect(geometry.scrollbar).toBeGreaterThan(0);
  await page.mouse.move(geometry.x, geometry.y);
  await page.mouse.down();
  await page.mouse.move(geometry.x, geometry.y - 150, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByTestId('transcript')).toHaveAttribute('data-following', 'false');
  const state = await scrollState(page);
  expect(state.distanceFromBottom).toBeGreaterThan(100);
  expect(state.following).toBe(false);
});

test('release, resume and button thresholds', async ({ page }) => {
  const { releasePx, resumePx, buttonPx } = await scrollThresholds(page);
  await userScrollTo(page, releasePx);
  expect((await scrollState(page)).following).toBe(true);
  await userScrollTo(page, releasePx + 1);
  expect((await scrollState(page)).following).toBe(false);

  await userScrollTo(page, buttonPx);
  await expect(page.getByTestId('back-to-bottom')).toBeHidden();
  await userScrollTo(page, buttonPx + 1);
  await expect(page.getByTestId('back-to-bottom')).toBeVisible();
  // Released: a new message does not move the view.
  const before = await scrollState(page);
  await addMessage(page, 'Grows while released.');
  expect((await scrollState(page)).scrollTop).toBe(before.scrollTop);

  await userScrollTo(page, resumePx + 1);
  expect((await scrollState(page)).following).toBe(false);
  await userScrollTo(page, resumePx);
  expect((await scrollState(page)).following).toBe(true);
  await waitForFollowAfterInput(page);
  await addMessage(page, 'Grows while following.');
  expect((await scrollState(page)).distanceFromBottom).toBeLessThanOrEqual(1);
});
