import { SessionManager } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';

import { SUBAGENT_STATE_ENTRY } from '../harness/subagents/definitions.js';
import type { SessionHarness } from '../harness/session-harness.js';
import { SubagentRunner } from './subagents.js';
import type { RegistryOptions } from './session-types.js';

/** A background run's `Agent` call and its result, as the parent's file holds them. */
function parentWithBackgroundRun(): SessionManager {
  const manager = SessionManager.inMemory('/w');
  manager.appendMessage({ role: 'user', content: 'Send a scout.', timestamp: 1 });
  manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'agent-1', name: 'Agent', arguments: {} }],
    api: 'anthropic-messages',
    provider: 'p',
    model: 'm',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: 2,
  });
  manager.appendMessage({
    role: 'toolResult',
    toolCallId: 'agent-1',
    toolName: 'Agent',
    content: [{ type: 'text', text: 'Started in the background.' }],
    details: {
      subagent: {
        sessionId: 'child-1',
        agentType: 'scout',
        description: 'Scout ahead',
        status: 'running',
        background: true,
        startedAt: 1,
        toolCalls: 0,
        transcriptPath: '/data/pi/sessions/child.jsonl',
      },
    },
    isError: false,
    timestamp: 3,
  });
  return manager;
}

describe('SubagentRunner.recover', () => {
  it('ends a background run the previous process left running and tells the parent', () => {
    const lines: string[] = [];
    const runner = new SubagentRunner(
      { log: (line: string) => lines.push(line) } as unknown as RegistryOptions,
      () => undefined,
    );
    const reminders: { type: string; source: string; text: string }[] = [];
    const harness = {
      remind: (r: { type: string; source: string; text: string }) => reminders.push(r),
    } as unknown as SessionHarness;
    const manager = parentWithBackgroundRun();
    runner.recover('main', manager, harness);
    const states = manager
      .getBranch()
      .filter((e) => e.type === 'custom' && e.customType === SUBAGENT_STATE_ENTRY);
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      data: { itemId: 'agent-1', subagent: { sessionId: 'child-1', status: 'interrupted' } },
    });
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.type).toBe('backgroundTask');
    expect(reminders[0]?.text).toContain('interrupted: the Agent Host stopped');
    expect(reminders[0]?.text).toContain('/data/pi/sessions/child.jsonl');
    expect(lines[0]).toContain('child-1 was interrupted');
    // Recorded once: reopening again finds the run ended.
    runner.recover('main', manager, harness);
    expect(reminders).toHaveLength(1);
  });
});
