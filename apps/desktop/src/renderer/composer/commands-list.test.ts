import { describe, expect, it } from 'vitest';

import { parseCommandsList } from './commands-list.js';
import { typedBuiltin } from './builtins.js';

describe('parseCommandsList', () => {
  it('keeps well-formed commands and styles', () => {
    const list = parseCommandsList(
      JSON.stringify({
        commands: [
          { name: 'clear', kind: 'builtIn', source: 'builtIn', aliases: ['reset', 3] },
          {
            name: 'review',
            kind: 'command',
            source: 'projectClaude',
            description: 'Review',
            argumentHint: '[file]',
          },
          { kind: 'skill' },
        ],
        outputStyles: [{ name: 'Default', source: 'builtIn' }, { name: 7 }],
        outputStyle: { name: 'teacher' },
      }),
    );
    expect(list.commands).toEqual([
      { name: 'clear', kind: 'builtIn', source: 'builtIn', description: '', aliases: ['reset'] },
      {
        name: 'review',
        kind: 'command',
        source: 'projectClaude',
        description: 'Review',
        argumentHint: '[file]',
      },
    ]);
    expect(list.styles).toEqual([{ name: 'Default', source: 'builtIn', description: '' }]);
    expect(list.style).toBe('teacher');
    expect(parseCommandsList('nope').commands).toEqual([]);
  });
});

describe('typedBuiltin', () => {
  it('recognizes built-in commands and aliases at the start only', () => {
    expect(typedBuiltin('/output-style  teacher ')).toEqual({
      name: 'output-style',
      action: 'outputStyle',
      args: 'teacher',
    });
    expect(typedBuiltin('/reset')).toEqual({ name: 'clear', action: 'newSession', args: '' });
    expect(typedBuiltin('  /model')).toMatchObject({ action: 'model' });
    expect(typedBuiltin('/review src')).toBeUndefined();
    expect(typedBuiltin('please /clear')).toBeUndefined();
  });
});
