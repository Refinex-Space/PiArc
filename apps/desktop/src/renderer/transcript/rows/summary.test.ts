import type { Item } from '@piarc/protocol';
import { describe, expect, it } from 'vitest';

import { summarize, targetOf, verbOf } from './summary.js';

const read = (id: string, path: string, status: Item['status'] = 'completed'): Item => ({
  type: 'dynamicToolCall',
  itemId: id,
  status,
  tool: 'Read',
  arguments: { path },
});

const edit = (id: string, added: number, removed: number): Item => ({
  type: 'fileChange',
  itemId: id,
  status: 'completed',
  tool: 'Edit',
  arguments: {},
  path: 'src/a b/中文.ts',
  diff: { path: 'src/a b/中文.ts', added, removed, unified: '', hunks: [] },
});

describe('tool summaries', () => {
  it('names the object of a single call and counts the rest by verb', () => {
    expect(summarize([read('1', 'src/main.ts')]).parts).toEqual([
      { verb: 'read', count: 1, target: 'main.ts' },
    ]);
    const summary = summarize([
      read('1', 'a.ts'),
      read('2', 'b.ts'),
      {
        type: 'dynamicToolCall',
        itemId: '3',
        status: 'failed',
        tool: 'Grep',
        arguments: { pattern: 'TODO' },
      },
      edit('4', 3, 1),
      edit('5', 10, 0),
    ]);
    // Two edits of one file are one edited file; their lines still add up.
    expect(summary.parts).toEqual([
      { verb: 'read', count: 2, target: undefined },
      { verb: 'search', count: 1, target: 'TODO' },
      { verb: 'edit', count: 1, target: '中文.ts' },
    ]);
    expect([summary.added, summary.removed, summary.status]).toEqual([13, 1, 'failed']);
    // Reading the same file twice is reading one file.
    expect(summarize([read('1', 'a.ts'), read('2', 'a.ts')]).parts).toEqual([
      { verb: 'read', count: 1, target: 'a.ts' },
    ]);
  });

  it('counts commands and web searches, and leaves thinking out (ADR-0079)', () => {
    const summary = summarize([
      { type: 'reasoning', itemId: 't', status: 'completed', text: 'hmm' },
      {
        type: 'commandExecution',
        itemId: 'c1',
        status: 'completed',
        tool: 'Bash',
        arguments: {},
        command: 'npm test\nnpm run lint',
      },
      {
        type: 'webSearch',
        itemId: 'w1',
        status: 'completed',
        tool: 'WebSearch',
        arguments: {},
        query: 'vite 7 release',
      },
    ] as Item[]);
    expect(summary.parts).toEqual([
      { verb: 'command', count: 1, target: 'npm test' },
      { verb: 'web', count: 1, target: 'vite 7 release' },
    ]);
  });

  it('says what Memory calls did, merging repeated ones (T47)', () => {
    const memory = (id: string, args: Record<string, string>): Item => ({
      type: 'dynamicToolCall',
      itemId: id,
      status: 'completed',
      tool: 'Memory',
      arguments: args,
    });
    expect(
      summarize([
        memory('1', { action: 'save', name: 'build' }),
        memory('2', { action: 'read', name: ' style ' }),
        memory('3', { action: 'read' }),
        memory('4', { action: 'delete', name: 'old' }),
      ]).parts,
    ).toEqual([
      { verb: 'memorySave', count: 1, target: 'build' },
      { verb: 'memoryRead', count: 1, target: 'style' },
      { verb: 'memoryIndex', count: 1, target: 'Memory' },
      { verb: 'memoryDelete', count: 1, target: 'old' },
    ]);
    expect(
      summarize([
        memory('1', { action: 'save', name: 'a' }),
        memory('2', { action: 'save', name: 'b' }),
      ]).parts,
    ).toEqual([{ verb: 'memorySave', count: 2, target: undefined }]);
  });

  it('reports a group in progress while one call runs', () => {
    expect(summarize([read('1', 'a'), read('2', 'b', 'inProgress')]).status).toBe('inProgress');
  });

  it('labels other kinds of calls', () => {
    const fetch: Item = {
      type: 'webFetch',
      itemId: 'f',
      status: 'completed',
      tool: 'WebFetch',
      arguments: {},
      url: 'https://example.com/docs?a=1',
    };
    expect([verbOf(fetch), targetOf(fetch)]).toEqual(['fetch', 'example.com']);
    const mcp: Item = {
      type: 'mcpToolCall',
      itemId: 'm',
      status: 'completed',
      tool: 'mcp__github__search',
      arguments: {},
      server: 'github',
      serverTool: 'search',
    };
    expect([verbOf(mcp), targetOf(mcp)]).toEqual(['mcp', 'github · search']);
  });
});
