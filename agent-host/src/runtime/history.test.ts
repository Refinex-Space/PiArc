import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { InputAttachment } from '@piarc/protocol';
import { describe, expect, it } from 'vitest';

import { projectHistory } from './history.js';
import { INPUT_ENTRY } from './input.js';

const base = (id: string): { id: string; parentId: null; timestamp: string } => ({
  id,
  parentId: null,
  timestamp: '2026-11-18T00:00:00.000Z',
});

function user(id: string, text: string): SessionEntry {
  return {
    ...base(id),
    type: 'message',
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: 0 },
  };
}

const image: InputAttachment = {
  kind: 'image',
  name: 'a.png',
  mimeType: 'image/png',
  blob: { path: '/d/sessions/s/attachments/a.png', sha256: 'f'.repeat(64), size: 4 },
};

describe('projectHistory with input records', () => {
  it('shows a user message as the user wrote it when its record precedes it', () => {
    const record = {
      text: 'See @a.ts',
      mentions: [{ path: 'a.ts', start: 4, end: 9 }],
      attachments: [image],
    };
    const items = projectHistory(
      [
        { ...base('c1'), type: 'custom', customType: INPUT_ENTRY, data: record },
        user('u1', 'See @a.ts\n\n<attachment name="x.pdf">…</attachment>'),
        user('u2', 'plain'),
      ],
      (tool) => tool,
    );
    expect(items.map((entry) => entry.item)).toEqual([
      { type: 'userMessage', itemId: 'u1', status: 'completed', ...record },
      { type: 'userMessage', itemId: 'u2', status: 'completed', text: 'plain' },
    ]);
  });

  it('recovers steering boundaries from PiArc input records and starts fresh for older inputs', () => {
    const marker = (id: string, turnId: string): SessionEntry => ({
      ...base(id),
      type: 'custom',
      customType: INPUT_ENTRY,
      data: { turnId },
    });
    const history = projectHistory(
      [
        marker('c1', 't1'),
        user('u1', 'Start'),
        marker('c2', 't1'),
        user('u2', 'Also this'),
        marker('c3', 't2'),
        user('u3', 'Next prompt'),
        user('legacy', 'Older unmarked input'),
      ],
      (tool) => tool,
    );
    expect(history.map((entry) => entry.turnId)).toEqual(['t1', 't1', 't2', 'legacy']);
  });

  it('ignores a record that does not match the next user message', () => {
    const items = projectHistory(
      [
        { ...base('c1'), type: 'custom', customType: INPUT_ENTRY, data: { text: 'other' } },
        user('u1', 'mine'),
      ],
      (tool) => tool,
    );
    expect(items[0]?.item).toEqual({
      type: 'userMessage',
      itemId: 'u1',
      status: 'completed',
      text: 'mine',
    });
  });
});
