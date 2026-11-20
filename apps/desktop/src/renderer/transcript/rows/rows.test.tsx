// @vitest-environment happy-dom
// T19-A01, A02: every P0 row type through the real row dispatcher (RowView), fed by the session
// store with Core-shaped notifications; the thinking block stays open while it is generated and
// folds to "thought for N seconds" afterwards.
import type { Item } from '@piarc/protocol';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DEFAULT_PREFERENCES } from '../../../shared/preferences.js';
import { AppProvider } from '../../app/app-context.js';
import { AppStore } from '../../store/app-store.js';
import { SessionTranscript, WORKING_ROW } from '../../store/transcript.js';
import { HighlightClient } from '../highlight/highlight-client.js';
import { IncrementalMarkdown, parseMarkdown } from '../markdown/incremental.js';
import { MarkdownClient } from '../markdown/markdown-client.js';
import type { MarkdownRequest } from '../markdown/protocol.js';
import { RowHeights } from '../row-heights.js';
import {
  Expansion,
  TranscriptContext,
  type TranscriptActions,
  type TranscriptServices,
} from '../services.js';
import { StreamingDriver } from '../streaming-driver.js';
import { RowView } from './RowView.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** A Markdown "worker" that parses on the spot, like the real worker does off the thread. */
class InlineMarkdown {
  private listener: ((event: MessageEvent) => void) | undefined;
  private readonly streams = new Map<string, IncrementalMarkdown>();

  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listener = listener;
  }

  postMessage(message: MarkdownRequest): void {
    const reply = (data: unknown): void => {
      queueMicrotask(() => this.listener?.({ data } as MessageEvent));
    };
    if (message.type === 'parse') {
      reply({
        type: 'updates',
        updates: message.docs.map((doc) => ({
          docId: doc.docId,
          keep: 0,
          blocks: parseMarkdown(doc.text),
          final: true,
        })),
      });
    } else if (message.type === 'append') {
      const doc = this.streams.get(message.docId) ?? new IncrementalMarkdown();
      this.streams.set(message.docId, doc);
      const { keep, blocks } = doc.append(message.chunk, message.final);
      reply({
        type: 'updates',
        updates: [{ docId: message.docId, keep, blocks, final: message.final }],
      });
    }
  }
}

function services(): TranscriptServices {
  const markdown = new MarkdownClient(new InlineMarkdown());
  return {
    markdown,
    highlight: new HighlightClient({
      postMessage: () => undefined,
      addEventListener: () => undefined,
    }),
    driver: new StreamingDriver(markdown, {
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => undefined,
    }),
    heights: new RowHeights(),
    expansion: new Expansion(),
    renderCounter: null,
  };
}

let unmount: (() => void) | undefined;

beforeAll(() => {
  Object.assign(window, { piarc: { onAppEvent: () => () => undefined } });
});

afterEach(() => {
  unmount?.();
  unmount = undefined;
});

const actions: TranscriptActions = { retry: vi.fn(), resend: vi.fn() };

async function render(
  transcript: SessionTranscript,
  ids: readonly string[],
  shared = services(),
  rowActions: TranscriptActions = actions,
): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const node: ReactNode = (
    <AppProvider
      initial={{
        platform: 'darwin',
        preferences: { ...DEFAULT_PREFERENCES, language: 'en' },
        locale: 'en',
        focused: true,
      }}
    >
      <TranscriptContext.Provider value={{ services: shared, transcript, actions: rowActions }}>
        {ids.map((id) => (
          <RowView key={id} id={id} />
        ))}
      </TranscriptContext.Provider>
    </AppProvider>
  );
  await act(async () => {
    root.render(node);
    await Promise.resolve();
  });
  // Let the inline Markdown "worker" answer.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  unmount = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };
  return container;
}

let seq = 0;
function note(method: string, params: Record<string, unknown>, ts = 0) {
  seq += 1;
  return { method, params: { sessionId: 's', seq, ts, ...params } };
}

function transcriptOf(
  items: readonly { item: Item; ts?: number; end?: number }[],
): SessionTranscript {
  const transcript = new SessionTranscript();
  transcript.apply(
    items.flatMap(({ item, ts = 0, end }) =>
      end === undefined
        ? [note('item/started', { turnId: 't1', item }, ts)]
        : [
            note('item/started', { turnId: 't1', item: { ...item, status: 'inProgress' } }, ts),
            note('item/completed', { turnId: 't1', item }, end),
          ],
    ),
  );
  return transcript;
}

