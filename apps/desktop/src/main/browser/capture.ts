// Screenshots of a tab for the panel (design addendum B3.3, B3.4): the visible viewport, the
// whole page and an element's clip, as PNG through CDP `Page.captureScreenshot` (it works while
// the view is hidden, which `capturePage` does not). The panel cuts a region out of the visible
// one itself.

import type { BrowserImage } from '../../shared/browser.js';
import type { CdpSend } from './snapshot.js';

/** The longest edge of a full-page screenshot, in pixels. */
export const FULL_PAGE_EDGE = 8192;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The width and height in a PNG's header, or `undefined` when `bytes` is not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((byte, index) => bytes[index] !== byte)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** A captured PNG (`Page.captureScreenshot` answer) as a data URL with its size. */
function image(answer: unknown): BrowserImage {
  const data = isRecord(answer) && typeof answer.data === 'string' ? answer.data : '';
  const size = pngSize(Buffer.from(data, 'base64'));
  if (size === undefined) throw new Error('[piarc:browserCapture] The page gave no image');
  return { data: `data:image/png;base64,${data}`, ...size };
}

/** The page's size and scroll position in CSS pixels (`Page.getLayoutMetrics`). */
export async function layoutMetrics(send: CdpSend): Promise<{
  readonly content: { width: number; height: number };
  readonly scroll: { x: number; y: number };
}> {
  const answer = await send('Page.getLayoutMetrics');
  const content = isRecord(answer) && isRecord(answer.cssContentSize) ? answer.cssContentSize : {};
  const visual =
    isRecord(answer) && isRecord(answer.cssVisualViewport) ? answer.cssVisualViewport : {};
  const number = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  return {
    content: { width: number(content.width), height: number(content.height) },
    scroll: { x: number(visual.pageX), y: number(visual.pageY) },
  };
}

/** The visible part of the page. */
export async function captureVisible(send: CdpSend): Promise<BrowserImage> {
  return image(await send('Page.captureScreenshot', { format: 'png' }));
}

/** The scale that keeps a `width` × `height` CSS-pixel page within `FULL_PAGE_EDGE` pixels. */
export function fullPageScale(width: number, height: number, dpr: number): number {
  const longest = Math.max(width, height) * Math.max(dpr, 0.25);
  return longest <= FULL_PAGE_EDGE ? 1 : FULL_PAGE_EDGE / longest;
}

/** The whole page, scaled down when it is longer than `FULL_PAGE_EDGE` pixels. */
export async function captureFullPage(send: CdpSend, dpr: number): Promise<BrowserImage> {
  const { content } = await layoutMetrics(send);
  if (content.width < 1 || content.height < 1) return captureVisible(send);
  const width = Math.ceil(content.width);
  const height = Math.ceil(content.height);
  return image(
    await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: fullPageScale(width, height, dpr) },
    }),
  );
}

/** A clip of the page in page coordinates (CSS pixels). */
export async function captureClip(
  send: CdpSend,
  clip: { x: number; y: number; width: number; height: number; scale: number },
): Promise<BrowserImage> {
  return image(
    await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip }),
  );
}
