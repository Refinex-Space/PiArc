import { describe, expect, it } from 'vitest';

import { CORPUS, mixedReply } from './corpus.js';
import {
  CORE_MERGE_INTERVAL_MS,
  FixtureSession,
  approximateTokens,
  generateHistory,
  messagesForTokens,
  planTurn,
  type TranscriptNotification,
} from './synthesizer.js';

function flatten(
  batches: readonly { notifications: readonly TranscriptNotification[] }[],
): TranscriptNotification[] {
  return batches.flatMap((batch) => batch.notifications);
}

describe('approximateTokens', () => {
  it('keeps every character of every corpus document', () => {
    for (const document of CORPUS) {
      expect(approximateTokens(document.markdown).join('')).toBe(document.markdown);
    }
  });

  it('cuts English prose into pieces of about four characters', () => {
    const text =
      'The transcript renders model output while it streams, keeps the viewport pinned to the ' +
      'bottom, and lets the user select text across paragraphs and code blocks.';
    const ratio = text.length / approximateTokens(text).length;
    expect(ratio).toBeGreaterThan(2.5);
    expect(ratio).toBeLessThan(5);
  });

  it('gives each CJK character its own piece', () => {
    expect(approximateTokens('中文テキスト')).toEqual(['中', '文', 'テ', 'キ', 'ス', 'ト']);
  });
});

describe('planTurn', () => {
  const session = (): FixtureSession => new FixtureSession('session-1', () => 0);

  it('emits protocol notifications whose deltas add up to each message', () => {
    const messages = [mixedReply(), 'second message'];
    const notifications = flatten(
      planTurn(session(), { turnId: 'turn-1', messages, tokensPerSecond: 100 }),
    );
    expect(notifications[0]?.method).toBe('turn/started');
    expect(notifications.at(-1)?.method).toBe('turn/completed');
    messages.forEach((message, index) => {
      const itemId = `turn-1-msg-${String(index + 1)}`;
      const text = notifications
        .map((notification) =>
          notification.method === 'item/agentMessage/delta' && notification.params.itemId === itemId
            ? notification.params.delta
            : '',
        )
        .join('');
      expect(text).toBe(message);
      const completed = notifications.find(
        (notification) =>
          notification.method === 'item/completed' && notification.params.item.itemId === itemId,
      );
      expect(completed?.method === 'item/completed' && completed.params.item).toMatchObject({
        type: 'agentMessage',
        status: 'completed',
        text: message,
      });
    });
    const seqs = notifications.map((notification) => notification.params.seq);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
  });

  it('paces deltas at the token rate, one per merge interval', () => {
    const message = mixedReply();
    const batches = planTurn(session(), {
      turnId: 'turn-1',
      messages: [message],
      tokensPerSecond: 100,
    });
    const deltas = batches.filter((batch) =>
      batch.notifications.some((notification) => notification.method === 'item/agentMessage/delta'),
    );
    const tokens = approximateTokens(message).length;
    const last = deltas.at(-1)?.atMs ?? 0;
    expect(last).toBeGreaterThanOrEqual((tokens / 100) * 1000);
    expect(last).toBeLessThanOrEqual((tokens / 100) * 1000 + CORE_MERGE_INTERVAL_MS);
    for (let index = 1; index < deltas.length; index += 1) {
      const gap = (deltas[index]?.atMs ?? 0) - (deltas[index - 1]?.atMs ?? 0);
      expect(gap).toBeGreaterThanOrEqual(CORE_MERGE_INTERVAL_MS - 1e-9);
    }
  });

  it('rejects a non-positive rate', () => {
    expect(() => planTurn(session(), { turnId: 't', messages: ['x'], tokensPerSecond: 0 })).toThrow(
      RangeError,
    );
  });
});

describe('messagesForTokens', () => {
  it('produces at least the requested number of tokens', () => {
    const messages = messagesForTokens(6000);
    const tokens = messages.reduce((sum, message) => sum + approximateTokens(message).length, 0);
    expect(tokens).toBeGreaterThanOrEqual(6000);
  });
});

describe('generateHistory', () => {
  it('builds the requested number of completed items, deterministically', () => {
    const first = generateHistory({
      count: 10_000,
      seed: 7,
      session: new FixtureSession('s', () => 0),
    });
    const second = generateHistory({
      count: 10_000,
      seed: 7,
      session: new FixtureSession('s', () => 0),
    });
    expect(first).toHaveLength(10_000);
    expect(second).toEqual(first);
    const ids = new Set(first.map((notification) => notification.params.item.itemId));
    expect(ids.size).toBe(10_000);
    const types = new Set(first.map((notification) => notification.params.item.type));
    expect(types).toEqual(new Set(['agentMessage', 'dynamicToolCall']));
  });
});