const byTestId = (root: HTMLElement, id: string): HTMLElement => {
  const element = root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (element === null) {
    throw new Error(`no ${id}`);
  }
  return element;
};

describe('P0 row types', () => {
  it('switches between histories with identical entry ids without showing the other reply', async () => {
    const store = new AppStore();
    const shared = services();
    const entryId = 'deadbeef';
    const itemId = entryId + '#0';
    const show = async (session: string, text: string) => {
      const transcript = store.transcript(session);
      transcript.load([
        { entryId, item: { type: 'agentMessage', itemId, status: 'completed', text } },
      ]);
      const root = await render(transcript, [itemId], shared);
      const message = byTestId(root, 'agent-message');
      expect(message.dataset.parsed).toBe('final');
      expect(message.querySelector('p')?.textContent).toBe(text);
      unmount?.();
      unmount = undefined;
    };
    await show('one', 'Only in the first transcript');
    await show('two', 'Only in the other transcript');
    await show('one', 'Only in the first transcript');
  });

  it('user message: text with mention chips and attachment chips', async () => {
    const item: Item = {
      type: 'userMessage',
      itemId: 'u1',
      status: 'completed',
      text: 'Look at @src/app/main.ts please',
      mentions: [{ path: 'src/app/main.ts', start: 8, end: 24 }],
      attachments: [
        {
          kind: 'image',
          name: 'shot.png',
          mimeType: 'image/png',
          blob: { path: '/b/1.png', sha256: 'a', size: 2048 },
        },
        {
          kind: 'pdf',
          name: 'spec.pdf',
          mimeType: 'application/pdf',
          blob: { path: '/b/2.pdf', sha256: 'b', size: 9 },
          pageCount: 3,
        },
      ],
    };
    const root = await render(transcriptOf([{ item }]), ['u1']);
    const chip = byTestId(root, 'mention-chip');
    expect(chip.textContent).toBe('@main.ts');
    expect(chip.dataset.path).toBe('src/app/main.ts');
    expect(byTestId(root, 'user-message').textContent).toContain('Look at @main.ts please');
    const chips = [...root.querySelectorAll('[data-testid="attachment-chip"]')].map(
      (c) => c.textContent,
    );
    expect(chips).toEqual(['IMGImage shot.png, 2.0 KB', 'PDFPDF spec.pdf, 3 pages']);
  });

  it('user message not delivered: the reason and a resend button', async () => {
    const transcript = new SessionTranscript();
    transcript.addOptimistic('c1', { text: 'Hello', mentions: [], attachments: [] });
    transcript.markUndelivered('c1', 'the app is offline');
    const root = await render(transcript, ['optimistic:c1']);
    expect(byTestId(root, 'undelivered').textContent).toContain(
      'Not delivered: the app is offline',
    );
    act(() => {
      byTestId(root, 'resend').click();
    });
    expect(actions.resend).toHaveBeenCalledWith('c1');
  });

  it('reply: Markdown with raw HTML as text and both copy forms', async () => {
    const item: Item = {
      type: 'agentMessage',
      itemId: 'm1',
      status: 'completed',
      text: '**Done** <img src=x onerror="alert(1)">',
    };
    const root = await render(transcriptOf([{ item }]), ['m1']);
    const message = byTestId(root, 'agent-message');
    expect(message.dataset.parsed).toBe('final');
    expect(message.querySelector('strong')?.textContent).toBe('Done');
    expect(message.querySelector('img')).toBeNull();
    expect(message.textContent).toContain('<img src=x onerror="alert(1)">');
    const labels = [...byTestId(root, 'message-actions').querySelectorAll('button')].map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(['Copy Markdown', 'Copy text', 'Select turn']);
  });

  it('thinking: open and not collapsible while generated, folded with its duration after', async () => {
    const live = transcriptOf([
      { item: { type: 'reasoning', itemId: 'th', status: 'inProgress', text: 'pondering' } },
    ]);
    let root = await render(live, ['th']);
    let block = byTestId(root, 'thinking-block');
    expect(block.dataset.expanded).toBe('true');
    expect(byTestId(root, 'thinking-label').textContent).toBe('Thinking…');
    act(() => {
      byTestId(root, 'thinking-toggle').click();
    });
    expect(byTestId(root, 'thinking-block').dataset.expanded).toBe('true');
    expect(byTestId(root, 'thinking-text').textContent).toBe('pondering');
    unmount?.();

    const done = transcriptOf([
      {
        item: { type: 'reasoning', itemId: 'th', status: 'completed', text: 'pondering' },
        ts: 1_000,
        end: 4_400,
      },
    ]);
    root = await render(done, ['th']);
    block = byTestId(root, 'thinking-block');
    expect(block.dataset.expanded).toBe('false');
    expect(byTestId(root, 'thinking-label').textContent).toBe('Thought for 3 seconds');
    expect(root.querySelector('[data-testid="thinking-text"]')).toBeNull();
    act(() => {
      byTestId(root, 'thinking-toggle').click();
    });
    expect(byTestId(root, 'thinking-text').textContent).toBe('pondering');
  });

  it('tool group: verb + object + line counts, expanding to its calls and diffs', async () => {
    const transcript = transcriptOf([
      {
        item: {
          type: 'dynamicToolCall',
          itemId: 'r1',
          status: 'completed',
          tool: 'Read',
          arguments: { path: 'a.ts' },
          output: 'one\ntwo',
        },
      },
      {
        item: {
          type: 'dynamicToolCall',
          itemId: 'r2',
          status: 'completed',
          tool: 'Read',
          arguments: { path: 'b.ts' },
        },
      },
      {
        item: {
          type: 'fileChange',
          itemId: 'e1',
          status: 'completed',
          tool: 'Edit',
          arguments: {},
          path: 'src/a.ts',
          diff: {
            path: 'src/a.ts',
            added: 1,
            removed: 1,
            unified: '',
            hunks: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: [
                  { kind: 'removed', text: 'old line' },
                  { kind: 'added', text: 'new line' },
                ],
              },
            ],
          },
        },
      },
    ]);
    expect(transcript.rowIds()).toEqual(['group:r1']);
    const root = await render(transcript, ['group:r1']);
    expect(byTestId(root, 'tool-summary').textContent).toBe('Read 2 files · Edited a.ts');
    expect(byTestId(root, 'tool-lines').textContent).toBe('+1 −1');
    act(() => {
      byTestId(root, 'tool-group-toggle').click();
    });
    expect(root.querySelectorAll('[data-testid="tool-call"]')).toHaveLength(2);
    const card = byTestId(root, 'file-change-card');
    expect(byTestId(card, 'file-change-path').textContent).toBe('src/a.ts');
    expect(
      [...card.querySelectorAll('.diff-line')].map((l) => l.getAttribute('data-kind')),
    ).toEqual(['removed', 'added']);
  });

  it('bash card: command, directory, semantic status, exit code and the saved output', async () => {
    const item: Item = {
      type: 'commandExecution',
      itemId: 'b1',
      status: 'failed',
      tool: 'Bash',
      arguments: {},
      command: 'npm test',
      output: 'FAIL',
      execution: {
        cwd: '/work/space 工作区',
        exitCode: 1,
        outcome: 'failure',
        durationMs: 2300,
        timedOut: false,
        timeoutMs: 120_000,
        truncated: true,
        fullOutputPath: '~/data/sessions/s/tmp/tool-results/b1.txt',
      },
    };
    const root = await render(transcriptOf([{ item }]), ['b1']);
    const card = byTestId(root, 'bash-card');
    expect(card.dataset.outcome).toBe('failure');
    expect(byTestId(root, 'bash-command').textContent).toBe('$ npm test');
    expect(byTestId(root, 'bash-cwd').textContent).toBe('in /work/space 工作区');
    expect(byTestId(root, 'bash-state').textContent).toBe('Failed');
    expect(byTestId(root, 'bash-exit').textContent).toBe('exit 1');
    expect(byTestId(root, 'bash-truncated').textContent).toContain('b1.txt');
  });

  it('bash card: a command that runs on in the background (T32)', async () => {
    const item: Item = {
      type: 'commandExecution',
      itemId: 'b3',
      status: 'completed',
      tool: 'Bash',
      arguments: {},
      command: 'npm run dev',
      output: '',
      execution: {
        cwd: '/work',
        outcome: 'success',
        durationMs: 120_004,
        timedOut: true,
        timeoutMs: 120_000,
        truncated: false,
        task: { taskId: 'bg-0a1b2c3d4e5f', outputPath: '~/t.log', reason: 'timeout' },
      },
    };
    const root = await render(transcriptOf([{ item }]), ['b3']);
    expect(byTestId(root, 'bash-state').textContent).toBe('In the background');
    expect(byTestId(root, 'bash-task').textContent).toBe(
      'Still running after its 120 s timeout: moved to the background as task bg-0a1b2c3d4e5f',
    );
    expect(root.textContent).not.toContain('Stopped after its');
  });

  it('bash card: a timer once a command runs longer than ten seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      vi.setSystemTime(100_000);
      const item: Item = {
        type: 'commandExecution',
        itemId: 'b2',
        status: 'inProgress',
        tool: 'Bash',
        arguments: {},
        command: 'sleep 60',
      };
      const root = await render(transcriptOf([{ item, ts: 95_000 }]), ['b2']);
      expect(byTestId(root, 'bash-state').textContent).toBe('Running');
      act(() => {
        vi.advanceTimersByTime(7_000);
      });
      expect(byTestId(root, 'bash-state').textContent).toBe('Running · 12 s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('compaction notice: reason and tokens before and after', async () => {
    const item: Item = {
      type: 'contextCompaction',
      itemId: 'c1',
      status: 'completed',
      reason: 'manual',
      tokensBefore: 120_000,
      tokensAfter: 8_000,
    };
    const root = await render(transcriptOf([{ item }]), ['c1']);
    expect(byTestId(root, 'compaction-row').textContent).toBe(
      'Conversation compacted (requested): 120,000 → 8,000 tokens',
    );
  });

  it('error card: Core’s kind, retry only when retryable', async () => {
    const transcript = new SessionTranscript();
    transcript.apply([
      note('turn/completed', {
        turnId: 't1',
        status: 'failed',
        errorMessage: '429',
        errorKind: 'rateLimit',
        retryable: true,
      }),
      note('turn/completed', {
        turnId: 't2',
        status: 'failed',
        errorMessage: '401',
        errorKind: 'auth',
        retryable: false,
      }),
      note('session/uncertain', { turnId: 't3' }),
    ]);
    const root = await render(transcript, ['error:t1', 'error:t2', 'uncertain:t3']);
    const [limit, auth] = [...root.querySelectorAll<HTMLElement>('[data-testid="error-card"]')];
    expect(limit?.dataset.kind).toBe('rateLimit');
    expect(limit?.querySelector('[data-testid="error-title"]')?.textContent).toBe(
      'Rate limit reached',
    );
    act(() => {
      limit?.querySelector<HTMLElement>('[data-testid="error-retry"]')?.click();
    });
    expect(actions.retry).toHaveBeenCalledWith('t1');
    expect(auth?.querySelector('[data-testid="error-retry"]')).toBeNull();
    expect(auth?.textContent).toContain('Authentication failed');
    expect(byTestId(root, 'uncertain-card').textContent).toContain(
      'Connection interrupted, the turn’s outcome is unknown',
    );
  });

  it('working row: current tool, elapsed time, tokens, retry n / max, compaction', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      vi.setSystemTime(10_000);
      const transcript = new SessionTranscript();
      transcript.apply([
        note('turn/started', { turnId: 't1' }, 3_000),
        note('item/started', {
          turnId: 't1',
          item: {
            type: 'dynamicToolCall',
            itemId: 'g1',
            status: 'inProgress',
            tool: 'Grep',
            arguments: { pattern: 'TODO' },
          },
        }),
        note('turn/usage', {
          turnId: 't1',
          usage: {
            inputTokens: 1,
            outputTokens: 1234,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cost: 0,
          },
        }),
        note('turn/retrying', {
          turnId: 't1',
          attempt: 1,
          maxAttempts: 3,
          delayMs: 5,
          errorMessage: 'x',
        }),
      ]);
      const root = await render(transcript, [WORKING_ROW]);
      expect(byTestId(root, 'working-activity').textContent).toBe('Grep · TODO');
      expect(byTestId(root, 'working-elapsed').textContent).toBe('7 s');
      expect(byTestId(root, 'working-tokens').textContent).toBe('1,234 tokens');
      expect(byTestId(root, 'working-retry').textContent).toBe('Retrying 1/3');
      act(() => {
        transcript.apply([
          note('item/started', {
            turnId: 't1',
            item: { type: 'contextCompaction', itemId: 'cc', status: 'inProgress' },
          }),
        ]);
      });
      expect(byTestId(root, 'working-activity').textContent).toBe('Compacting the conversation');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a row that fails to render is contained to that row (I50)', async () => {
    const transcript = transcriptOf([
      { item: { type: 'agentMessage', itemId: 'ok', status: 'completed', text: 'fine' } },
    ]);
    // A user message whose mentions are not an array makes the row throw.
    transcript.apply([
      note('item/completed', {
        turnId: 't1',
        item: { type: 'userMessage', itemId: 'bad', status: 'completed', text: 'x', mentions: 7 },
      }),
    ]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const root = await render(transcript, ['bad', 'ok']);
    spy.mockRestore();
    expect(byTestId(root, 'row-failed').textContent).toBe(
      'This part of the conversation could not be shown.',
    );
    expect(byTestId(root, 'agent-message').textContent).toContain('fine');
  });
});

