import { describe, expect, it } from 'vitest';

import { parseSearch, snippetRuns } from './MessageSearch.js';

describe('message search results', () => {
  it('keep valid results and ranges only', () => {
    const results = parseSearch(
      JSON.stringify({
        results: [
          {
            sessionId: 's1',
            title: '修复登录',
            total: 3,
            hits: [
              {
                entryId: 'e1',
                role: 'user',
                snippet: '修复登录页面',
                highlights: [
                  [2, 4],
                  [5, 99],
                  [3, 1],
                ],
              },
              { role: 'assistant', snippet: 'ok', highlights: 'x' },
              { snippet: 1 },
            ],
          },
          { title: 'no id', hits: [] },
        ],
      }),
    );
    expect(results).toEqual([
      {
        sessionId: 's1',
        title: '修复登录',
        total: 3,
        hits: [
          { entryId: 'e1', role: 'user', snippet: '修复登录页面', highlights: [[2, 4]] },
          { entryId: undefined, role: 'assistant', snippet: 'ok', highlights: [] },
        ],
      },
    ]);
  });

  it('split a snippet into marked and plain runs', () => {
    expect(
      snippetRuns({
        entryId: 'e',
        role: 'assistant',
        snippet: 'Fix the 登录 bug in auth',
        highlights: [
          [11, 14],
          [8, 10],
        ],
      }),
    ).toEqual([
      { text: 'Fix the ', marked: false },
      { text: '登录', marked: true },
      { text: ' ', marked: false },
      { text: 'bug', marked: true },
      { text: ' in auth', marked: false },
    ]);
  });
});
