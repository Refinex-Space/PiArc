// The session gallery's states (`#/session-gallery`, dev builds only): each section is a set of
// Core notifications and approval requests that puts the production transcript rows into the
// states a reviewer compares (finished, streaming, running, failed, waiting for approval...).
// Test-only: no product feature reads it.
import type { ApprovalRequest, Item } from '@piarc/protocol';

import type { QueuedInput } from '../../store/transcript.js';

/** A Core session notification, as the session store reads it. */
export interface GalleryNote {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface GallerySection {
  readonly notifications: readonly GalleryNote[];
  readonly approvals?: readonly ApprovalRequest[];
  /** The composer shows a running turn. */
  readonly running?: boolean;
  /** A message the user sent that did not reach Core, with the reason. */
  readonly undelivered?: { readonly text: string; readonly reason: string };
  /** Inputs waiting above the composer. */
  readonly queue?: readonly QueuedInput[];
  /** The input's own states: a draft with a mention and attachments, notices, the usage levels. */
  readonly input?: boolean;
}

const SESSION = 'gallery';
let seq = 0;

/** Fixture times below this are offsets from three hours ago; above it, real times. */
const REAL_TIME = 1e12;
const EARLIER = Date.now() - 3 * 3_600_000;

function note(method: string, params: Record<string, unknown>, ts = 0): GalleryNote {
  seq += 1;
  const at = ts < REAL_TIME ? EARLIER + ts : ts;
  return { jsonrpc: '2.0', method, params: { sessionId: SESSION, seq, ts: at, ...params } };
}

function done(turnId: string, item: Item, start = 0, end = start): GalleryNote[] {
  return [
    note('item/started', { turnId, item: { ...item, status: 'inProgress' } }, start),
    note('item/completed', { turnId, item }, end),
  ];
}

function started(turnId: string, item: Item, ts = 0): GalleryNote {
  return note('item/started', { turnId, item }, ts);
}

function turn(turnId: string, ts = 0): GalleryNote {
  return note('turn/started', { turnId }, ts);
}

function ended(turnId: string, ts = 0): GalleryNote {
  return note('turn/completed', { turnId, status: 'completed' }, ts);
}

function user(itemId: string, text: string, extra: Partial<Item> = {}): Item {
  return { type: 'userMessage', itemId, status: 'completed', text, ...extra } as Item;
}

function reply(itemId: string, text: string): Item {
  return { type: 'agentMessage', itemId, status: 'completed', text };
}

function tool(
  itemId: string,
  name: string,
  args: Record<string, unknown>,
  output?: string,
  status: Item['status'] = 'completed',
): Item {
  return {
    type: 'dynamicToolCall',
    itemId,
    status,
    tool: name,
    arguments: args,
    ...(output === undefined ? {} : { output }),
  };
}

const MARKDOWN = [
  '## Release checklist',
  '',
  'The parser now keeps **every** block it has already closed, so a streamed reply only re-parses its tail. Inline `code`, [a link](https://example.com/docs) and *emphasis* stay readable.',
  '',
  '### What changed',
  '',
  '1. The tokenizer reads fenced blocks lazily.',
  '2. Tables keep their column widths while streaming:',
  '   - header cells are measured once',
  '   - body cells wrap at word boundaries',
  '3. Links open through the native confirmation.',
  '',
  '> Quotes keep a quiet rule on the side and use the secondary ink.',
  '',
  '| Step | Owner | Status |',
  '| --- | --- | :---: |',
  '| Parse | Core | Done |',
  '| Render | Renderer | In review |',
  '| Ship | Release | Pending |',
  '',
  '```ts',
  'export function closeBlocks(text: string): Block[] {',
  '  const blocks = tokenize(text);',
  '  return blocks.filter((block) => block.closed);',
  '}',
  '```',
  '',
  '- [x] Unit tests',
  '- [ ] Benchmarks',
  '',
  '---',
  '',
  'The total stays within the budget:',
  '',
  '```math',
  '\\sum_{i=1}^{n} t_i \\le T',
  '```',
  '',
  'That is the whole change.',
].join('\n');

const DIFF = {
  path: 'src/parser/blocks.ts',
  added: 4,
  removed: 2,
  unified: '',
  hunks: [
    {
      oldStart: 12,
      oldLines: 6,
      newStart: 12,
      newLines: 8,
      lines: [
        { kind: 'context' as const, text: 'export function closeBlocks(text: string): Block[] {' },
        { kind: 'removed' as const, text: '  const blocks = parse(text);' },
        { kind: 'removed' as const, text: '  return blocks;' },
        { kind: 'added' as const, text: '  const blocks = tokenize(text);' },
        { kind: 'added' as const, text: '  // Only closed blocks are final.' },
        { kind: 'added' as const, text: '  return blocks.filter((block) => block.closed);' },
        { kind: 'added' as const, text: '' },
        { kind: 'context' as const, text: '}' },
      ],
    },
  ],
};

function approval(request: Partial<ApprovalRequest> & Pick<ApprovalRequest, 'kind' | 'tool'>) {
  return {
    sessionId: SESSION,
    requestId: `req-${request.kind}-${request.tool}`,
    revision: 1,
    connectionEpoch: 1,
    ...request,
  };
}

function conversation(): GallerySection {
  return {
    notifications: [
      turn('t1', 1_000),
      ...done(
        't1',
        user('u1', 'Find where @src/parser/blocks.ts closes blocks and make streaming cheaper.', {
          mentions: [{ start: 11, end: 32, path: 'src/parser/blocks.ts' }],
        }),
      ),
      ...done(
        't1',
        {
          type: 'reasoning',
          itemId: 'r1',
          status: 'completed',
          text: 'The parser re-reads the whole text on each delta. Closed blocks never change, so only the tail needs work.',
        },
        1_000,
        9_000,
      ),
      ...done(
        't1',
        tool('read1', 'Read', { file_path: 'src/parser/blocks.ts' }, 'export function closeBlocks'),
      ),
      ...done('t1', tool('grep1', 'Grep', { pattern: 'closeBlocks' }, 'src/parser/blocks.ts:12')),
      ...done(
        't1',
        reply(
          'a1',
          'The parser re-parses the whole message on every delta. I will keep closed blocks and only re-parse the tail.',
        ),
      ),
      ...done('t1', {
        type: 'fileChange',
        itemId: 'edit1',
        status: 'completed',
        tool: 'Edit',
        path: 'src/parser/blocks.ts',
        arguments: { file_path: 'src/parser/blocks.ts' },
        diff: DIFF,
      }),
      ...done('t1', {
        type: 'commandExecution',
        itemId: 'bash1',
        status: 'completed',
        tool: 'Bash',
        command: 'npm test -- parser',
        arguments: { command: 'npm test -- parser' },
        output:
          ' ✓ src/parser/blocks.test.ts (12 tests) 41ms\n\n Test Files  1 passed (1)\n      Tests  12 passed (12)',
        execution: {
          cwd: '/work/piarc',
          durationMs: 2_400,
          exitCode: 0,
          outcome: 'success',
          timedOut: false,
          timeoutMs: 120_000,
          truncated: false,
        },
      }),
      ...done(
        't1',
        reply('a2', 'Streaming now re-parses only the open tail. All **12** parser tests pass.'),
      ),
      ended('t1', 20_000),
    ],
  };
}

function messages(): GallerySection {
  const long = Array.from(
    { length: 14 },
    (_, line) => `Line ${String(line + 1)} of a long pasted log that the user sent as context.`,
  ).join('\n');
  return {
    notifications: [
      turn('t1'),
      ...done(
        't1',
        user('u1', 'Compare the two screenshots and tell me which layout reads better.', {
          attachments: [
            {
              kind: 'image',
              name: 'layout-a.png',
              mimeType: 'image/png',
              blob: { id: 'b1', size: 182_304 },
            },
            {
              kind: 'pdf',
              name: 'brief.pdf',
              mimeType: 'application/pdf',
              pageCount: 4,
              blob: { id: 'b2', size: 920_000 },
            },
          ],
        } as unknown as Partial<Item>),
      ),
      ...done(
        't1',
        reply(
          'a1',
          'Layout **B** reads better: the primary action sits where the eye ends, and the secondary text no longer competes with the title.\n\nLayout A keeps three equal columns, so nothing leads.',
        ),
      ),
      ended('t1'),
      turn('t2'),
      ...done('t2', user('u2', long)),
      ...done('t2', reply('a2', 'Thanks — the log shows the retry loop starting at line 9.')),
      ended('t2'),
    ],
    undelivered: { text: 'Also check the retry delay.', reason: 'the app is offline' },
  };
}

function markdown(): GallerySection {
  return {
    notifications: [
      turn('t1'),
      ...done('t1', user('u1', 'Summarize the release.')),
      ...done('t1', reply('a1', MARKDOWN)),
      ended('t1'),
    ],
  };
}

/** Mermaid in replies (ADR-0080): drawn, broken, and still streaming. */
function diagram(): GallerySection {
  return {
    notifications: [
      turn('t1'),
      ...done('t1', user('u1', 'Draw the request flow.')),
      ...done(
        't1',
        reply(
          'a1',
          [
            'The request passes the gateway, then the service and its cache:',
            '',
            '```mermaid',
            'flowchart LR',
            '  C[Client] --> G[Gateway]',
            '  G --> S[Service]',
            '  S --> K[(Cache)]',
            '  S --> D[(Database)]',
            '```',
          ].join('\n'),
        ),
      ),
      ...done(
        't1',
        reply(
          'a2',
          [
            'A sequence I got wrong:',
            '',
            '```mermaid',
            'sequenceDiagram',
            '  A->>: hello',
            '```',
          ].join('\n'),
        ),
      ),
      // A fence the reply left open closes at its end (CommonMark): it is drawn too.
      ...done(
        't1',
        reply(
          'a3',
          ['And the retry path:', '', '```mermaid', 'flowchart TD', '  A --> B'].join('\n'),
        ),
      ),
      ended('t1'),
    ],
  };
}

function thinking(): GallerySection {
  return {
    running: true,
    notifications: [
      turn('t1'),
      ...done('t1', user('u1', 'Why is the build slow?')),
      ...done(
        't1',
        {
          type: 'reasoning',
          itemId: 'r1',
          status: 'completed',
          text: 'The build runs the type checker twice: once in the bundler and once in the test step. Caching the first run would halve the time.',
        },
        0,
        14_000,
      ),
      ...done('t1', reply('a1', 'The type checker runs twice. I will cache the first pass.')),
      ended('t1'),
      turn('t2', Date.now() - 6_000),
      ...done('t2', user('u2', 'Do it.')),
      started(
        't2',
        {
          type: 'reasoning',
          itemId: 'r2',
          status: 'inProgress',
          text: 'The bundler already writes a build info file. Pointing the test step at the same file lets it skip unchanged projects…',
        },
        Date.now() - 4_000,
      ),
    ],
  };
}

function tools(): GallerySection {
  return {
    notifications: [
      turn('t1'),
      ...done('t1', user('u1', 'Check the docs and the test output.')),
      ...done('t1', tool('read1', 'Read', { file_path: 'docs/guide.md' }, '# Guide')),
      ...done('t1', tool('read2', 'Read', { file_path: 'docs/api.md' }, '# API')),
      ...done('t1', tool('glob1', 'Glob', { pattern: '**/*.test.ts' }, 'a.test.ts\nb.test.ts')),
      ...done(
        't1',
        tool('fetch1', 'WebFetch', { url: 'https://example.com/changelog' }, 'Changelog'),
      ),
      ...done('t1', reply('a1', 'The docs match. Running the tests:')),
      ...done('t1', {
        type: 'commandExecution',
        itemId: 'bash1',
        status: 'failed',
        tool: 'Bash',
        command: 'npm run test:e2e -- --grep "composer"',
        arguments: { command: 'npm run test:e2e -- --grep "composer"' },
        output:
          '  1 failed\n    composer.e2e.ts:41 › steers a running turn\n  Error: expect(received).toBe(expected)',
        execution: {
          cwd: '/work/piarc/apps/desktop',
          durationMs: 18_600,
          exitCode: 1,
          outcome: 'failure',
          timedOut: false,
          timeoutMs: 120_000,
          truncated: false,
        },
      }),
      ...done('t1', {
        type: 'webSearch',
        itemId: 'search1',
        status: 'completed',
        tool: 'WebSearch',
        query: 'playwright steer composer flaky',
        arguments: { query: 'playwright steer composer flaky' },
        backend: 'native',
        sources: [
          { title: 'Auto-waiting | Playwright', url: 'https://playwright.dev/docs/actionability' },
          { title: 'Keyboard input', url: 'https://playwright.dev/docs/input#keys-and-shortcuts' },
        ],
      }),
      ...done('t1', {
        type: 'fileChange',
        itemId: 'write1',
        status: 'completed',
        tool: 'Write',
        path: 'apps/desktop/e2e/composer.e2e.ts',
        arguments: { file_path: 'apps/desktop/e2e/composer.e2e.ts' },
        diff: { ...DIFF, path: 'apps/desktop/e2e/composer.e2e.ts', created: true },
      }),
      ended('t1'),
    ],
  };
}

function cards(): GallerySection {
  return {
    notifications: [
      turn('t1'),
      ...done('t1', user('u1', 'Plan the parser work and split it up.')),
      // Earlier lists: a line each, naming what changed (UI-14).
      ...done(
        't1',
        tool('todo0', 'TodoWrite', {
          todos: [
            { content: 'Read the parser', status: 'in_progress', activeForm: 'Reading' },
            { content: 'Cache closed blocks', status: 'pending' },
          ],
        }),
      ),
      ...done(
        't1',
        tool('todo1', 'TodoWrite', {
          todos: [
            { content: 'Read the parser', status: 'completed' },
            { content: 'Cache closed blocks', status: 'pending' },
            { content: 'Measure streaming', status: 'pending' },
          ],
        }),
      ),
      ...done(
        't1',
        tool('todo', 'TodoWrite', {
          todos: [
            { content: 'Read the parser', status: 'completed' },
            { content: 'Cache closed blocks', status: 'in_progress', activeForm: 'Caching' },
            { content: 'Measure streaming', status: 'pending' },
          ],
        }),
      ),
      ...done('t1', {
        type: 'subagent',
        itemId: 'agent1',
        status: 'completed',
        tool: 'Agent',
        arguments: { description: 'Find the parser tests', prompt: 'Where are they?' },
        description: 'Find the parser tests',
        subagent: {
          sessionId: 'child-1',
          agentType: 'Explore',
          description: 'Find the parser tests',
          color: 'green',
          model: { provider: 'mock', id: 'fast-model' },
          status: 'completed',
          startedAt: 0,
          durationMs: 38_000,
          toolCalls: 6,
          tokens: { input: 9_200, output: 640, cacheRead: 0, cacheWrite: 0 },
        },
      }),
      ...done(
        't1',
        tool('plan', 'ExitPlanMode', {
          plan: '## Parser cache\n\n1. Cache **closed** blocks in the worker.\n2. Re-parse only the open tail.\n3. Measure with `npm run bench:t19`.\n\n### Risks\n\n- A fence that closes late re-opens the tail.\n- Tables keep their row count.\n- The cache is per document.',
        }),
      ),
      ...done(
        't1',
        tool(
          'ask',
          'AskUserQuestion',
          { questions: [] },
          'The user answered.\n{"answers":[{"question":"Which store?","outcome":"answered","selected":["SQLite"]}]}',
        ),
      ),
      ...done(
        't1',
        tool('next', 'SuggestNextSteps', {
          suggestions: [
            { title: 'Run the benchmark', prompt: 'Run npm run bench:t19.' },
            { title: 'Open a pull request', prompt: 'Open a pull request with the change.' },
          ],
        }),
      ),
      ended('t1'),
    ],
  };
}

function status(): GallerySection {
  return {
    notifications: [
      turn('t1'),
      ...done('t1', user('u1', 'Keep going.')),
      ...done('t1', {
        type: 'permissionModeChanged',
        itemId: 'mode1',
        status: 'completed',
        mode: 'acceptEdits',
      }),
      ...done('t1', {
        type: 'contextCompaction',
        itemId: 'cc1',
        status: 'completed',
        reason: 'threshold',
        tokensBefore: 182_000,
        tokensAfter: 12_400,
      }),
      note('turn/completed', {
        turnId: 't1',
        status: 'failed',
        errorMessage: '429 Too Many Requests: retry after 30 s',
        errorKind: 'rateLimit',
        retryable: true,
      }),
      note('session/uncertain', { turnId: 't2' }),
    ],
  };
}

function working(): GallerySection {
  const now = Date.now();
  return {
    running: true,
    queue: [
      { itemId: 'q1', kind: 'steer', text: 'Skip the vendored folders.', attachments: [] },
      {
        itemId: 'q2',
        kind: 'followUp',
        text: 'Then update the index docs with the new options and run the docs build.',
        attachments: [],
      },
    ],
    notifications: [
      turn('t1', now - 23_000),
      ...done('t1', user('u1', 'Rebuild the index and check the results.')),
      ...done('t1', tool('read1', 'Read', { file_path: 'src/index.ts' }, 'export {}')),
      started(
        't1',
        tool('grep1', 'Grep', { pattern: 'buildIndex' }, undefined, 'inProgress'),
        now - 2_000,
      ),
      note('turn/usage', {
        turnId: 't1',
        usage: {
          inputTokens: 1,
          outputTokens: 1_842,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 0,
        },
      }),
    ],
  };
}

function approvals(kind: string): GallerySection {
  const base = [
    turn('t1', Date.now() - 5_000),
    ...done('t1', user('u1', 'Clean the build output.')),
  ];
  const requests: Record<string, ApprovalRequest> = {
    command: approval({
      kind: 'command',
      tool: 'Bash',
      command:
        'rm -rf apps/desktop/out/development && npm run package:desktop -- --flavor development',
      cwd: '/work/piarc',
      rules: ['Bash(npm run package:desktop:*)'],
      sandbox: 'sandbox',
    }),
    edit: approval({
      kind: 'fileChange',
      tool: 'Edit',
      path: 'src/parser/blocks.ts',
      diff: DIFF,
      directory: '/work/piarc/src/parser',
    }),
    network: approval({
      kind: 'permissionExpansion',
      tool: 'SandboxNetwork',
      domain: 'registry.npmjs.org',
    }),
    plan: approval({
      kind: 'plan',
      tool: 'ExitPlanMode',
      plan: '## Plan\n\n1. Cache closed blocks in the worker.\n2. Re-parse only the open tail.\n3. Measure with `npm run bench:t19`.',
    }),
    question: approval({
      kind: 'question',
      tool: 'AskUserQuestion',
      questions: [
        {
          question: 'Where should the cache live?',
          header: 'Cache',
          options: [
            { label: 'In the worker', description: 'Keeps the main thread free.' },
            { label: 'In the store', description: 'Survives switching sessions.' },
          ],
        },
      ],
    }),
    elicitation: approval({
      kind: 'elicitation',
      tool: 'release-server',
      elicitation: {
        mode: 'form',
        message: 'Choose the release to publish.',
        requestedSchema: {
          type: 'object',
          properties: {
            release: { type: 'string', title: 'Release name', default: 'Alpha' },
            ready: { type: 'boolean', title: 'Ready to publish', default: false },
          },
          required: ['release'],
        },
      },
    }),
  };
  const request = requests[kind];
  return {
    running: true,
    notifications: base,
    approvals: request === undefined ? [] : [request],
  };
}

/** The gallery's sections by name (`#/session-gallery?section=<name>`). */
export function gallerySection(name: string): GallerySection {
  seq = 0;
  switch (name) {
    case 'messages':
      return messages();
    case 'markdown':
      return markdown();
    case 'diagram':
      return diagram();
    case 'thinking':
      return thinking();
    case 'tools':
      return tools();
    case 'cards':
      return cards();
    case 'status':
      return status();
    case 'working':
      return working();
    case 'input':
      return { ...conversation(), input: true };
    default:
      if (name.startsWith('approval-')) return approvals(name.slice('approval-'.length));
      return conversation();
  }
}
