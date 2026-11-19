// T27: reminder messages become `reminder` items, live and in the history, only when Core
// enabled the `context` capability.
import { SessionManager, type AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';

import { reminderMessage } from '../harness/reminders.js';
import { projectHistory } from './history.js';
import { Projector, type ProjectionSink } from './projector.js';

const message = reminderMessage([
  { key: 'file:/w/a', type: 'fileModified', source: '/w/a', text: 'a changed' },
]);

function recording(): ProjectionSink & { events: [string, Record<string, unknown>][] } {
  const events: [string, Record<string, unknown>][] = [];
  return {
    events,
    event: (method, payload) => events.push([method, payload]),
    delta: () => undefined,
    replaceable: () => undefined,
  };
}

const end = {
  type: 'message_end',
  message: { role: 'custom', ...message, timestamp: 0 },
} as unknown as AgentSessionEvent;

describe('reminder items', () => {
  it('projects a delivered reminder message and one appended directly', () => {
    const sink = recording();
    const projector = new Projector(sink, undefined, { reminders: true });
    projector.beginTurn('t');
    projector.handle(end);
    projector.reminder(message);
    const items = sink.events
      .filter(([method]) => method === 'item/completed')
      .map(([, payload]) => payload.item);
    expect(items).toEqual([
      {
        type: 'reminder',
        itemId: 't:reminder:1',
        status: 'completed',
        reminders: [{ type: 'fileModified', source: '/w/a' }],
        text: message.content,
      },
      expect.objectContaining({ itemId: 't:reminder:2' }),
    ]);
  });

  it('projects nothing without the capability, live or in the history', () => {
    const sink = recording();
    const projector = new Projector(sink);
    projector.beginTurn('t');
    projector.handle(end);
    expect(sink.events.filter(([method]) => method.startsWith('item/'))).toEqual([]);
    const manager = SessionManager.inMemory('/w');
    const id = manager.appendCustomMessageEntry(
      message.customType,
      message.content,
      false,
      message.details,
    );
    expect(projectHistory(manager.getBranch(), (t) => t)).toEqual([]);
    expect(projectHistory(manager.getBranch(), (t) => t, true)).toEqual([
      {
        entryId: id,
        turnId: id,
        item: {
          type: 'reminder',
          itemId: id,
          status: 'completed',
          reminders: [{ type: 'fileModified', source: '/w/a' }],
          text: message.content,
        },
      },
    ]);
  });
});
