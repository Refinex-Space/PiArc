import { describe, expect, it } from 'vitest';

import { blocksText } from './copy.js';
import { parseMarkdown } from './markdown/incremental.js';

describe('blocksText', () => {
  it('drops Markdown syntax and keeps the structure readable', () => {
    const markdown = [
      '## Title',
      '',
      'Some **bold**, _em_ and `code` with [a link](https://example.com/x).',
      '',
      '- one',
      '- two',
      '',
      '3. three',
      '4. four',
      '',
      '- [x] done',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      '> quoted',
      '',
      '<b>raw</b>',
    ].join('\n');
    expect(blocksText(parseMarkdown(markdown))).toBe(
      [
        'Title',
        '',
        'Some bold, em and code with a link (https://example.com/x).',
        '',
        '• one\n• two',
        '',
        '3. three\n4. four',
        '',
        '[x] done',
        '',
        'a\tb\n1\t2',
        '',
        'const x = 1;',
        '',
        'quoted',
        '',
        '<b>raw</b>',
      ].join('\n'),
    );
  });

  it('indents the continuation lines of list items', () => {
    expect(blocksText(parseMarkdown('- first\n  line two\n- second'))).toBe(
      '• first\n  line two\n• second',
    );
  });
});
