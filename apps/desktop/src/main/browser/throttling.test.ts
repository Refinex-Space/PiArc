import { describe, expect, it } from 'vitest';

import { applyThrottling, throttledWhenHidden } from './throttling.js';
import { SEARCH_ENGINES } from './address.js';
import { BROWSER_SEARCH_ENGINES } from '../../shared/preferences.js';

describe('background throttling (B5.6)', () => {
  it('throttles hidden pages except an agent Space while its call runs', () => {
    expect(throttledWhenHidden({ kind: 'user', running: false })).toBe(true);
    expect(throttledWhenHidden({ kind: 'user', running: true })).toBe(true);
    expect(throttledWhenHidden({ kind: 'agent', running: false })).toBe(true);
    expect(throttledWhenHidden({ kind: 'agent', running: true })).toBe(false);
    expect(throttledWhenHidden(undefined)).toBe(true);
  });

  it('applies the rule per tab', () => {
    const set: [string, boolean][] = [];
    applyThrottling(
      [
        { id: 'a', space: 'user' },
        { id: 'b', space: 'agent-1' },
        { id: 'c', space: 'gone' },
      ],
      [
        { id: 'user', kind: 'user', running: false },
        { id: 'agent-1', kind: 'agent', running: true },
      ],
      (tab, throttled) => set.push([tab.id, throttled]),
    );
    expect(set).toEqual([
      ['a', true],
      ['b', false],
      ['c', true],
    ]);
  });
});

describe('browser settings', () => {
  it('offers the search engines the address bar knows', () => {
    expect([...BROWSER_SEARCH_ENGINES]).toEqual([...SEARCH_ENGINES]);
  });
});