it('renders the five ledger card kinds, keeps approvals through a history reload, and removes invalidated requests', async () => {
  const store = new AppStore();
  const request = {
    sessionId: 's',
    revision: 1,
    connectionEpoch: 2,
    requestId: 'file',
    tool: 'Edit',
  };
  const approvals = [
    {
      ...request,
      kind: 'fileChange',
      path: '.piarc/settings.json',
      protectedPath: true,
      diff: {
        path: '.piarc/settings.json',
        unified: '+new',
        added: 1,
        removed: 0,
        hunks: [
          {
            oldStart: 1,
            newStart: 1,
            oldLines: 0,
            newLines: 1,
            lines: [{ text: 'new', kind: 'added' }],
          },
        ],
      },
    },
    {
      ...request,
      requestId: 'bash',
      tool: 'Bash',
      kind: 'command',
      command: 'echo first',
      cwd: '/project',
    },
    {
      ...request,
      requestId: 'outside',
      tool: 'Read',
      kind: 'permissionExpansion',
      path: '../a',
      directory: '/other',
    },
    {
      ...request,
      requestId: 'form',
      tool: 'AskUserQuestion',
      kind: 'question',
      questions: [
        {
          question: 'Which database?',
          options: [{ label: 'SQLite', description: 'One file' }, { label: 'Postgres' }],
        },
      ],
    },
    { ...request, requestId: 'plan', tool: 'ExitPlanMode', kind: 'plan', plan: '1. Fix it' },
  ];
  store.applySessions({ revision: 1, sessions: [{ id: 's', approvals, pendingApprovals: 5 }] });
  const transcript = store.transcript('s');
  transcript.load([], 0);
  const root = await render(transcript, transcript.rowIds());
  expect(root.querySelectorAll('[data-approval-card]')).toHaveLength(5);
  const form = root.querySelector('[data-approval-card="question"]');
  expect(form?.textContent).toContain('Which database?');
  expect(form?.querySelectorAll('input[type="radio"]')).toHaveLength(3);
  expect(form?.textContent).toContain('Other');
  expect(root.querySelector('[data-approval-card="plan"]')?.textContent).toContain('1. Fix it');
  expect(root.querySelector('[data-approval-card="fileChange"]')?.textContent).not.toContain(
    'Always allow',
  );
  expect(root.querySelector('.diff-line.is-added')?.textContent).toContain('new');
  expect(root.querySelector('[data-approval-card="command"]')?.textContent).toContain('echo first');
  expect(root.querySelector('[data-approval-card="permissionExpansion"]')?.textContent).toContain(
    '/other',
  );
  act(() => {
    store.applySessions({
      revision: 2,
      sessions: [{ id: 's', approvals: [], pendingApprovals: 0 }],
    });
  });
  expect(root.querySelectorAll('[data-approval-card]')).toHaveLength(0);
});

