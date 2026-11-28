import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { STATE_REMINDER_DELAY_MS, StateReminders, type StateSummary } from './state-reminders.js';

function space(controlledBy: 'agent' | 'user', urls: string[]): StateSummary['spaces'][number] {
  return {
    id: 1,
    name: 'checkout',
    controlledBy,
    tabs: controlledBy === 'agent' ? urls.map((url) => ({ title: url, url })) : [],
    tabCount: urls.length,
  };
}

function fixture() {
  let current: StateSummary = { spaces: [], userTabs: 0 };
  let running = false;
  const sent: { sessionId: string; summary: StateSummary }[] = [];
  const reminders = new StateReminders({
    summary: () => current,
    running: () => running,
    send: (sessionId, summary) => {
      sent.push({ sessionId, summary });
    },
  });
  return {
    reminders,
    sent,
    set(next: StateSummary) {
      current = next;
    },
    run(value: boolean) {
      running = value;
    },
  };
}

describe('browser state reminders (B2.7.3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports what the user changed after the agent last saw the browser', async () => {
    const f = fixture();
    f.set({ spaces: [space('agent', ['http://a.test/'])], userTabs: 1 });
    f.reminders.runEnded('s1');
    f.set({ spaces: [space('user', ['http://a.test/'])], userTabs: 1 });
    f.reminders.changed('s1');
    f.reminders.changed('s1');
    await vi.advanceTimersByTimeAsync(STATE_REMINDER_DELAY_MS);
    expect(f.sent).toEqual([
      { sessionId: 's1', summary: { spaces: [space('user', ['http://a.test/'])], userTabs: 1 } },
    ]);
    // The same state again is not news; handing back with a new page is.
    f.reminders.changed('s1');
    await vi.advanceTimersByTimeAsync(STATE_REMINDER_DELAY_MS);
    expect(f.sent).toHaveLength(1);
    f.set({ spaces: [space('agent', ['http://a.test/done'])], userTabs: 1 });
    f.reminders.changed('s1');
    await vi.advanceTimersByTimeAsync(STATE_REMINDER_DELAY_MS);
    expect(f.sent).toHaveLength(2);
  });

  it('says nothing while a script runs or before the agent used the browser', async () => {
    const f = fixture();
    f.set({ spaces: [], userTabs: 3 });
    f.reminders.changed('s1');
    await vi.advanceTimersByTimeAsync(STATE_REMINDER_DELAY_MS);
    expect(f.sent).toEqual([]);
    f.set({ spaces: [space('agent', ['http://a.test/'])], userTabs: 3 });
    f.run(true);
    f.reminders.changed('s1');
    await vi.advanceTimersByTimeAsync(STATE_REMINDER_DELAY_MS);
    expect(f.sent).toEqual([]);
    // The run's own changes are what the agent saw.
    f.run(false);
    f.reminders.runEnded('s1');
    f.reminders.changed('s1');
    await vi.advanceTimersByTimeAsync(STATE_REMINDER_DELAY_MS);
    expect(f.sent).toEqual([]);
  });

  it('keeps going when Core refuses one', async () => {
    const f = fixture();
    const reminders = new StateReminders({
      summary: () => ({ spaces: [space('user', ['x'])], userTabs: 0 }),
      running: () => false,
      send: () => {
        throw new Error('session closed');
      },
    });
    f.set({ spaces: [space('agent', ['x'])], userTabs: 0 });
    reminders.runEnded('s1');
    reminders.changed('s1');
    await vi.advanceTimersByTimeAsync(STATE_REMINDER_DELAY_MS);
    reminders.forget('s1');
    expect(f.sent).toEqual([]);
  });
});
