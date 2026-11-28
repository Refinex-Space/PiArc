import { describe, expect, it, vi } from 'vitest';

import type { PiarcApi } from '../../shared/ipc.js';
import { AppStore } from '../store/app-store.js';
import { compactFocus, SessionInput, type Draft } from './session-input.js';

function setup() {
  const store = new AppStore();
  const api = {
    prompt: vi.fn<PiarcApi['prompt']>().mockResolvedValue('{"turnId":"t1"}'),
    steer: vi.fn<PiarcApi['steer']>(),
    followUp: vi.fn<PiarcApi['followUp']>(),
    resumeSession: vi.fn<PiarcApi['resumeSession']>().mockResolvedValue('{}'),
    deleteQueueItem: vi.fn<PiarcApi['deleteQueueItem']>().mockResolvedValue('{"items":[]}'),
    storeAttachment: vi
      .fn<PiarcApi['storeAttachment']>()
      .mockImplementation((_id, name, mimeType, bytes) =>
        Promise.resolve(
          JSON.stringify({
            kind: 'image',
            name,
            mimeType,
            blob: { path: name, sha256: 'abc', size: bytes.length },
          }),
        ),
      ),
  };
  // Conversation constructs a sender on each mount but its transcript lives in the window store.
  return { api, store, enter: () => new SessionInput(api, store, 's') };
}

function draft(...names: string[]): Draft {
  return {
    text: 'Compare @main.ts',
    mentions: [{ path: 'main.ts', start: 8, end: 16 }],
    stored: [],
    pending: names.map((name) => ({
      id: name,
      kind: 'image',
      mimeType: 'image/png',
      name,
      size: 1,
      file: new Blob(['a']),
    })),
  };
}

describe('sending a queued follow-up now', () => {
  const item = {
    itemId: 'q2',
    kind: 'followUp' as const,
    text: 'Then @a.ts',
    attachments: [],
    mentions: [{ path: 'src/a.ts', start: 5, end: 10 }],
    stored: [
      {
        kind: 'image' as const,
        name: 'a.png',
        mimeType: 'image/png',
        blob: { path: '/s/a.png', sha256: 'f', size: 3 },
      },
    ],
  };

  it('takes it out of the queue, then steers the turn with the same input', async () => {
    const { enter, api } = setup();
    const order: string[] = [];
    api.deleteQueueItem.mockImplementation(() => {
      order.push('delete');
      return Promise.resolve('{"items":[]}');
    });
    api.steer.mockImplementation(() => {
      order.push('steer');
      return Promise.resolve('{"disposition":"queued","itemId":"q3"}');
    });
    await enter().sendNow(item);
    expect(order).toEqual(['delete', 'steer']);
    expect(api.deleteQueueItem).toHaveBeenCalledWith('s', 'q2');
    expect(api.steer.mock.calls[0]?.[1]).toMatchObject({
      text: 'Then @a.ts',
      mentions: item.mentions,
      attachments: item.stored,
    });
    expect(api.followUp).not.toHaveBeenCalled();
  });

  it('puts it back in the queue when the steer is refused', async () => {
    const { enter, api } = setup();
    api.steer.mockRejectedValueOnce(new Error('refused'));
    api.followUp.mockResolvedValue('{"disposition":"queued","itemId":"q4"}');
    await expect(enter().sendNow(item)).rejects.toThrow('refused');
    expect(api.followUp.mock.calls[0]?.[1]).toMatchObject({
      text: 'Then @a.ts',
      mentions: item.mentions,
      attachments: item.stored,
    });
  });
});

