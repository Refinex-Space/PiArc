import { SessionManager } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_LIMITS, SUBAGENT_STATE_ENTRY } from '../harness/subagents/definitions.js';
import type { SessionHarness } from '../harness/session-harness.js';
import { ChildSession } from './subagent-session.js';
import { SubagentRunner, type ParentSession } from './subagents.js';
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

describe('SubagentRunner foreground runs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stops a run whose parent was interrupted while the child session was opening (R4 S1)', async () => {
    const answer = (method: string, value: unknown) =>
      method === 'agents/list'
        ? { agents: [], issues: [], limits: DEFAULT_LIMITS, deniedBuiltIn: [], aliases: {} }
        : value;
    const bridge = {
      requestTyped: (method: string, _params: unknown, parse: (v: unknown) => unknown) =>
        Promise.resolve(parse(answer(method, {}))),
      request: () => Promise.resolve({}),
    };
    const options = {
      log: () => undefined,
      hostTools: { subagents: true },
      tools: { kind: 'core', bridge },
      workspace: {
        modelRuntime: { getAvailable: () => Promise.resolve([]) },
        preferences: { defaultEffort: () => undefined },
      },
    } as unknown as RegistryOptions;
    const parent = {
      sessionId: 'main',
      cwd: '/w',
      session: {
        model: { provider: 'p', id: 'm', api: 'anthropic-messages', reasoning: false },
        thinkingLevel: 'off',
        sessionManager: { appendCustomEntry: () => 'entry' },
      },
      harness: {},
      sink: { event: () => undefined, delta: () => undefined, replaceable: () => undefined },
      tools: () => ['Read'],
    } as unknown as ParentSession;
    const runner = new SubagentRunner(options, (id) => (id === 'main' ? parent : undefined));
    const host = await runner.hostFor('main', '/w');
    let open: ((child: ChildSession) => void) | undefined;
    vi.spyOn(ChildSession, 'open').mockReturnValue(
      new Promise((resolve) => {
        open = resolve;
      }),
    );
    let asked: boolean | undefined;
    const child = {
      warnings: [],
      cwd: '/w',
      file: undefined,
      session: {},
      harness: {},
      run: (_task: string, signal: AbortSignal) => {
        asked = !signal.aborted;
        return Promise.resolve({
          status: signal.aborted ? 'interrupted' : 'completed',
          report: 'done',
          turns: 1,
        });
      },
      finish: () => Promise.resolve(undefined),
    } as unknown as ChildSession;
    const interrupt = new AbortController();
    const result = host?.run(
      'agent-1',
      { description: 'Scout', prompt: 'Look around.', type: 'general-purpose' },
      interrupt.signal,
      () => undefined,
    );
    await vi.waitFor(() => {
      expect(open).toBeDefined();
    });
    interrupt.abort('interrupted');
    open?.(child);
    const outcome = await result;
    expect(asked).toBe(false);
    expect(outcome?.isError).toBe(true);
    expect(outcome?.details.subagent?.status).toBe('interrupted');
  });
});
