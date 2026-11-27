import { describe, expect, it } from 'vitest';

import { AhpError } from '../protocol/errors.js';
import { REMIND_TYPES, formatRemind, isRemindType } from './core-reminders.js';

describe('reminders Core pushes', () => {
  it('accepts only the types Core sends through session/remind', () => {
    expect(REMIND_TYPES).toEqual([
      'backgroundTask',
      'monitorOutput',
      'browserVerify',
      'browserState',
    ]);
    expect(isRemindType('browserVerify')).toBe(true);
    expect(isRemindType('hookContext')).toBe(false);
    expect(isRemindType('todoStale')).toBe(false);
    expect(isRemindType(undefined)).toBe(false);
  });

  it('keeps keyed task texts and frames bare task notices', () => {
    expect(formatRemind('monitorOutput', 'bg-1', 'line', true)).toBe('line');
    expect(formatRemind('backgroundTask', 'bg-1', 'done', false)).toBe(
      'Background task bg-1:\ndone',
    );
  });

  it('words browserVerify from the address and the changed files', () => {
    const text = formatRemind(
      'browserVerify',
      'devServer:web:1',
      'http://localhost:5173/\nsrc/App.tsx\n',
      true,
    );
    expect(text).toContain('You changed src/App.tsx');
    expect(text).toContain('at http://localhost:5173/.');
    expect(text).toContain('Browser tool');
    expect(text.split('\n')).toHaveLength(2);
    const bare = formatRemind('browserVerify', 'devServer:web:2', '', true);
    expect(bare).toContain('You changed front-end files, which');
    expect(bare).not.toContain(' at .');
  });

  it('formats a browserState summary inside its own boundary (B2.7.3)', () => {
    const text = formatRemind(
      'browserState',
      'browser:1',
      JSON.stringify({
        spaces: [{ id: 2, name: 'shop', controlledBy: 'user', tabCount: 1 }],
        userTabs: 0,
      }),
      true,
    );
    expect(text).toMatch(/^The browser changed since your last Browser call\./u);
    expect(text).toMatch(/<browser-state-[0-9a-f]{12}>/u);
    expect(text).toContain('Task space 2 "shop": the user controls it now (1 tab)');
  });

  it('refuses a browserState reminder without a summary', () => {
    expect(() => formatRemind('browserState', 'browser:1', 'free text', true)).toThrow(AhpError);
  });
});