describe('session input delivery', () => {
  it('resends from a reopened view once, with the same key and stored attachments', async () => {
    const { enter, api, store } = setup();
    api.prompt.mockRejectedValueOnce(new Error('connection lost'));
    await enter().send(draft('first.png'), 'client-1');
    const transcript = store.transcript('s');
    expect(transcript.row('optimistic:client-1')).toMatchObject({ state: 'undelivered' });
    await Promise.all([enter().resend('client-1'), enter().resend('client-1')]);
    expect(api.prompt).toHaveBeenCalledTimes(2);
    expect(api.prompt.mock.calls[1]).toEqual(api.prompt.mock.calls[0]);
    expect(api.storeAttachment).toHaveBeenCalledTimes(1);
    transcript.apply([
      {
        method: 'item/completed',
        params: {
          turnId: 't1',
          item: {
            type: 'userMessage',
            itemId: 'u1',
            text: 'Compare @main.ts',
            status: 'completed',
          },
        },
      },
    ]);
    await enter().resend('client-1');
    expect(api.prompt).toHaveBeenCalledTimes(2);
    expect(transcript.rowIds()).toEqual(['u1']);
  });

  it('keeps a failed message when a different prompt with the same text is echoed', async () => {
    const { enter, api, store } = setup();
    const transcript = store.transcript('s');
    api.prompt.mockRejectedValueOnce(new Error('connection lost'));
    await enter().send(draft('first.png'), 'first');
    api.prompt.mockImplementationOnce(() => {
      transcript.apply([
        {
          method: 'item/started',
          params: {
            turnId: 'second-turn',
            item: {
              type: 'userMessage',
              itemId: 'second-echo',
              status: 'completed',
              text: 'Compare @main.ts',
            },
          },
        },
      ]);
      return Promise.resolve('{"turnId":"second-turn"}');
    });
    await enter().send(draft('second.png'), 'second');
    expect(transcript.rowIds()).toEqual(['optimistic:first', 'second-echo']);
    expect(transcript.row('optimistic:first')).toMatchObject({ state: 'undelivered' });
  });

  it('resumes a partial upload at the first file Core did not store', async () => {
    const { enter, api } = setup();
    api.storeAttachment
      .mockResolvedValueOnce(
        JSON.stringify({
          kind: 'image',
          name: 'first.png',
          mimeType: 'image/png',
          blob: { path: 'first.png', sha256: 'abc', size: 1 },
        }),
      )
      .mockRejectedValueOnce(new Error('disk full'));
    await enter().send(draft('first.png', 'second.png'), 'client-1');
    expect(api.prompt).not.toHaveBeenCalled();
    await enter().resend('client-1');
    expect(api.storeAttachment.mock.calls.map((call) => call[1])).toEqual([
      'first.png',
      'second.png',
      'second.png',
    ]);
    expect(api.prompt.mock.calls[0]?.[1]).toMatchObject({
      attachments: [{ name: 'first.png' }, { name: 'second.png' }],
    });
  });

  it('retries an accepted input that lacked an echo, using a fresh key after switching views', async () => {
    const { enter, api } = setup();
    await enter().send(draft('first.png'), 'client-1');
    await enter().retry('t1');
    expect(api.prompt).toHaveBeenCalledTimes(2);
    const original = api.prompt.mock.calls[0]?.[1];
    const retry = api.prompt.mock.calls[1]?.[1];
    if (typeof original !== 'object' || typeof retry !== 'object') {
      throw new Error('Expected structured prompts');
    }
    expect(retry.requestId).toBeTypeOf('string');
    expect(retry.requestId).not.toBe('client-1');
    expect({ ...retry, requestId: original.requestId }).toEqual(original);
    expect(api.storeAttachment).toHaveBeenCalledTimes(1);
  });
});

describe('compactFocus', () => {
  const draft = (text: string, extra: Partial<Draft> = {}): Draft => ({
    text,
    mentions: [],
    pending: [],
    stored: [],
    ...extra,
  });

  it('takes the text after /compact as written, nothing for a bare command', () => {
    expect(compactFocus(draft('/compact'))).toBe('');
    expect(compactFocus(draft('  /compact  '))).toBe('');
    expect(compactFocus(draft('/compact Keep the API decisions.\nAnd the test names.'))).toBe(
      'Keep the API decisions.\nAnd the test names.',
    );
  });

  it('leaves other input alone', () => {
    expect(compactFocus(draft('/compaction please'))).toBeUndefined();
    expect(compactFocus(draft('please /compact'))).toBeUndefined();
    expect(
      compactFocus(draft('/compact', { mentions: [{ path: 'a', start: 0, end: 1 }] })),
    ).toBeUndefined();
  });
});
