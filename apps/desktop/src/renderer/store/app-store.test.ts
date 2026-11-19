import { describe, expect, it } from 'vitest';

import { AppStore } from './app-store.js';

describe('notices', () => {
  it('shows one notice per type and one per hook notice id', () => {
    const store = new AppStore();
    store.applyNotice({ type: 'gitBashMissing', message: 'missing' });
    store.applyNotice({ type: 'gitBashMissing', message: 'again' });
    store.applyNotice({
      type: 'hook',
      id: 'a',
      sessionId: 's',
      event: 'PreToolUse',
      level: 'error',
      message: 'exited with code 1: lint failed',
    });
    store.applyNotice({
      type: 'hook',
      id: 'b',
      event: 'Stop',
      level: 'message',
      message: 'Saved.',
    });
    store.applyNotice({
      type: 'hook',
      id: 'b',
      event: 'Stop',
      level: 'message',
      message: 'Saved.',
    });
    expect(store.notices().map((n) => [n.key, n.hook])).toEqual([
      ['gitBashMissing', undefined],
      ['hook:a', { event: 'PreToolUse', error: true }],
      ['hook:b', { event: 'Stop', error: false }],
    ]);
    store.dismissNotice('hook:a');
    expect(store.notices().map((n) => n.key)).toEqual(['gitBashMissing', 'hook:b']);
  });

  it('keeps the five newest hook notices', () => {
    const store = new AppStore();
    store.applyNotice({ type: 'gitBashMissing', message: 'missing' });
    for (let n = 0; n < 7; n += 1) {
      store.applyNotice({ type: 'hook', id: String(n), event: 'Stop', message: `m${String(n)}` });
    }
    expect(store.notices().map((n) => n.key)).toEqual([
      'gitBashMissing',
      'hook:2',
      'hook:3',
      'hook:4',
      'hook:5',
      'hook:6',
    ]);
  });
});
