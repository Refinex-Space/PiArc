// The picker, screenshot and clipboard requests of the preview panel (B3.1, B3.4).
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

const { parseBrowserRequest } = await import('./browser-ipc.js');

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==';

describe('picker and screenshot requests', () => {
  it.each([
    [{ op: 'pick', tab: 'tab-1', mode: 'collect' }],
    [{ op: 'pick', tab: 'tab-2', mode: 'shot' }],
    [{ op: 'pick', tab: 'tab-2', mode: 'off' }],
    [{ op: 'capture', tab: 'tab-3', kind: 'visible' }],
    [{ op: 'capture', tab: 'tab-3', kind: 'full' }],
    [{ op: 'copyImage', image: PNG }],
  ])('accepts %j', (request) => {
    expect(parseBrowserRequest(request)).toEqual(request);
  });

  it('drops unknown fields', () => {
    expect(parseBrowserRequest({ op: 'pick', tab: 'tab-1', mode: 'collect', x: 1 })).toEqual({
      op: 'pick',
      tab: 'tab-1',
      mode: 'collect',
    });
  });

  it.each([
    [{ op: 'pick', tab: 'tab-1' }],
    [{ op: 'pick', tab: 'tab-1', mode: 'all' }],
    [{ op: 'pick', tab: 'page-1', mode: 'collect' }],
    [{ op: 'capture', tab: 'tab-1', kind: 'region' }],
    [{ op: 'capture', kind: 'visible' }],
    [{ op: 'copyImage' }],
    [{ op: 'copyImage', image: 'data:image/svg+xml;base64,PHN2Zy8+' }],
    [{ op: 'copyImage', image: 'data:image/png;base64,<script>' }],
    [{ op: 'copyImage', image: `data:image/png;base64,${'A'.repeat(25 * 1024 * 1024)}` }],
  ])('THR-11 rejects %j', (request) => {
    expect(() => parseBrowserRequest(request)).toThrow(TypeError);
  });
});
