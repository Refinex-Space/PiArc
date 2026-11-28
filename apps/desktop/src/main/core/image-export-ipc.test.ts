import { describe, expect, it } from 'vitest';

import { exportName, IMAGE_EXPORT_LIMIT, imageExport } from './image-export-ipc.js';

const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('image export requests', () => {
  it('takes an SVG or a PNG with a file name for the dialog', () => {
    expect(imageExport({ kind: 'svg', name: 'diagram', bytes: svg })).toEqual({
      kind: 'svg',
      name: 'diagram.svg',
      bytes: svg,
    });
    expect(imageExport({ kind: 'png', name: 'diagram', bytes: png }).name).toBe('diagram.png');
    const declared = new TextEncoder().encode('<?xml version="1.0"?>\n<!-- x --><svg/>');
    expect(imageExport({ kind: 'svg', name: 'd', bytes: declared }).kind).toBe('svg');
  });

  it('refuses bytes that are not what the request says, or too many', () => {
    expect(() => imageExport({ kind: 'png', name: 'd', bytes: svg })).toThrow(TypeError);
    expect(() => imageExport({ kind: 'svg', name: 'd', bytes: png })).toThrow(TypeError);
    const html = new TextEncoder().encode('<html><svg></svg></html>');
    expect(() => imageExport({ kind: 'svg', name: 'd', bytes: html })).toThrow(TypeError);
    const huge = new Uint8Array(IMAGE_EXPORT_LIMIT + 1);
    huge.set(png);
    expect(() => imageExport({ kind: 'png', name: 'd', bytes: huge })).toThrow(TypeError);
    expect(() => imageExport({ kind: 'gif', name: 'd', bytes: png })).toThrow(TypeError);
    expect(() => imageExport({ kind: 'png', name: 'd', bytes: [1, 2] })).toThrow(TypeError);
    expect(() => imageExport(null)).toThrow(TypeError);
  });

  it('keeps the name to one plain component with the kind as its extension', () => {
    expect(exportName('../../etc/passwd', 'svg')).toBe('-..-etc-passwd.svg');
    expect(exportName('a‮b.png', 'png')).toBe('a-b.png');
    expect(exportName('...', 'png')).toBe('image.png');
    expect(exportName('Flow.SVG', 'svg')).toBe('Flow.svg');
    expect(() => exportName('', 'svg')).toThrow(TypeError);
    expect(() => exportName('x'.repeat(121), 'svg')).toThrow(TypeError);
  });
});
