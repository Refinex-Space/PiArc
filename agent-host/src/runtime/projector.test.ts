import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';

import { Projector, type ProjectionSink } from './projector.js';

interface Emitted {
  method: string;
  payload: Record<string, unknown>;
  delta?: string;
}

function recorder(): { sink: ProjectionSink; out: Emitted[] } {
  const out: Emitted[] = [];
  return {
    out,
    sink: {
      event: (method, payload) => out.push({ method, payload }),
      delta: (method, _key, payload, delta) => out.push({ method, payload, delta }),
    },
  };
}

// Test events carry only the members the projector reads.
function ev(event: Record<string, unknown>): AgentSessionEvent {
  return event as unknown as AgentSessionEvent;
}
const assistant = (extra: Record<string, unknown> = {}) => ({
  role: 'assistant',
  stopReason: 'stop',
  ...extra,
});
const update = (assistantMessageEvent: Record<string, unknown>) =>
  ev({ type: 'message_update', message: assistant(), assistantMessageEvent });

function textEvents(index: number, deltas: string[], content: string): AgentSessionEvent[] {
  return [
    update({ type: 'text_start', contentIndex: index }),
    ...deltas.map((delta) => update({ type: 'text_delta', contentIndex: index, delta })),
    update({ type: 'text_end', contentIndex: index, content }),
  ];
}

describe('Projector', () => {
  it('projects a prompt with text and a tool call onto turn and item notifications', () => {
    const { sink, out } = recorder();
    const projector = new Projector(sink);
    projector.handle(ev({ type: 'agent_start' })); // before the prompt was accepted: ignored
    projector.beginTurn('turn-1');
    const events = [
      ev({ type: 'agent_start' }),
      ev({ type: 'message_start', message: assistant() }),
      ...textEvents(0, ['Wri', 'ting.'], 'Writing.'),
      ev({ type: 'message_end', message: assistant({ stopReason: 'toolUse' }) }),
      ev({
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'write',
        args: { path: 'a b/中文.txt' },
      }),
      ev({
        type: 'tool_execution_end',
        toolCallId: 'call-1',
        toolName: 'write',
        isError: false,
        result: {
          content: [
            { type: 'text', text: 'Wrote 1 line' },
            { type: 'image', data: '' },
          ],
        },
      }),
      ev({ type: 'agent_start' }),
      ev({ type: 'agent_settled', aborted: false }),
    ];
    for (const event of events) {
      projector.handle(event);
    }
    expect(out.map((e) => e.method)).toEqual([
      'turn/started',
      'item/started',
      'item/agentMessage/delta',
      'item/agentMessage/delta',
      'item/completed',
      'item/started',
      'item/completed',
      'turn/completed',
    ]);
    const itemId = (out[1]?.payload.item as { itemId: string }).itemId;
    expect(itemId).toMatch(/^[0-9a-f-]{36}#0$/);
    expect(out[2]).toEqual({
      method: 'item/agentMessage/delta',
      payload: { turnId: 'turn-1', itemId },
      delta: 'Wri',
    });
    expect(out[4]?.payload).toEqual({
      turnId: 'turn-1',
      item: { type: 'agentMessage', itemId, status: 'completed', text: 'Writing.' },
    });
    expect(out[6]?.payload).toEqual({
      turnId: 'turn-1',
      item: {
        type: 'dynamicToolCall',
        itemId: 'call-1',
        status: 'completed',
        tool: 'write',
        arguments: { path: 'a b/中文.txt' },
        output: 'Wrote 1 line',
      },
    });
    expect(out[7]?.payload).toEqual({ turnId: 'turn-1', status: 'completed' });
    expect(projector.activeTurnId).toBeUndefined();
  });

  it('marks open items and the turn interrupted when the run is aborted', () => {
    const { sink, out } = recorder();
    const projector = new Projector(sink);
    projector.beginTurn('turn-2');
    projector.handle(ev({ type: 'agent_start' }));
    projector.handle(ev({ type: 'message_start', message: assistant() }));
    projector.handle(update({ type: 'text_start', contentIndex: 0 }));
    projector.handle(update({ type: 'text_delta', contentIndex: 0, delta: 'Hal' }));
    projector.handle(ev({ type: 'message_end', message: assistant({ stopReason: 'aborted' }) }));
    projector.handle(ev({ type: 'agent_settled', aborted: true }));
    expect(out.slice(-2).map((e) => e.payload)).toEqual([
      {
        turnId: 'turn-2',
        item: expect.objectContaining({ status: 'interrupted', text: 'Hal' }) as unknown,
      },
      { turnId: 'turn-2', status: 'interrupted' },
    ]);
  });

  it('reports a failed turn with the model error', () => {
    const { sink, out } = recorder();
    const projector = new Projector(sink);
    projector.beginTurn('turn-3');
    projector.handle(ev({ type: 'agent_start' }));
    projector.handle(
      ev({
        type: 'message_end',
        message: assistant({ stopReason: 'error', errorMessage: '400 bad' }),
      }),
    );
    projector.handle(ev({ type: 'agent_settled', aborted: false }));
    expect(out.at(-1)?.payload).toEqual({
      turnId: 'turn-3',
      status: 'failed',
      errorMessage: '400 bad',
    });
  });

  it('never sends a lone surrogate when a delta splits a surrogate pair', () => {
    const { sink, out } = recorder();
    const projector = new Projector(sink);
    projector.beginTurn('turn-4');
    projector.handle(ev({ type: 'agent_start' }));
    // 😀 is 😀: the model's stream cuts it in half.
    const deltas = ['ab\ud83d', '\ude00c', '\ude01', 'd\ud83d'];
    for (const event of textEvents(0, deltas, 'ab😀c\ude01d\ud83d')) {
      projector.handle(event);
    }
    const sent = out.filter((e) => e.delta !== undefined).map((e) => e.delta ?? '');
    expect(sent).toEqual(['ab', '😀c', '�', 'd']);
    for (const text of sent) {
      expect(text.isWellFormed()).toBe(true);
    }
    expect(out.at(-1)?.payload.item).toMatchObject({ text: 'ab😀c�d�' });
  });

  it('finishes only the turn it is asked to finish', () => {
    const { sink, out } = recorder();
    const projector = new Projector(sink);
    projector.beginTurn('old');
    projector.finishTurn('old', 'interrupted');
    projector.beginTurn('new');
    projector.finishTurn('old', 'completed');
    expect(projector.activeTurnId).toBe('new');
    expect(out.map((e) => `${e.method}:${String(e.payload.turnId)}`)).toEqual([
      'turn/started:old',
      'turn/completed:old',
    ]);
  });
});
