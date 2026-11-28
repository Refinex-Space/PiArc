import os from 'node:os';
import path from 'node:path';

import type { BlobRef, FsPdfResult, InputAttachment } from '@piarc/protocol';
import { describe, expect, it } from 'vitest';

import {
  composedText,
  inputRecord,
  MAX_PDF_PAGES,
  parseInputRecord,
  pdfSection,
  plainInput,
  prepareInput,
  withText,
} from './input.js';

const blob = (name: string, size: number): BlobRef => ({
  path: path.join(os.homedir(), 'data', 'sessions', 's1', 'attachments', name),
  sha256: 'a'.repeat(64),
  size,
});

const image: InputAttachment = {
  kind: 'image',
  name: '截图 1.png',
  mimeType: 'image/png',
  blob: blob('a.png', 3),
};

const pdf = (pageCount: number): InputAttachment => ({
  kind: 'pdf',
  name: 'spec "v2".pdf',
  mimeType: 'application/pdf',
  blob: blob('b.pdf', 10),
  pageCount,
});

function pages(count: number, shown: number): FsPdfResult {
  return {
    path: '/ignored',
    pageCount: count,
    pages: Array.from({ length: shown }, (_, i) => ({
      number: i + 1,
      text: `page ${String(i + 1)}`,
    })),
  };
}

describe('prepareInput', () => {
  it('turns images into image content and PDFs into their pages after the text', async () => {
    const asked: string[] = [];
    const prepared = await prepareInput(
      {
        text: 'Look @a.ts',
        mentions: [{ path: 'a.ts', start: 5, end: 10 }],
        attachments: [image, pdf(2)],
      },
      {
        readBlob: (ref) => Promise.resolve(Buffer.from(ref.path.endsWith('.png') ? 'png' : '')),
        pdf: (file, range) => {
          asked.push(`${path.basename(file)} ${range}`);
          return Promise.resolve(pages(2, 2));
        },
      },
    );
    expect(prepared.images).toEqual([
      { type: 'image', data: Buffer.from('png').toString('base64'), mimeType: 'image/png' },
    ]);
    expect(asked).toEqual(['b.pdf 1-2']);
    const text = composedText(prepared);
    expect(text.startsWith('Look @a.ts\n\n<attachment name="spec &quot;v2&quot;.pdf"')).toBe(true);
    expect(text).toContain('path="~/data/sessions/s1/attachments/b.pdf"');
    expect(text).toContain('[Page 1]\npage 1');
    expect(text).not.toContain('not included');
    expect(inputRecord(prepared)?.attachments).toHaveLength(2);
  });

  it('reads at most the first pages of a long PDF and says where the rest is', async () => {
    let range = '';
    const prepared = await prepareInput(
      { text: 'Summarize', mentions: [], attachments: [pdf(45)] },
      {
        readBlob: () => Promise.reject(new Error('no images here')),
        pdf: (_file, asked) => {
          range = asked;
          return Promise.resolve(pages(45, MAX_PDF_PAGES));
        },
      },
    );
    expect(range).toBe(`1-${String(MAX_PDF_PAGES)}`);
    expect(composedText(prepared)).toContain(
      `Pages ${String(MAX_PDF_PAGES + 1)}-45 are not included above.`,
    );
  });

  it('keeps plain text without a record and drops mentions when the text is edited', () => {
    const plain = plainInput('hello');
    expect(composedText(plain)).toBe('hello');
    expect(inputRecord(plain)).toBeUndefined();
    const edited = withText(
      {
        ...plain,
        input: { text: '@a', mentions: [{ path: 'a', start: 0, end: 2 }], attachments: [image] },
      },
      'new text',
    );
    expect(edited.input).toEqual({ text: 'new text', mentions: [], attachments: [image] });
  });
});

describe('pdfSection', () => {
  it('marks a page without text', () => {
    const section = pdfSection(pdf(1), {
      path: '/x',
      pageCount: 1,
      pages: [{ number: 1, text: '' }],
    });
    expect(section).toContain('[Page 1]\n(no text)');
    expect(section.endsWith('</attachment>')).toBe(true);
  });
});

describe('parseInputRecord', () => {
  it('reads a record and skips malformed members', () => {
    expect(
      parseInputRecord({
        text: 'x',
        mentions: [{ path: 'a', start: 0, end: 1 }, { path: 'b', start: 3, end: 1 }, 'junk'],
        attachments: [image, { ...image, kind: 'video' }, { name: 'n' }],
      }),
    ).toEqual({ text: 'x', mentions: [{ path: 'a', start: 0, end: 1 }], attachments: [image] });
    expect(parseInputRecord({ mentions: [] })).toBeUndefined();
    expect(parseInputRecord('text')).toBeUndefined();
  });
});
