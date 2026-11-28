import { describe, expect, it } from 'vitest';

import { fuzzyFilter, fuzzyMatch } from './fuzzy.js';

describe('fuzzyMatch', () => {
  it('matches characters in order, ignoring case', () => {
    expect(fuzzyMatch('cmp', 'compact')?.positions).toEqual([0, 2, 3]);
    expect(fuzzyMatch('OS', 'output-style')?.positions).toEqual([0, 7]);
    expect(fuzzyMatch('xz', 'compact')).toBeUndefined();
    expect(fuzzyMatch('', 'anything')?.score).toBe(0);
  });

  it('prefers word starts and runs', () => {
    const style = fuzzyMatch('st', 'output-style');
    expect(style?.positions).toEqual([7, 8]);
    const component = fuzzyMatch('fc', 'frontend:component');
    expect(component?.positions).toEqual([0, 9]);
    // A match at a word start beats a scattered one.
    const a = fuzzyMatch('rw', 'rewind')?.score ?? 0;
    const b = fuzzyMatch('rw', 'review-work')?.score ?? 0;
    expect(b).toBeGreaterThan(a);
  });

  it('handles non-ASCII text', () => {
    expect(fuzzyMatch('新会', '新建会话')?.positions).toEqual([0, 2]);
  });
});

describe('fuzzyFilter', () => {
  const commands = [
    { name: 'compact', description: 'Free up context' },
    { name: 'context', description: 'Show the context usage' },
    { name: 'clear', description: 'Start a new conversation' },
    { name: 'frontend:component', description: 'Make a component' },
  ];

  it('ranks by score, names over descriptions', () => {
    const names = (query: string): string[] =>
      fuzzyFilter(commands, query, (c) => [c.name, c.description]).map((c) => c.name);
    expect(names('com')).toEqual(['compact', 'frontend:component']);
    expect(names('ctx')).toEqual(['context', 'compact']);
    expect(names('conversation')).toEqual(['clear']);
    expect(names('')).toEqual(['compact', 'context', 'clear', 'frontend:component']);
  });
});
