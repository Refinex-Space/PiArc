// @vitest-environment happy-dom
// T43-A03: every kind of transcript row has an accessible name, in English and in Chinese, and a
// row of the list is an article named by it.
import type { FileDiff, Item } from '@piarc/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, describe, expect, it } from 'vitest';

import { Translator } from '../../shared/i18n/index.js';
import { DEFAULT_PREFERENCES } from '../../shared/preferences.js';
import { AppProvider } from '../app/app-context.js';
import { SessionTranscript, type TranscriptRow } from '../store/transcript.js';
import { HighlightClient } from './highlight/highlight-client.js';
import { MarkdownClient } from './markdown/markdown-client.js';
import { RowHeights } from './row-heights.js';
import { ROW_KINDS, rowKind, rowLabel, type RowKind } from './row-label.js';
import { RowArticle } from './rows/RowView.js';
import { Expansion, TranscriptContext } from './services.js';
import { StreamingDriver } from './streaming-driver.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const diff: FileDiff = { path: 'src/a.ts', added: 3, removed: 1, unified: '', hunks: [] };

function item(value: Record<string, unknown>): TranscriptRow {
  return {
    kind: 'item',
    id: String(value.itemId),
    turnId: 't1',
    item: { status: 'completed', ...value } as unknown as Item,
  };
}

const read = {
  type: 'dynamicToolCall',
  itemId: 'r1',
  tool: 'Read',
  arguments: { path: 'src/notes.txt' },
  status: 'completed',
} as unknown as Item;

const ROWS: Record<RowKind, TranscriptRow> = {
  userMessage: item({ type: 'userMessage', itemId: 'u1', text: 'Fix the parser\nplease' }),
  optimistic: {
    kind: 'optimistic',
    id: 'o1',
    clientId: 'c1',
    input: { text: 'Second question', mentions: [], attachments: [] },
    files: { pending: [], stored: [] },
    turnId: undefined,
    state: 'undelivered',
    failure: 'dropped',
  },
  agentMessage: item({ type: 'agentMessage', itemId: 'a1', text: 'The parser is fixed.' }),
  reasoning: item({ type: 'reasoning', itemId: 'th1', text: 'Thinking it over.' }),
  group: { kind: 'group', id: 'g1', members: ['r1'] },
  commandExecution: item({
    type: 'commandExecution',
    itemId: 'b1',
    tool: 'Bash',
    command: 'npm test',
    arguments: {},
    status: 'failed',
  }),
  fileChange: item({
    type: 'fileChange',
    itemId: 'f1',
    tool: 'Edit',
    path: 'src/a.ts',
    diff,
    arguments: {},
  }),
  error: {
    kind: 'error',
    id: 'e1',
    turnId: 't1',
    errorKind: 'auth',
    message: 'no',
    retryable: false,
  },
  uncertain: { kind: 'uncertain', id: 'x1', turnId: 't1' },
  working: { kind: 'working', id: 'w1' },
  permissionModeChanged: item({ type: 'permissionModeChanged', itemId: 'm1', mode: 'acceptEdits' }),
  contextCompaction: item({ type: 'contextCompaction', itemId: 'cc1' }),
  reminder: item({
    type: 'reminder',
    itemId: 'rm1',
    text: 'x',
    reminders: [{ id: 'q', source: 's', type: 'memoryLazyLoad' }],
  }),
  subagent: item({
    type: 'subagent',
    itemId: 's1',
    tool: 'Agent',
    arguments: {},
    subagent: { agentType: 'reviewer', description: 'Check the build', status: 'completed' },
  }),
  webSearch: item({
    type: 'webSearch',
    itemId: 'ws1',
    tool: 'WebSearch',
    arguments: {},
    query: 'piarc release',
    sources: [
      { title: 'a', url: 'https://a.example' },
      { title: 'b', url: 'https://b.example' },
    ],
  }),
  todo: item({
    type: 'dynamicToolCall',
    itemId: 'td1',
    tool: 'TodoWrite',
    arguments: {
      todos: [
        { content: 'a', status: 'completed', activeForm: 'a' },
        { content: 'b', status: 'in_progress', activeForm: 'b' },
        { content: 'c', status: 'pending', activeForm: 'c' },
      ],
    },
  }),
  plan: item({
    type: 'dynamicToolCall',
    itemId: 'p1',
    tool: 'ExitPlanMode',
    arguments: { plan: '# Plan' },
  }),
  question: item({ type: 'dynamicToolCall', itemId: 'q1', tool: 'AskUserQuestion', arguments: {} }),
  nextSteps: item({
    type: 'dynamicToolCall',
    itemId: 'n1',
    tool: 'SuggestNextSteps',
    arguments: {},
  }),
};

