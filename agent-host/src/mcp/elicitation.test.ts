import { expect, it } from 'vitest';
import { CoreBridge } from '../runtime/core-bridge.js';
import { Elicitations } from './elicitation.js';

it('cancels unsolicited and ambiguous requests, and withdraws an outstanding form when its tool ends', async () => {
  const active = new Elicitations();
  const sent: { method: string; params: unknown }[] = [];
  const bridge = new CoreBridge((message) => {
    const frame = message as { id: number; method: string; params: unknown };
    sent.push(frame);
    if (frame.method === 'mcp/cancelElicitation')
      queueMicrotask(() => bridge.handleResponse({ id: frame.id, jsonrpc: '2.0', result: {} }));
  });
  const ask = () =>
    active.handle(
      bridge,
      'alpha',
      { message: 'Pick.', requestedSchema: { type: 'object', properties: {} } },
      new AbortController().signal,
    );
  const one = { sessionId: 's', toolCallId: 'tool', serverTool: 'pick' };
  expect(await ask()).toEqual({ action: 'cancel' });
  const finishFirst = active.begin(one);
  const finishOther = active.begin({ ...one, sessionId: 'other' });
  expect(await ask()).toEqual({ action: 'cancel' });
  expect(sent).toEqual([]);
  finishOther();
  const reply = ask();
  expect(sent.at(0)?.method).toBe('mcp/elicit');
  expect(await ask()).toEqual({ action: 'cancel' });
  finishFirst();
  await expect(reply).rejects.toThrow(/cancelled/u);
  expect(sent.at(1)).toMatchObject({
    method: 'mcp/cancelElicitation',
    params: { sessionId: 's', toolCallId: 'tool', interaction: 1 },
  });
});

it('a server cancelling one question can immediately ask another on the same tool invocation', async () => {
  const active = new Elicitations();
  const sent: { method: string; params: { interaction: number } }[] = [];
  const bridge = new CoreBridge((message) => {
    const frame = message as { id: number; method: string; params: { interaction: number } };
    sent.push(frame);
    if (frame.method === 'mcp/cancelElicitation' || frame.params.interaction === 2) {
      queueMicrotask(() =>
        bridge.handleResponse({
          jsonrpc: '2.0',
          id: frame.id,
          result: frame.method === 'mcp/cancelElicitation' ? {} : { action: 'decline' },
        }),
      );
    }
  });
  const finish = active.begin({ sessionId: 's', toolCallId: 'call', serverTool: 'choose' });
  const ask = (signal: AbortSignal) =>
    active.handle(
      bridge,
      'alpha',
      { message: 'Choose.', requestedSchema: { type: 'object', properties: {} } },
      signal,
    );
  const first = new AbortController();
  const pending = ask(first.signal);
  first.abort();
  await expect(pending).rejects.toThrow(/cancelled/u);
  await expect(ask(new AbortController().signal)).resolves.toEqual({ action: 'decline' });
  expect(sent.map((f) => [f.method, f.params.interaction])).toEqual([
    ['mcp/elicit', 1],
    ['mcp/cancelElicitation', 1],
    ['mcp/elicit', 2],
  ]);
  finish();
});