it('gives host tools rows of their own: task list, plan, answers and next steps (T26)', async () => {
  const transcript = new SessionTranscript();
  const call = (itemId: string, tool: string, args: Record<string, unknown>, output?: string) => ({
    entryId: `e-${itemId}`,
    item: {
      type: 'dynamicToolCall' as const,
      itemId,
      status: 'completed' as const,
      tool,
      arguments: args,
      ...(output === undefined ? {} : { output }),
    },
  });
  transcript.load(
    [
      call('enter', 'EnterPlanMode', {}),
      call('todo', 'TodoWrite', {
        todos: [
          { content: 'Read', status: 'completed' },
          { content: 'Fix', status: 'in_progress', activeForm: 'Fixing' },
          { content: 'Docs', status: 'pending' },
        ],
      }),
      call('plan', 'ExitPlanMode', { plan: '1. Fix\n2. Test' }),
      call(
        'ask',
        'AskUserQuestion',
        { questions: [] },
        'The user answered.\n{"answers":[{"question":"DB?","outcome":"answered","selected":["SQLite"]}]}',
      ),
      call('next', 'SuggestNextSteps', {
        suggestions: [{ title: 'Run tests', prompt: 'Run the whole suite.' }],
      }),
    ],
    0,
  );
  const root = await render(transcript, transcript.rowIds());
  // Only EnterPlanMode stays in a tool group.
  expect(root.querySelectorAll('[data-testid="tool-group"]')).toHaveLength(1);
  const tasks = [...root.querySelectorAll('[data-testid="task"]')];
  expect(tasks.map((t) => t.getAttribute('data-status'))).toEqual([
    'completed',
    'inProgress',
    'pending',
  ]);
  expect(tasks[1]?.textContent).toContain('Fixing');
  expect(root.querySelector('[data-testid="task-count"]')?.textContent).toBe('1/3 done');
  expect(root.querySelector('[data-testid="plan-row"]')?.getAttribute('data-status')).toBe(
    'approved',
  );
  expect(root.querySelector('[data-testid="plan-row"]')?.textContent).toContain('1. Fix');
  expect(root.querySelector('[data-testid="question-row"]')?.textContent).toContain('SQLite');
  const next = root.querySelector('[data-testid="next-steps"]');
  expect(next?.textContent).toContain('Run tests');
  // Outside the window shell (the prototype page) the suggestions have no actions.
  expect(next?.querySelector('[data-testid="next-run-here"]')).toBeNull();
});

