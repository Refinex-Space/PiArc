// T26's host tools without a live session: reminders, plan mode records, the task list and its
// stale-list watch, question results and the branch's harness state.
import { SessionManager, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, JsonValue, ToolResultMessage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import type { ProjectionSink } from '../runtime/projector.js';
import { DEFAULT_PROFILE } from '../tools/profile.js';
import { anthropicMemoryPayload } from './memory-wire.js';
import { currentPlan, PlanMode, PLAN_ON, planOff } from './plan-mode.js';
import { askResultText, parseAskResult } from './questions.js';
import { REMINDER_ENTRY, REMINDER_MARKER, Reminders } from './reminders.js';
import { harnessState, SessionHarness } from './session-harness.js';
import {
  createTodoWriteTool,
  currentTodos,
  roundsSinceUpdate,
  TODO_REMINDER_ROUNDS,
  todoWatch,
} from './todos.js';

const same = (tool: string): string => tool;

function recordingSink(): ProjectionSink & { events: [string, unknown][] } {
  const events: [string, unknown][] = [];
  return {
    events,
    event: (method, payload) => {
      events.push([method, payload]);
    },
    delta: () => undefined,
    replaceable: () => undefined,
  };
}

function assistant(calls: string[]): AssistantMessage {
  return {
    role: 'assistant',
    content: calls.map((name, i) => ({
      type: 'toolCall',
      id: `${name}-${String(i)}`,
      name,
      arguments: {},
    })),
    api: 'anthropic-messages',
    provider: 'mock',
    model: 'mock-model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: 0,
  };
}

function result(toolName: string, details: unknown, isError = false): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: `${toolName}-0`,
    toolName,
    content: [{ type: 'text', text: 'ok' }],
    ...(details === undefined ? {} : { details: JSON.parse(JSON.stringify(details)) as JsonValue }),
    isError,
    timestamp: 0,
  };
}

const LIST = {
  todos: [
    { content: 'Read the parser', status: 'completed' },
    { content: 'Fix the bug', status: 'inProgress', activeForm: 'Fixing the bug' },
    { content: 'Update the docs', status: 'pending' },
  ],
};

describe('reminders', () => {
  it('replaces by key, withdraws and delivers one marked message', () => {
    const reminders = new Reminders();
    let delivered = 0;
    reminders.enqueue('mode', 'first');
    reminders.enqueue('todo', 'list', () => delivered++);
    reminders.enqueue('mode', 'second');
    reminders.enqueue('gone', 'x');
    reminders.withdraw('gone');
    const message = reminders.take();
    expect(message).toEqual({
      customType: REMINDER_ENTRY,
      display: false,
      content: `${REMINDER_MARKER}\n\nlist\n\nsecond`,
      details: { keys: ['todo', 'mode'] },
    });
    expect(delivered).toBe(1);
    expect(reminders.take()).toBeUndefined();
  });

  it('delivers at the start of a run and after a round of tool calls only', async () => {
    const reminders = new Reminders();
    const handlers = new Map<string, (event: unknown) => unknown>();
    const sent: unknown[] = [];
    void reminders.extension({
      on: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler),
      sendMessage: (message: unknown, options: unknown) => sent.push([message, options]),
    } as unknown as ExtensionAPI);
    reminders.enqueue('mode', PLAN_ON);
    await handlers.get('turn_end')?.({ toolResults: [] });
    expect(sent).toEqual([]);
    await handlers.get('turn_end')?.({ toolResults: [{}] });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject([{ customType: REMINDER_ENTRY }, { triggerTurn: false }]);
    reminders.enqueue('mode', planOff('default'));
    expect(await handlers.get('before_agent_start')?.({})).toMatchObject({
      message: { content: `${REMINDER_MARKER}\n\n${planOff('default')}` },
    });
  });

  it('joins the adjacent user turn on the Anthropic wire', () => {
    const payload = {
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] },
        { role: 'user', content: [{ type: 'text', text: `${REMINDER_MARKER}\n\nnote` }] },
      ],
    };
    expect(anthropicMemoryPayload(payload)).toEqual({
      messages: [
        payload.messages[0],
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't', content: 'x' },
            { type: 'text', text: `${REMINDER_MARKER}\n\nnote` },
          ],
        },
      ],
    });
  });
});

