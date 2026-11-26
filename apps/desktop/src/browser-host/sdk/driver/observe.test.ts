// Ported from ego-browser package/ego-browser/src/driver/observe.test.mjs (ego-lite commit 56589ea8,
// MIT, see LICENSE). PiArc: Vitest with FakeBindings; the screenshot tests drive
// captureScreenshotForSession (the v1 captureScreenshot wrapper is gone) and check the attached
// image instead of a written file; the v1 snapshotText and elementCenter tests and the
// file-path/output-directory tests are dropped; the size-limit tests are new.

import { afterEach, expect, test } from 'vitest';

import type { SnapshotResult } from '../../../shared/browser-host.js';
import { FakeBindings, installBindings, type CdpRequestMessage } from '../../testing.js';
import { browserCdp, ensureSession, invalidateSession } from '../browser-runtime.js';
import type { CdpObject } from '../cdp-types.js';
import type { EgoSnapshotOptions } from '../ego-bindings.js';
import {
  captureScreenshotForSession,
  MAX_SCREENSHOT_EDGE,
  snapshot,
  type CaptureScreenshotOptions,
} from './observe.js';

let restoreBindings: (() => void) | undefined;

afterEach(() => {
  invalidateSession();
  restoreBindings?.();
  restoreBindings = undefined;
});

interface Viewport {
  dpr: number;
  w: number;
  h: number;
  sx: number;
  sy: number;
  pw: number;
  ph: number;
}

const DEFAULT_VIEWPORT: Viewport = { dpr: 2, w: 800, h: 600, sx: 24, sy: 1200, pw: 1600, ph: 3000 };

function cdpRuntime(viewport: Viewport = DEFAULT_VIEWPORT, imageData = btoa('png')): FakeBindings {
  const bindings = new FakeBindings({
    listTabs: () =>
      Promise.resolve({
        tabs: [
          {
            index: 0,
            targetId: 'target-1',
            active: true,
            title: 'Example',
            url: 'https://example.com/',
            openedBy: 'agent',
          },
        ],
      }),
    cdp(request: CdpRequestMessage): CdpObject {
      if (request.method === 'Target.attachToTarget') {
        return { sessionId: 'session-1' };
      }
      if (request.method === 'Page.captureScreenshot') {
        return { data: imageData };
      }
      if (request.method === 'Runtime.evaluate') {
        const { dpr, ...metrics } = viewport;
        return {
          result: {
            value: request.params.expression === 'window.devicePixelRatio' ? dpr : metrics,
          },
        };
      }
      return {};
    },
  });
  restoreBindings = installBindings(bindings);
  return bindings;
}

function screenshotRequest(bindings: FakeBindings): CdpRequestMessage | undefined {
  return bindings.sent.find((request) => request.method === 'Page.captureScreenshot');
}

/** The first 24 bytes of a PNG (signature, IHDR length and type, width, height), base64. */
function pngHeader(width: number, height: number): string {
  const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
  bytes.push(0x49, 0x48, 0x44, 0x52); // IHDR
  for (const value of [width, height]) {
    bytes.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  }
  bytes.push(8, 6, 0, 0, 0);
  return btoa(String.fromCharCode(...bytes));
}

test('snapshot compacts the native result before returning it', async () => {
  const calls: (EgoSnapshotOptions | undefined)[] = [];
  restoreBindings = installBindings(
    new FakeBindings({
      snapshot(options): Promise<SnapshotResult> {
        calls.push(options);
        return Promise.resolve({
          content: ['root', '  container', '    button [ref=1, loc=unstable]'].join('\n'),
          refs: [{ refId: 1, backendNodeId: 1, role: 'button', name: '', loc: 'unstable' }],
          truncated: false,
        });
      },
    }),
  );

  const result = await snapshot({ scope: 'full_page' });
  expect(calls).toEqual([{ scope: 'full_page' }]);
  expect(result.content).toBe('root\n  button [ref=1]');
  expect(result.refs[0]?.loc).toBeUndefined();
});

