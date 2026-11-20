import { describe, expect, it } from 'vitest';

import type { TranscriptRow } from '../store/transcript.js';
import { chooseDetail, DEFAULT_DETAIL, detailOf, shownIn } from './detail.js';

const item = (type: string, extra: object = {}) =>
  ({
    kind: 'item',
    id: type,
    item: { itemId: type, type, status: 'completed', ...extra },
  }) as unknown as TranscriptRow;

describe('transcript views (T29)', () => {
  it('normal hides thinking and reminders, thinking adds thinking, detailed shows everything', () => {
    const cases: [string, boolean, boolean, boolean][] = [
      ['agentMessage', true, true, true],
      ['commandExecution', true, true, true],
      ['reasoning', false, true, true],
      ['reminder', false, false, true],
    ];
    const reminders = { reminders: [{ type: 'backgroundTask', source: 'bg-0a1b2c3d4e5f' }] };
    for (const [type, normal, thinking, detailed] of cases) {
      const row = item(type, type === 'reminder' ? reminders : {});
      expect([shownIn(row, 'normal'), shownIn(row, 'thinking'), shownIn(row, 'detailed')]).toEqual([
        normal,
        thinking,
        detailed,
      ]);
    }
    // T32: a Monitor's output shows in every view.
    const monitor = item('reminder', {
      reminders: [{ type: 'monitorOutput', source: 'bg-0a1b2c3d4e5f@3' }],
    });
    expect([shownIn(monitor, 'normal'), shownIn(monitor, 'detailed')]).toEqual([true, true]);
    expect(shownIn(undefined, 'normal')).toBe(true);
  });

  it('remembers the choice per session', () => {
    expect(detailOf('a')).toBe(DEFAULT_DETAIL);
    chooseDetail('a', 'detailed');
    expect(detailOf('a')).toBe('detailed');
    expect(detailOf('b')).toBe(DEFAULT_DETAIL);
  });
});
