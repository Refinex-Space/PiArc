import { describe, expect, it } from 'vitest';

import type { TranscriptRow } from '../store/transcript.js';
import { chooseDetail, DEFAULT_DETAIL, detailOf, shownIn } from './detail.js';

const item = (type: string) =>
  ({
    kind: 'item',
    id: type,
    item: { itemId: type, type, status: 'completed' },
  }) as unknown as TranscriptRow;

describe('transcript views (T29)', () => {
  it('normal hides thinking and reminders, thinking adds thinking, detailed shows everything', () => {
    const cases: [string, boolean, boolean, boolean][] = [
      ['agentMessage', true, true, true],
      ['commandExecution', true, true, true],
      ['reasoning', false, true, true],
      ['reminder', false, false, true],
    ];
    for (const [type, normal, thinking, detailed] of cases) {
      expect([
        shownIn(item(type), 'normal'),
        shownIn(item(type), 'thinking'),
        shownIn(item(type), 'detailed'),
      ]).toEqual([normal, thinking, detailed]);
    }
    expect(shownIn(undefined, 'normal')).toBe(true);
  });

  it('remembers the choice per session', () => {
    expect(detailOf('a')).toBe(DEFAULT_DETAIL);
    chooseDetail('a', 'detailed');
    expect(detailOf('a')).toBe('detailed');
    expect(detailOf('b')).toBe(DEFAULT_DETAIL);
  });
});
