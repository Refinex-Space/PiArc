import { describe, expect, it } from 'vitest';

import {
  captureFullPage,
  captureVisible,
  FULL_PAGE_EDGE,
  fullPageScale,
  pngSize,
} from './capture.js';
import type { CdpSend } from './snapshot.js';

const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==';

describe('screenshots', () => {
  it('reads the size from a PNG header and refuses other bytes', () => {
    expect(pngSize(Buffer.from(PIXEL, 'base64'))).toEqual({ width: 1, height: 1 });
    expect(pngSize(Buffer.from('GIF89a........................'))).toBeUndefined();
  });

  it('scales a long page to the edge limit', () => {
    expect(fullPageScale(1280, 4000, 1)).toBe(1);
    expect(fullPageScale(1280, 20_000, 1)).toBeCloseTo(FULL_PAGE_EDGE / 20_000);
    expect(fullPageScale(1000, 5000, 2)).toBeCloseTo(FULL_PAGE_EDGE / 10_000);
  });

  it('captures the visible part and the whole page through CDP', async () => {
    const calls: [string, unknown][] = [];
    const send: CdpSend = (method, params) => {
      calls.push([method, params]);
      if (method === 'Page.getLayoutMetrics') {
        return Promise.resolve({
          cssContentSize: { width: 800, height: 3000.5 },
          cssVisualViewport: { pageX: 0, pageY: 120 },
        });
      }
      return Promise.resolve({ data: PIXEL });
    };
    expect(await captureVisible(send)).toEqual({
      data: `data:image/png;base64,${PIXEL}`,
      width: 1,
      height: 1,
    });
    await captureFullPage(send, 2);
    expect(calls.at(-1)).toEqual([
      'Page.captureScreenshot',
      {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: 800, height: 3001, scale: 1 },
      },
    ]);
  });

  it('fails when the page gives no PNG', async () => {
    await expect(captureVisible(() => Promise.resolve({ data: 'AAAA' }))).rejects.toThrow(
      /browserCapture/u,
    );
  });
});