describe('plan mode', () => {
  function planMode(manager = SessionManager.inMemory('/w')) {
    const reminders = new Reminders();
    const sink = recordingSink();
    const plan = new PlanMode({ manager, sink, reminders, activeTurn: () => 'turn-1' });
    return { manager, reminders, sink, plan };
  }

  it('records switches as entries and items and tells the model about plan mode only', () => {
    const { manager, reminders, sink, plan } = planMode();
    plan.record('acceptEdits');
    expect(reminders.take()).toBeUndefined();
    plan.record('plan');
    expect(reminders.take()?.content).toContain(PLAN_ON);
    plan.record('default');
    plan.record('plan');
    // Back to plan before the model heard of leaving it: nothing to say.
    expect(reminders.take()).toBeUndefined();
    plan.record('default');
    expect(reminders.take()?.content).toContain(planOff('default'));
    const items = sink.events.filter(([method]) => method === 'item/completed');
    expect(items).toHaveLength(5);
    expect(items[1]?.[1]).toMatchObject({
      turnId: 'turn-1',
      item: { type: 'permissionModeChanged', mode: 'plan' },
    });
    expect(
      manager
        .getBranch()
        .filter((e) => e.type === 'custom' && e.customType === 'piarc.permissionMode'),
    ).toHaveLength(5);
  });

  it('a tool result stands in for the reminder', () => {
    const { reminders, plan } = planMode();
    plan.record('plan');
    plan.acknowledge();
    expect(reminders.take()).toBeUndefined();
  });

  it('records the approved plan as the branch’s current plan', () => {
    const { manager, sink, plan } = planMode();
    plan.record('plan');
    plan.record('acceptEdits');
    const record = plan.approve('call-1', '# 计划\n1. Fix');
    expect(record).toMatchObject({
      plan: '# 计划\n1. Fix',
      toolCallId: 'call-1',
      mode: 'acceptEdits',
    });
    expect(record.entryId).toMatch(/\S/);
    expect(sink.events.at(-1)).toEqual(['harness/plan', record]);
    expect(currentPlan(manager.getBranch())).toEqual(record);
    // A reopened session reads the same record (the injection interface for T27).
    const reopened = SessionManager.inMemory('/w', undefined, [
      manager.getHeader() ?? { type: 'session', version: 3, id: 's', timestamp: '', cwd: '/w' },
      ...manager.getEntries(),
    ]);
    expect(currentPlan(reopened.getBranch())).toEqual(record);
  });
});