describe('subagent card (T31-A13)', () => {
  const state = {
    sessionId: 'child-1',
    agentType: 'Explore',
    description: 'Find the parser',
    color: 'green',
    model: { provider: 'mock-child', id: 'fast-model' },
    status: 'running',
    startedAt: 1_000,
    toolCalls: 2,
    tokens: { input: 900, output: 120, cacheRead: 100, cacheWrite: 0 },
    activity: 'Grep parser',
    warnings: [{ kind: 'aliasFallback', value: 'fast' }],
  };
  const call: Item = {
    type: 'subagent',
    itemId: 'agent-1',
    status: 'inProgress',
    tool: 'Agent',
    arguments: { description: 'Find the parser', prompt: 'Where is it?' },
    description: 'Find the parser',
  };

  it('shows the type, model, status, time, tool calls and warnings, and follows subagent/*', async () => {
    const transcript = transcriptOf([{ item: call }]);
    transcript.apply([note('subagent/started', { itemId: 'agent-1', subagent: state })]);
    const stop = vi.fn();
    const root = await render(transcript, ['agent-1'], services(), {
      ...actions,
      stopSubagent: stop,
      subagentTranscript: () => Promise.resolve('{"start":0,"total":0,"items":[]}'),
    });
    const card = byTestId(root, 'subagent-card');
    expect(card.dataset.status).toBe('running');
    expect(byTestId(root, 'subagent-title').textContent).toBe('Find the parser');
    expect(byTestId(root, 'subagent-type').textContent).toBe('Explore');
    expect(byTestId(root, 'subagent-model').textContent).toBe('Model mock-child/fast-model');
    expect(byTestId(root, 'subagent-tools').textContent).toBe('2 tool calls');
    expect(byTestId(root, 'subagent-tokens').textContent).toBe('1000 tokens in · 120 out');
    expect(byTestId(root, 'subagent-activity').textContent).toBe('Grep parser');
    expect(byTestId(root, 'subagent-warnings').textContent).toContain('The model alias fast');
    act(() => {
      byTestId(root, 'subagent-stop').click();
    });
    expect(stop).toHaveBeenCalledWith('child-1');
    await act(async () => {
      transcript.apply([
        note('subagent/completed', {
          itemId: 'agent-1',
          subagent: { ...state, status: 'completed', durationMs: 65_000, toolCalls: 3 },
        }),
      ]);
      await Promise.resolve();
    });
    expect(card.dataset.status).toBe('completed');
    expect(byTestId(root, 'subagent-status').textContent).toBe('Done');
    expect(byTestId(root, 'subagent-tools').textContent).toBe('3 tool calls');
    expect(byTestId(root, 'subagent-facts').textContent).toContain('1 min 5 s');
    expect(root.querySelector('[data-testid="subagent-stop"]')).toBeNull();
  });

  it('keeps a finished background run when its call completes afterwards', async () => {
    const transcript = transcriptOf([{ item: call }]);
    const background = { ...state, background: true };
    transcript.apply([
      note('subagent/completed', {
        itemId: 'agent-1',
        subagent: { ...background, status: 'completed' },
      }),
      note('item/completed', {
        turnId: 't1',
        item: { ...call, status: 'completed', subagent: background },
      }),
    ]);
    const root = await render(transcript, ['agent-1']);
    expect(byTestId(root, 'subagent-card').dataset.status).toBe('completed');
    expect(byTestId(root, 'subagent-background').textContent).toBe('Background');
  });

  it('keeps an interrupted run when its call fails without a run state', async () => {
    // A stopped or failed run ends its Agent call with an error result, which carries no run
    // state: the state the notifications gave stays.
    const transcript = transcriptOf([{ item: call }]);
    transcript.apply([
      note('subagent/started', { itemId: 'agent-1', subagent: state }),
      note('subagent/completed', {
        itemId: 'agent-1',
        subagent: { ...state, status: 'interrupted', durationMs: 4_000 },
      }),
      note('item/completed', { turnId: 't1', item: { ...call, status: 'failed' } }),
    ]);
    const root = await render(transcript, ['agent-1']);
    expect(byTestId(root, 'subagent-card').dataset.status).toBe('interrupted');
    expect(byTestId(root, 'subagent-status').textContent).toBe('Interrupted');
  });

  it("expands to the subagent's own transcript, read-only", async () => {
    const transcript = transcriptOf([{ item: { ...call, subagent: state } as Item }]);
    const read = vi.fn((child: string) =>
      Promise.resolve(
        JSON.stringify({
          start: 0,
          total: 2,
          items: [
            {
              entryId: 'u1',
              item: {
                type: 'userMessage',
                itemId: 'u1',
                status: 'completed',
                text: 'Where is it?',
              },
            },
            {
              entryId: 'a1',
              item: {
                type: 'agentMessage',
                itemId: 'a1',
                status: 'completed',
                text: `Report of ${child}`,
              },
            },
          ],
        }),
      ),
    );
    const root = await render(transcript, ['agent-1'], services(), {
      ...actions,
      subagentTranscript: read,
    });
    await act(async () => {
      byTestId(root, 'subagent-toggle').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(read).toHaveBeenCalledWith('child-1', null, 200);
    const child = byTestId(root, 'subagent-transcript');
    expect(child.textContent).toContain('Where is it?');
    expect(child.textContent).toContain('Report of child-1');
    // Read-only: no rewind or branch actions on the child's messages.
    expect(child.querySelector('[data-testid="user-message-actions"]')).toBeNull();
  });

  it('labels an approval card that comes from a subagent', async () => {
    const store = new AppStore();
    store.applySessions({
      revision: 1,
      sessions: [
        {
          id: 's',
          pendingApprovals: 1,
          approvals: [
            {
              sessionId: 'child-1',
              requestId: 'r1',
              revision: 1,
              connectionEpoch: 1,
              tool: 'Bash',
              kind: 'command',
              command: 'env echo hi',
              subagent: {
                sessionId: 'child-1',
                parentSessionId: 's',
                agentType: 'runner',
                description: 'Print lines',
              },
            },
          ],
        },
      ],
    });
    const transcript = store.transcript('s');
    const id = transcript.rowIds().find((row) => row.startsWith('approval:'));
    expect(id).toBeDefined();
    const root = await render(transcript, [id ?? '']);
    expect(byTestId(root, 'approval-origin').textContent).toBe(
      'From subagent: Print lines (runner)',
    );
  });
});