test('captureScreenshotForSession fails fast while a native dialog is pending', async () => {
  const bindings = cdpRuntime();
  await browserCdp('Runtime.evaluate', { expression: 'document.title' });
  bindings.emit({
    sessionId: 'session-1',
    method: 'Page.javascriptDialogOpening',
    params: {
      type: 'alert',
      message: 'Blocked',
      url: 'https://example.com/',
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const sentBefore = bindings.sent.length;

  // Chromium does not answer Page.captureScreenshot until the dialog
  // closes, so the capture must not be attempted at all.
  const error: unknown = await captureScreenshotForSession({}, 'session-1').then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ code: 'EGO_PAGE_DIALOG_OPENED' });
  expect((error as Error).message).toMatch(/page\.dismissDialog\(\)/);
  expect(
    bindings.sent
      .slice(sentBefore)
      .some(
        (request) =>
          request.method === 'Runtime.evaluate' || request.method === 'Page.captureScreenshot',
      ),
  ).toBe(false);
  expect(bindings.calls.some(([name]) => name === 'attachImage')).toBe(false);
});

test('captureScreenshotForSession clips the currently visible scrolled viewport', async () => {
  const bindings = cdpRuntime();
  await captureScreenshotForSession({}, await ensureSession());

  expect(screenshotRequest(bindings)?.params).toEqual({
    format: 'png',
    captureBeyondViewport: false,
    clip: {
      x: 24,
      y: 1200,
      width: 800,
      height: 600,
      scale: 0.5,
    },
  });
});

test('captureScreenshotForSession keeps CSS-pixel sizing when scale is explicit', async () => {
  const bindings = cdpRuntime();
  await captureScreenshotForSession({ scale: 'css' }, await ensureSession());

  expect(bindings.sent.some((request) => request.method === 'Runtime.evaluate')).toBe(true);
  expect(screenshotRequest(bindings)?.params.clip).toMatchObject({ scale: 0.5 });
});

test('captureScreenshotForSession rejects unsupported device scale', async () => {
  const options = { scale: 'device' } as unknown as CaptureScreenshotOptions;
  await expect(captureScreenshotForSession(options)).rejects.toThrow(
    /captureScreenshot scale must be css/,
  );
});

test('captureScreenshotForSession attaches the image and answers its number and size', async () => {
  const bindings = cdpRuntime();
  const shot = await captureScreenshotForSession({}, await ensureSession());

  expect(shot).toEqual({ image: 1, width: 800, height: 600 });
  expect(bindings.calls.filter(([name]) => name === 'attachImage')).toEqual([
    ['attachImage', { base64: btoa('png'), mediaType: 'image/png', width: 800, height: 600 }],
  ]);
});

test('captureScreenshotForSession scales a full page down to the attachment limit', async () => {
  const bindings = cdpRuntime();
  const shot = await captureScreenshotForSession({ full: true }, await ensureSession());

  const clip = screenshotRequest(bindings)?.params.clip;
  expect(clip).toMatchObject({ x: 0, y: 0, width: 1600, height: 3000 });
  const scale = (clip as { scale: number }).scale;
  expect(scale).toBeLessThan(0.5);
  expect(3000 * scale * 2).toBeLessThanOrEqual(MAX_SCREENSHOT_EDGE);
  expect(3000 * scale * 2).toBeGreaterThan(MAX_SCREENSHOT_EDGE - 1);
  expect(Math.max(shot.width, shot.height)).toBe(MAX_SCREENSHOT_EDGE);
  expect(shot.width).toBe(Math.round(1600 * scale * 2));
});

test('captureScreenshotForSession reports the size Chromium encoded in the PNG', async () => {
  cdpRuntime(DEFAULT_VIEWPORT, pngHeader(801, 599));
  const shot = await captureScreenshotForSession({}, await ensureSession());

  expect(shot).toEqual({ image: 1, width: 801, height: 599 });
});

test('captureScreenshotForSession scales an explicit clip to the attachment limit', async () => {
  const bindings = cdpRuntime({ ...DEFAULT_VIEWPORT, dpr: 1 });
  const shot = await captureScreenshotForSession(
    { clip: { x: 0, y: 0, width: 4000, height: 1000 } },
    await ensureSession(),
  );

  const clip = screenshotRequest(bindings)?.params.clip as { scale: number };
  expect(4000 * clip.scale).toBeLessThanOrEqual(MAX_SCREENSHOT_EDGE);
  expect(shot.width).toBe(MAX_SCREENSHOT_EDGE);
  expect(shot.height).toBe(392);
});
