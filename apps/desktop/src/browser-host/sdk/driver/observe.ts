// Ported from ego-browser package/ego-browser/src/driver/observe.ts (ego-lite commit 56589ea8,
// MIT, see LICENSE). PiArc: v2 surface only (snapshot/snapshotRaw, captureScreenshotForSession);
// the v1 helpers (drainEvents, snapshotText, elementCenter, captureScreenshot) and the v1 ref map
// refresh are gone. Screenshots are not written to a file: the image is attached to the tool
// result through the attachImage binding (long edge <= 1568 px via the CDP clip scale) and the
// caller gets its number and size. The unreachable `raw` capture branch is dropped.

import { browserCdp, browserEgo } from '../browser-runtime.js';
import { runtimeValue } from '../cdp-eval.js';
import { isRecord } from '../cdp-types.js';
import type { EgoSnapshotOptions } from '../ego-bindings.js';
import { invokeEgo } from '../ego-errors.js';
import { compactSnapshotResult } from '../snapshot-result.js';

/** Upstream's scope/root/includeActionMarks/includeStableLocator, plus PiArc's tab. */
export type SnapshotOptions = EgoSnapshotOptions;

/** One snapshot ref, copied out of the binding's answer so compaction can edit it. */
export interface SnapshotCaptureRef {
  refId: number;
  backendNodeId: number;
  frameId?: string;
  role: string;
  name: string;
  loc?: string;
}

/** The native snapshot after compaction. */
export interface SnapshotCapture {
  content: string;
  refs: SnapshotCaptureRef[];
  truncated: boolean;
}

interface ScreenshotClip {
  x: number;
  y: number;
  width: number;
  height: number;
  scale?: number;
}

export type ScreenshotScale = 'css';

export interface CaptureScreenshotOptions {
  full?: boolean;
  /**
   * Upstream's device-pixel escape hatch. It only applied when `scale` was not `css`, which
   * `assertScreenshotScale` never allows, so it has no effect (as upstream).
   */
  raw?: boolean;
  clip?: ScreenshotClip;
  scale?: ScreenshotScale;
}

/** The longest edge, in pixels, of an image attached to the tool result (B2.6.7). */
export const MAX_SCREENSHOT_EDGE = 1568;

/** A screenshot attached to the tool result: its number there and its size in pixels. */
export interface ScreenshotAttachment {
  image: number;
  width: number;
  height: number;
}

export async function snapshot(options: SnapshotOptions = {}): Promise<SnapshotCapture> {
  const result = await invokeEgo('snapshot', () => browserEgo().snapshot(options));
  const capture: SnapshotCapture = {
    content: result.content,
    refs: result.refs.map((ref) => ({ ...ref })),
    truncated: result.truncated,
  };
  return compactSnapshotResult(capture);
}

export const snapshotRaw = snapshot;

/**
 * Capture a screenshot through one explicit target session and attach it to the tool result.
 * Page objects use this entry point so another active tab cannot affect evaluation or capture.
 */
export async function captureScreenshotForSession(
  options: CaptureScreenshotOptions = {},
  sessionId?: string,
): Promise<ScreenshotAttachment> {
  assertScreenshotScale(options.scale);
  const full = options.full ?? false;
  // CSS-pixel sizing is the default and the only declarative scale mode.
  const dprExpression = 'window.devicePixelRatio';
  const dpr =
    Number(
      runtimeValue(
        (
          await browserCdp(
            'Runtime.evaluate',
            {
              expression: dprExpression,
              returnByValue: true,
            },
            sessionId,
          )
        ).result ?? {},
        dprExpression,
      ),
    ) || 1;
  const cssScale = 1 / dpr;
  let clip: Required<ScreenshotClip>;
  if (options.clip) {
    // An explicit `scale: undefined` keeps the CSS-pixel default too.
    clip = { ...options.clip, scale: options.clip.scale ?? cssScale };
  } else {
    const infoExpression =
      '({url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight})';
    const info = runtimeValue(
      (
        await browserCdp(
          'Runtime.evaluate',
          {
            expression: infoExpression,
            returnByValue: true,
          },
          sessionId,
        )
      ).result ?? {},
      infoExpression,
    );
    clip = {
      // CDP interprets clip coordinates in the page's document coordinate
      // space. A viewport screenshot therefore starts at the current scroll
      // offset, while a full-page screenshot still starts at the document
      // origin.
      x: full ? 0 : metric(info, 'sx'),
      y: full ? 0 : metric(info, 'sy'),
      width: full ? metric(info, 'pw') : metric(info, 'w'),
      height: full ? metric(info, 'ph') : metric(info, 'h'),
      scale: cssScale,
    };
  }
  // The output is `clip × scale × devicePixelRatio` pixels; shrink the scale so its long edge
  // fits the attachment limit. Rounding the factor down keeps Chromium's rounding within it.
  const longEdge = Math.max(clip.width, clip.height) * clip.scale * dpr;
  if (longEdge > MAX_SCREENSHOT_EDGE) {
    clip.scale *= Math.floor((MAX_SCREENSHOT_EDGE / longEdge) * 1e6) / 1e6;
  }
  const result = (
    await browserCdp(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: full, clip },
      sessionId,
    )
  ).result;
  const data = result?.data;
  if (typeof data !== 'string' || data.length === 0) {
    throw new Error('page.screenshot: Page.captureScreenshot returned no image data');
  }
  const size = pngSize(data) ?? {
    width: Math.round(clip.width * clip.scale * dpr),
    height: Math.round(clip.height * clip.scale * dpr),
  };
  const image = await invokeEgo('page.screenshot', () =>
    browserEgo().attachImage({ base64: data, mediaType: 'image/png', ...size }),
  );
  return { image, ...size };
}

function metric(info: unknown, key: string): number {
  const value = isRecord(info) ? info[key] : undefined;
  return typeof value === 'number' ? value : Number.NaN;
}

/** The width and height in a PNG's IHDR chunk, when `base64` holds a PNG. */
function pngSize(base64: string): { width: number; height: number } | undefined {
  let header: string;
  try {
    // 32 base64 characters are the first 24 bytes: signature, IHDR length and type, size.
    header = atob(base64.slice(0, 32));
  } catch {
    return undefined;
  }
  if (header.length < 24 || header.charCodeAt(0) !== 0x89 || header.slice(12, 16) !== 'IHDR') {
    return undefined;
  }
  const read = (offset: number) =>
    header.charCodeAt(offset) * 0x1000000 +
    header.charCodeAt(offset + 1) * 0x10000 +
    header.charCodeAt(offset + 2) * 0x100 +
    header.charCodeAt(offset + 3);
  return { width: read(16), height: read(20) };
}

function assertScreenshotScale(scale: unknown): asserts scale is ScreenshotScale | undefined {
  if (scale !== undefined && scale !== 'css') {
    throw new TypeError('captureScreenshot scale must be css');
  }
}