describe('task list', () => {
  it('saves Claude Code style parameters in the protocol shape', async () => {
    const tool = createTodoWriteTool(DEFAULT_PROFILE.TodoWrite);
    const done = await tool.execute(
      'call',
      {
        todos: [
          { content: 'Read the parser', status: 'completed' },
          { content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing the bug' },
          { content: 'Update the docs', status: 'pending' },
        ],
      },
      undefined,
      undefined,
      {} as never,
    );
    expect(done.details).toEqual(LIST);
    expect(done.content).toEqual([
      {
        type: 'text',
        text: 'Task list saved: 3 tasks, 1 completed, 1 in progress, 1 pending. Current task: Fixing the bug.',
      },
    ]);
  });

  it('is the last successful result of the branch, so it follows forks', () => {
    const manager = SessionManager.inMemory('/w');
    manager.appendMessage(assistant(['TodoWrite']));
    manager.appendMessage(result('TodoWrite', { todos: [{ content: 'A', status: 'pending' }] }));
    const early = manager.getLeafId();
    manager.appendMessage(assistant(['TodoWrite']));
    manager.appendMessage(result('TodoWrite', LIST));
    manager.appendMessage(assistant(['TodoWrite']));
    manager.appendMessage(result('TodoWrite', LIST, true));
    expect(currentTodos(manager.getBranch(), same)).toEqual(LIST.todos);
    expect(currentTodos(early === null ? [] : manager.getBranch(early), same)).toEqual([
      { content: 'A', status: 'pending' },
    ]);
    expect(harnessState(manager.getBranch(), same)).toEqual({ todos: LIST.todos });
    expect(harnessState([], same)).toBeUndefined();
  });

  it('reminds after the threshold of rounds without an update, then counts again', () => {
    const manager = SessionManager.inMemory('/w');
    const reminders = new Reminders();
    const handlers = new Map<string, (event: unknown) => unknown>();
    void todoWatch(
      manager,
      reminders,
      same,
    )({
      on: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler),
    } as unknown as ExtensionAPI);
    const round = (): void => {
      manager.appendMessage(assistant(['Read']));
      manager.appendMessage(result('Read', undefined));
      void handlers.get('turn_end')?.({ toolResults: [{}] });
    };
    manager.appendMessage(assistant(['TodoWrite']));
    manager.appendMessage(result('TodoWrite', LIST));
    void handlers.get('turn_end')?.({ toolResults: [{}] });
    for (let n = 1; n < TODO_REMINDER_ROUNDS; n++) round();
    expect(reminders.has('todo')).toBe(false);
    round();
    expect(roundsSinceUpdate(manager.getBranch(), same)).toBe(TODO_REMINDER_ROUNDS);
    const notice = reminders.take();
    expect(notice?.content).toContain(`has not changed for ${String(TODO_REMINDER_ROUNDS)} rounds`);
    expect(notice?.content).toContain('- [in progress] Fix the bug');
    expect(notice?.content).toContain('- [pending] Update the docs');
    expect(notice?.content).not.toContain('Read the parser');
    if (notice === undefined) throw new Error('no notice');
    manager.appendCustomMessageEntry(notice.customType, notice.content, false, notice.details);
    expect(roundsSinceUpdate(manager.getBranch(), same)).toBe(0);
    round();
    expect(reminders.has('todo')).toBe(false);
  });

  it('a finished list needs no reminder', () => {
    const manager = SessionManager.inMemory('/w');
    const reminders = new Reminders();
    const handlers = new Map<string, (event: unknown) => unknown>();
    void todoWatch(
      manager,
      reminders,
      same,
    )({
      on: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler),
    } as unknown as ExtensionAPI);
    manager.appendMessage(assistant(['TodoWrite']));
    manager.appendMessage(result('TodoWrite', { todos: [{ content: 'A', status: 'completed' }] }));
    for (let n = 0; n <= TODO_REMINDER_ROUNDS; n++) {
      manager.appendMessage(assistant(['Read']));
      manager.appendMessage(result('Read', undefined));
      void handlers.get('turn_end')?.({ toolResults: [{}] });
    }
    expect(reminders.has('todo')).toBe(false);
  });

  it('reports each new list after its item', () => {
    const sink = recordingSink();
    const harness = new SessionHarness({
      sessionId: 's',
      manager: SessionManager.inMemory('/w'),
      sink,
      profile: DEFAULT_PROFILE,
      canonical: same,
      activeTurn: () => undefined,
      core: undefined,
    });
    harness.onEvent({
      type: 'tool_execution_end',
      toolCallId: 'todo-1',
      toolName: 'TodoWrite',
      result: { content: [], details: LIST },
      isError: false,
    });
    harness.onEvent({
      type: 'tool_execution_end',
      toolCallId: 'todo-2',
      toolName: 'TodoWrite',
      result: { content: [], details: LIST },
      isError: true,
    });
    expect(sink.events).toEqual([['harness/todo', { itemId: 'todo-1', todos: LIST.todos }]]);
    // Without Core's capabilities only SuggestNextSteps is offered.
    expect(harness.tools().map((tool) => tool.name)).toEqual(['SuggestNextSteps']);
  });
});

describe('questions', () => {
  it('accepts only well-formed results and tells the model how the form ended', () => {
    expect(parseAskResult({ results: [{ question: 'Q?', outcome: 'skipped' }] })).toBeUndefined();
    expect(parseAskResult({ results: 'x' })).toBeUndefined();
    const answered = parseAskResult({
      results: [
        { question: 'DB?', outcome: 'answered', selected: ['SQLite'] },
        { question: 'Name?', outcome: 'answered', other: 'PiArc' },
      ],
    });
    if (answered === undefined) throw new Error('rejected');
    expect(askResultText(answered)).toBe(
      'The user answered.\n' +
        JSON.stringify({
          answers: [
            { question: 'DB?', outcome: 'answered', selected: ['SQLite'] },
            { question: 'Name?', outcome: 'answered', selected: [], other: 'PiArc' },
          ],
        }),
    );
    const late = parseAskResult({
      results: [
        { question: 'DB?', outcome: 'default', selected: ['SQLite'] },
        { question: 'Name?', outcome: 'unanswered' },
      ],
    });
    if (late === undefined) throw new Error('rejected');
    expect(askResultText(late)).toMatch(/^The form timed out/);
    expect(askResultText(late)).toContain('"outcome":"unanswered"');
    const closed = parseAskResult({
      results: [{ question: 'DB?', outcome: 'declined' }],
      feedback: 'Later',
    });
    if (closed === undefined) throw new Error('rejected');
    expect(askResultText(closed)).toMatch(/^The user closed the form/);
    expect(askResultText(closed)).toContain('"feedback":"Later"');
  });
});