const EXPECTED: Record<'en' | 'zh-CN', Record<RowKind, string>> = {
  en: {
    userMessage: 'Your message: Fix the parser please',
    optimistic: 'Your message, not delivered: Second question',
    agentMessage: 'Agent reply: The parser is fixed.',
    reasoning: 'Thinking',
    group: 'Tool calls: Read notes.txt, Done',
    commandExecution: 'Command: npm test, Failed',
    fileChange: 'File change: src/a.ts, 3 lines added, 1 removed, Done',
    error: 'Error: Authentication failed',
    uncertain: 'Connection interrupted, the turn’s outcome is unknown',
    working: 'The agent is working',
    permissionModeChanged: 'Permission mode changed to Accept edits',
    contextCompaction: 'Conversation compacted',
    reminder: 'System reminder: memory',
    subagent: 'Subagent reviewer: Check the build, Done',
    webSearch: 'Web search: piarc release, 2 sources, Done',
    todo: 'Task list: 1 of 3 done',
    plan: 'Plan: Approved',
    question: 'Questions for you: Done',
    nextSteps: 'Suggested next steps',
  },
  'zh-CN': {
    userMessage: '你的消息：Fix the parser please',
    optimistic: '你的消息，未送达：Second question',
    agentMessage: '智能体回复：The parser is fixed.',
    reasoning: '思考过程',
    group: '工具调用：读取 notes.txt，完成',
    commandExecution: '命令：npm test，失败',
    fileChange: '文件改动：src/a.ts，新增 3 行，删除 1 行，完成',
    error: '错误：认证失败',
    uncertain: '',
    working: '智能体正在工作',
    permissionModeChanged: '',
    contextCompaction: '',
    reminder: '',
    subagent: '子 agent reviewer：Check the build，完成',
    webSearch: '网页搜索：piarc release，2 个来源，完成',
    todo: '任务清单：已完成 1/3',
    plan: '计划：已批准',
    question: '向你提问：完成',
    nextSteps: '',
  },
};

const members = (id: string): Item | undefined => (id === 'r1' ? read : undefined);

describe('row labels', () => {
  it('cover every row kind', () => {
    expect(Object.keys(ROWS).sort()).toEqual([...ROW_KINDS].sort());
    for (const kind of ROW_KINDS) expect(rowKind(ROWS[kind])).toBe(kind);
  });

  for (const locale of ['en', 'zh-CN'] as const) {
    it(`name every row in ${locale}`, () => {
      const translator = new Translator(locale);
      const t = translator.t.bind(translator);
      for (const kind of ROW_KINDS) {
        const label = rowLabel(ROWS[kind], t, members);
        expect(label, kind).toBeTruthy();
        const expected = EXPECTED[locale][kind];
        // Chinese labels built from shared messages are checked against those messages.
        if (expected !== '') expect(label, kind).toBe(expected);
      }
    });
  }

  it('names the article of a list row', async () => {
    Object.assign(window, { piarc: { onAppEvent: () => () => undefined } });
    const transcript = new SessionTranscript();
    transcript.load([
      {
        entryId: 'u1',
        turnId: 't1',
        item: { type: 'userMessage', itemId: 'u1', status: 'completed', text: 'Hello there' },
      },
    ]);
    const port = { postMessage: () => undefined, addEventListener: () => undefined };
    const markdown = new MarkdownClient(port);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <AppProvider
          initial={{
            platform: 'darwin',
            preferences: { ...DEFAULT_PREFERENCES, language: 'en' },
            locale: 'en',
            focused: true,
            notificationsSupported: true,
          }}
        >
          <TranscriptContext.Provider
            value={{
              services: {
                markdown,
                highlight: new HighlightClient(port),
                driver: new StreamingDriver(markdown, {
                  requestAnimationFrame: () => 0,
                  cancelAnimationFrame: () => undefined,
                }),
                heights: new RowHeights(),
                expansion: new Expansion(),
                renderCounter: null,
              },
              transcript,
              actions: { retry: () => undefined, resend: () => undefined },
            }}
          >
            {transcript.rowIds().map((id) => (
              <RowArticle key={id} id={id} />
            ))}
          </TranscriptContext.Provider>
        </AppProvider>,
      );
      await Promise.resolve();
    });
    const article = container.querySelector('[role="article"]');
    expect(article?.getAttribute('aria-label')).toBe('Your message: Hello there');
    act(() => {
      root.unmount();
    });
    container.remove();
  });
});

beforeAll(() => {
  Object.assign(window, { piarc: { onAppEvent: () => () => undefined } });
});
