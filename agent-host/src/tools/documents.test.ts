import { describe, expect, it } from 'vitest';

import { formatNotebook, formatPdf } from './documents.js';

describe('documents', () => {
  it('formats PDF pages with their numbers and marks empty pages', () => {
    const text = formatPdf('report.pdf', {
      path: '/w/report.pdf',
      pageCount: 12,
      pages: [
        { number: 2, text: 'Second page' },
        { number: 3, text: '  ' },
      ],
    });
    expect(text).toBe(
      'PDF report.pdf: 12 pages; pages 2-3 below.\n\n--- Page 2 ---\nSecond page\n\n' +
        '--- Page 3 ---\n(no text on this page)',
    );
  });

  it('renders notebook cells with source and output summaries', () => {
    const notebook = {
      metadata: { language_info: { name: 'python' } },
      cells: [
        { cell_type: 'markdown', id: 'intro', source: ['# Title\n', 'Text'] },
        {
          cell_type: 'code',
          execution_count: 3,
          source: 'print(1)\n1/0',
          outputs: [
            { output_type: 'stream', name: 'stdout', text: ['1\n'] },
            { output_type: 'error', ename: 'ZeroDivisionError', evalue: 'division by zero' },
            {
              output_type: 'display_data',
              data: { 'image/png': 'iVBOR…', 'text/plain': '<Figure>' },
            },
          ],
        },
      ],
    };
    expect(formatNotebook('nb.ipynb', JSON.stringify(notebook))).toBe(
      [
        'Notebook nb.ipynb: 2 cells, language python.',
        '[cell 1 id=intro: markdown]\n# Title\nText',
        '[cell 2: code, run 3]\nprint(1)\n1/0\n[outputs]\n1\nZeroDivisionError: division by zero\n' +
          '<Figure>\n[image/png output not shown]',
      ].join('\n\n'),
    );
  });

  it('shortens long outputs and rejects files that are not notebooks', () => {
    const long = {
      cells: [
        {
          cell_type: 'code',
          source: '',
          outputs: [{ output_type: 'stream', text: 'x'.repeat(5000) }],
        },
      ],
    };
    expect(formatNotebook('nb.ipynb', JSON.stringify(long))).toContain('… [3000 more characters]');
    expect(() => formatNotebook('nb.ipynb', '{oops')).toThrow(/not a valid notebook/);
    expect(() => formatNotebook('nb.ipynb', '{}')).toThrow(/no cells/);
  });
});
