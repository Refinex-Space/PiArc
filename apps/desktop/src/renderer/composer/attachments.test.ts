import { describe, expect, it } from 'vitest';

import { checkFiles, mimeTypeOf, parseComposerInfo, type AttachmentLimits } from './attachments.js';

const LIMITS: AttachmentLimits = {
  maxCount: 2,
  kinds: [
    {
      kind: 'image',
      mimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
      maxBytes: 100,
    },
    { kind: 'pdf', mimeTypes: ['application/pdf'], maxBytes: 1000 },
  ],
};

function file(name: string, size: number, type = ''): Blob & { name: string } {
  return Object.assign(new Blob([new Uint8Array(size)], { type }), { name });
}

describe('attachment checks', () => {
  it('infers the type from the extension when the browser gives none', () => {
    expect(mimeTypeOf({ name: 'Shot.PNG', type: '', size: 1 })).toBe('image/png');
    expect(mimeTypeOf({ name: 'a.pdf', type: 'application/pdf', size: 1 })).toBe('application/pdf');
    expect(mimeTypeOf({ name: 'notes', type: '', size: 1 })).toBe('application/octet-stream');
  });

  it('accepts the supported kinds within their limits and says why others are refused', () => {
    let next = 0;
    const id = () => String((next += 1));
    const { accepted, problems } = checkFiles(
      [
        file('a.png', 10),
        file('b.svg', 10, 'image/svg+xml'),
        file('big.png', 101),
        file('c.pdf', 999),
      ],
      0,
      LIMITS,
      id,
    );
    expect(accepted.map((a) => [a.name, a.kind, a.mimeType])).toEqual([
      ['a.png', 'image', 'image/png'],
      ['c.pdf', 'pdf', 'application/pdf'],
    ]);
    expect(problems).toEqual([
      { reason: 'type', name: 'b.svg' },
      { reason: 'size', name: 'big.png', maxBytes: 100 },
    ]);
    const full = checkFiles([file('d.png', 1)], 2, LIMITS, id);
    expect(full).toEqual({ accepted: [], problems: [{ reason: 'count', maxCount: 2 }] });
  });

  it('reads Core’s composer info and tolerates malformed parts', () => {
    const info = parseComposerInfo(
      JSON.stringify({
        attachments: {
          maxCount: 10,
          kinds: [{ kind: 'pdf', mimeTypes: ['application/pdf'], maxBytes: 5 }],
        },
        fileSearch: { maxResults: 50 },
      }),
    );
    expect(info.limits).toEqual({
      maxCount: 10,
      kinds: [{ kind: 'pdf', mimeTypes: ['application/pdf'], maxBytes: 5 }],
    });
    expect(info.maxSearchResults).toBe(50);
    expect(parseComposerInfo('not json').maxSearchResults).toBe(20);
  });
});

it('refuses images for text-only models while accepting PDF extraction', () => {
  const { accepted, problems } = checkFiles(
    [file('x.png', 8), file('y.pdf', 12)],
    0,
    LIMITS,
    () => 'attachment',
    false,
  );
  expect(accepted.map((a) => a.name)).toEqual(['y.pdf']);
  expect(problems).toEqual([{ reason: 'vision', name: 'x.png' }]);
});
