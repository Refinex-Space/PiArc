import { describe, expect, it } from 'vitest';

import { SessionTranscript } from '../store/transcript.js';
import { blocksText, loadExchange } from './copy.js';
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

it('selects across history pages until the preceding turn is reached', async () => {
  const transcript = new SessionTranscript();
  const entry = (id: string, turnId: string, type: 'userMessage' | 'agentMessage') => ({
    entryId: id,
    turnId,
    item: { type, itemId: id, status: 'completed', text: id },
  });
  const earlier = [
    [entry('previous', 't0', 'agentMessage'), entry('prompt', 't1', 'userMessage')],
    [entry('steer', 't1', 'userMessage')],
  ];
  transcript.load([entry('reply', 't1', 'agentMessage'), entry('next', 't2', 'userMessage')], 3);
  const selected = await loadExchange(
    transcript,
    'reply',
    () => {
      const page = earlier.pop();
      if (page === undefined) throw new Error('No more pages');
      transcript.prepend(page, (transcript.historyStart() ?? 0) - page.length);
      return Promise.resolve();
    },
    new AbortController().signal,
  );
  expect(selected).toEqual(['prompt', 'steer', 'reply']);
});
