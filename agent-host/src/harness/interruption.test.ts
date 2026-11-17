import { SessionManager } from '@earendil-works/pi-coding-agent';
import type {
  AssistantMessage,
  Model,
  ToolResultMessage,
  UserMessage,
} from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import {
  INTERRUPTED_TOOL_RESULT,
  INTERRUPTION_MARKER_TEXT,
  isInterruptionMarker,
  repairInterruptedTurn,
  type RepairableSession,
} from './interruption.js';

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string): UserMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: 1 };
}

function assistant(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'anthropic-messages',
    provider: 'piarc-mock',
    model: 'mock-large',
    usage,
    stopReason,
    timestamp: 2,
  };
}

function result(toolCallId: string): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'Read',
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
    timestamp: 3,
  };
}

function session(manager: SessionManager): RepairableSession & { refreshed: number } {
  const fake = {
    sessionManager: manager,
    model: { api: 'anthropic-messages', provider: 'piarc-mock', id: 'mock-large' } as Model<string>,
    refreshed: 0,
    refreshContext(): void {
      fake.refreshed += 1;
    },
  };
  return fake;
}

/** Roles the model would see, Pi dropping aborted and failed responses. */
function roles(manager: SessionManager): string[] {
  return manager
    .buildSessionProjection()
    .messages.filter(
      (m) =>
        m.role !== 'system' &&
        !(m.role === 'assistant' && (m.stopReason === 'aborted' || m.stopReason === 'error')),
    )
    .map((m) => m.role);
}

describe('repairInterruptedTurn', () => {
  it('answers the tool calls the abort cut off and closes the turn with the marker', () => {
    const manager = SessionManager.inMemory('/w');
    manager.appendMessage(user('Read three files.'));
    manager.appendMessage(
      assistant(
        ['a', 'b', 'c'].map((id) => ({
          type: 'toolCall' as const,
          id,
          name: 'Read',
          arguments: { path: `${id}.txt` },
        })),
        'toolUse',
      ),
    );
    manager.appendMessage(result('a'));
    const fake = session(manager);
    expect(repairInterruptedTurn(fake)).toEqual({ toolResults: 2, marker: true });
    const messages = manager.buildSessionProjection().messages;
    const results = messages.flatMap((m) => (m.role === 'toolResult' ? [m] : []));
    expect(results.map((r) => [r.toolCallId, r.isError])).toEqual([
      ['a', false],
      ['b', true],
      ['c', true],
    ]);
    expect(results[1]?.content).toEqual([{ type: 'text', text: INTERRUPTED_TOOL_RESULT }]);
    const marker = messages.at(-1);
    expect(marker).toMatchObject({
      role: 'assistant',
      provider: 'piarc-mock',
      model: 'mock-large',
      stopReason: 'stop',
      content: [{ type: 'text', text: INTERRUPTION_MARKER_TEXT }],
    });
    expect(marker?.role === 'assistant' && isInterruptionMarker(marker)).toBe(true);
    expect(fake.refreshed).toBe(1);
    // The next input keeps user and assistant alternating (consecutive tool results go out as
    // one user message).
    manager.appendMessage(user('Go on.'));
    expect(roles(manager)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'toolResult',
      'toolResult',
      'assistant',
      'user',
    ]);
  });

  it('closes a reply cut off while streaming, which Pi leaves out of the context', () => {
    const manager = SessionManager.inMemory('/w');
    manager.appendMessage(user('Explain.'));
    manager.appendMessage(assistant([{ type: 'text', text: 'Well' }], 'aborted'));
    expect(repairInterruptedTurn(session(manager))).toEqual({ toolResults: 0, marker: true });
    manager.appendMessage(user('Shorter, please.'));
    expect(roles(manager)).toEqual(['user', 'assistant', 'user']);
  });

  it('changes nothing when the turn already ended with a response', () => {
    const manager = SessionManager.inMemory('/w');
    manager.appendMessage(user('Hi.'));
    manager.appendMessage(assistant([{ type: 'text', text: 'Hello.' }], 'stop'));
    const fake = session(manager);
    expect(repairInterruptedTurn(fake)).toEqual({ toolResults: 0, marker: false });
    expect(fake.refreshed).toBe(0);
  });
});
