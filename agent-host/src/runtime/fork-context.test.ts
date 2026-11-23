// Drive a real Pi session, its Agent tool and its child's Pi session. Intercept the Anthropic
// HTTP request after serialization; the fake Core boundary supplies only the test permissions.
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { forkContext, seedFork, trackForkContext } from './fork-context.js';
import { assert, expect, it, vi } from 'vitest';
import { DEFAULT_PROFILE, CoreIo, ExecOutputRouter } from '../tools/index.js';
import { CoreBridge } from './core-bridge.js';
import { plainInput, type UserInput } from './input.js';
import { SessionRegistry } from './session-registry.js';
import { openWorkspace } from './workspace.js';

const model = 'claude-sonnet-4-6';
function reply(step: string | { id: string; name: string; input: Record<string, unknown> }) {
  const tool = typeof step !== 'string';
  const messages = [
    {
      type: 'message_start',
      message: { id: 'message', model, usage: { input_tokens: 1800, output_tokens: 0 } },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: tool
        ? { type: 'tool_use', name: step.name, id: step.id, input: {} }
        : { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: tool
        ? { type: 'input_json_delta', partial_json: JSON.stringify(step.input) }
        : { type: 'text_delta', text: step },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: tool ? 'tool_use' : 'end_turn' },
      usage: { output_tokens: 6 },
    },
    { type: 'message_stop' },
  ];
  return new Response(
    messages.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

interface Wire {
  raw: string;
  system: unknown;
  tools: unknown;
  messages: unknown[];
}
type Step = Parameters<typeof reply>[0];
async function withSession(
  respond: (body: Wire, signal: AbortSignal) => Step | undefined | Promise<Step>,
  check: (
    prompt: (text: string | UserInput) => Promise<void>,
    bodies: Wire[],
    starts: string[],
    side: { registry: SessionRegistry; directory: string; calls: string[] },
  ) => Promise<void>,
  answersForSkill?: Record<string, unknown>,
) {
  const dir = await mkdtemp(path.join(tmpdir(), 'piarc-fork-wire-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', dir);
  const bodies: Wire[] = [];
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    const raw = await request.text();
    const body: unknown = JSON.parse(raw);
    expect(request.url).toContain('/messages');
    const wire = { ...(body as Omit<Wire, 'raw'>), raw };
    bodies.push(wire);
    const next = await respond(wire, request.signal);
    if (next === undefined) throw new Error('Unexpected extra provider request');
    return reply(next);
  });
  const store = new InMemoryCredentialStore();
  await store.modify('anthropic', () => Promise.resolve({ type: 'api_key', key: 'test-fixture' }));
  const workspace = await openWorkspace(dir, dir, store);
  const starts: string[] = [];
  const calls: string[] = [];
  const bridge = new CoreBridge((raw) => {
    const { method, id, params } = raw as {
      method: string;
      id: number;
      params: { agentType?: string };
    };
    const answers: Record<string, unknown> = {
      'agents/list': { agents: [], limits: { maxDepth: 3, maxConcurrent: 8 } },
      'exec/shells': { bash: true, powershell: false },
      'policy/tools': { denied: [] },
      'policy/evaluate': { allowed: true },
      'subagent/start': { permissionMode: 'default' },
      'subagent/finish': {},
      ...answersForSkill,
    };
    calls.push(method);
    if (method === 'subagent/start') starts.push(String(params.agentType));
    if (!(method in answers)) throw new Error('Unexpected Core request: ' + method);
    bridge.handleResponse({ jsonrpc: '2.0', id, result: answers[method] });
  });
  let settled = Promise.withResolvers<undefined>();
  const registry = new SessionRegistry({
    workspace,
    tools: {
      kind: 'core',
      bridge,
      profile: DEFAULT_PROFILE,
      ioFor: (sessionId) =>
        new CoreIo({
          sessionId,
          bridge,
          execOutput: new ExecOutputRouter(),
          readBlob: () => Promise.reject(new Error('unexpected blob')),
        }),
    },
    hostTools: {
      bridge,
      subagents: true,
      planMode: true,
      ask: true,
      todo: false,
      skills: Boolean(answersForSkill?.['skills/list']),
    },
    isTrusted: () => Promise.resolve(false),
    log: () => undefined,
    sinkFor: () => ({
      event: (method) => {
        if (method === 'turn/completed') settled.resolve(undefined);
      },
      delta: () => undefined,
      replaceable: () => undefined,
    }),
  });
  try {
    await registry.create(dir, { provider: 'anthropic', id: model }, 'main');
    let number = 0;
    await check(
      async (input) => {
        settled = Promise.withResolvers<undefined>();
        await registry.prompt(
          'main',
          String(++number),
          typeof input === 'string' ? plainInput(input).input : input,
        );
        await settled.promise;
      },
      bodies,
      starts,
      { registry, directory: dir, calls },
    );
  } finally {
    await registry.closeAll();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
}

it('forks the exact Anthropic loadout and active history and refuses a recursive fork', async () => {
  const requested = (id: string, prompt: string) => ({
    id,
    name: 'Agent',
    input: {
      subagent_type: 'fork',
      description: 'Check the label',
      prompt,
      run_in_background: false,
    },
  });
  const script = [
    'First finding.',
    requested('fork-1', 'Follow the label.'),
    requested('fork-2', 'Dig deeper.'),
    { id: 'parent-only', name: 'EnterPlanMode', input: {} },
    'Child report.',
    'Done.',
  ];
  await withSession(
    () => script.shift(),
    async (prompt, bodies, starts) => {
      await prompt('Find the label.');
      await prompt('Delegate the check.');
      expect(bodies).toHaveLength(6);
      const [parent, child] = bodies.slice(1, 3);
      assert(parent && child);
      for (const field of ['system', 'tools'] as const) {
        const serialized = Buffer.from(JSON.stringify(parent[field]));
        const fieldBytes = Buffer.concat([Buffer.from(`"${field}":`), serialized]);
        expect(Buffer.from(parent.raw).includes(fieldBytes)).toBe(true);
        expect(Buffer.from(child.raw).includes(fieldBytes)).toBe(true);
      }
      expect(JSON.stringify(child.tools)).toContain('AskUserQuestion');
      expect(child.system).toEqual([
        expect.objectContaining({ cache_control: { type: 'ephemeral' } }),
        expect.objectContaining({ cache_control: { type: 'ephemeral' } }),
      ]);
      expect(JSON.stringify(child.tools)).toContain('cache_control');
      function prefix(messages: unknown[]) {
        return JSON.stringify(messages, (key, value: unknown) =>
          key === 'cache_control'
            ? undefined
            : key === 'content' && typeof value === 'string'
              ? [{ type: 'text', text: value }]
              : value,
        );
      }
      expect(prefix(child.messages.slice(0, parent.messages.length))).toEqual(
        prefix(parent.messages),
      );
      expect(child.messages[parent.messages.length]).toEqual({
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'fork-1',
            name: 'Agent',
            input: {
              subagent_type: 'fork',
              description: 'Check the label',
              prompt: 'Follow the label.',
              run_in_background: false,
            },
          },
        ],
      });
      expect(JSON.stringify(bodies[3]?.messages)).toContain(
        'cannot start another conversation fork',
      );
      expect(JSON.stringify(bodies[4]?.messages)).toContain('not available to this subagent');
      expect(JSON.stringify(bodies[5]?.messages)).toContain('Child report.');
      expect(JSON.stringify(bodies[5]?.messages)).not.toContain('Dig deeper.');
      expect(starts).toEqual(['fork']);
    },
  );
}, 30000);

it('runs named foreground and background skills in separate contexts and never sends the body in the parent', async () => {
  const marker = 'PRIVATE-INSTRUCTIONS';
  const release = Promise.withResolvers<undefined>();
  const finished = Promise.withResolvers<undefined>();
  const answers = {
    'agents/list': {
      agents: [
        {
          name: 'researcher',
          source: 'user',
          description: 'Investigate.',
          prompt: 'CHILD-PERSONA',
        },
      ],
      limits: { maxDepth: 3, maxConcurrent: 8 },
    },
    'skills/list': {
      skills: [
        {
          name: 'investigate',
          description: '',
          source: 'user',
          dir: '/skills/investigate',
          path: '/skills/investigate/SKILL.md',
          modelInvocable: true,
          userInvocable: true,
          visibility: 'on',
        },
      ],
      commands: [],
      outputStyles: [],
      outputStyle: { name: 'Default' },
    },
    'skills/invoke': {
      name: 'investigate',
      content: marker + ' from-tool',
      dir: '/skills/investigate',
      fork: { sessionId: 'skill-tool-child', agent: 'researcher', background: false },
    },
  };
  let initial = true;
  await withSession(
    async (body) => {
      const text = JSON.stringify(body);
      if (text.includes('CHILD-PERSONA')) {
        expect(text).not.toContain('PARENT-ONLY-FACT');
        if (text.includes('from-tool')) return 'First finding.';
        expect(text).toContain(marker + ' from-command');
        await release.promise;
        finished.resolve(undefined);
        return 'Second finding.';
      }
      expect(text).not.toContain(marker);
      if (initial) {
        initial = false;
        return {
          id: 'skill-load',
          name: 'Skill',
          input: { skill: 'investigate', args: 'from-tool' },
        };
      }
      return 'Parent settled.';
    },
    async (prompt, bodies, starts) => {
      try {
        await prompt('Use the investigator for PARENT-ONLY-FACT.');
        expect(JSON.stringify(bodies.at(-1))).toContain('First finding.');
        const command = {
          kind: 'skill',
          source: 'user',
          name: 'investigate',
          arguments: 'from-command',
          input: '/investigate from-command',
          fork: { sessionId: 'skill-command-child', agent: 'researcher', background: true },
        } as const;
        await prompt({ ...plainInput(marker + ' from-command').input, command });
        expect(
          JSON.stringify(
            bodies.filter((b) => !JSON.stringify(b.system).includes('CHILD-PERSONA')).at(-1),
          ),
        ).toContain('skill-command-child');
        expect(starts).toEqual(['researcher', 'researcher']);
      } finally {
        release.resolve(undefined);
      }
      await finished.promise;
    },
    answers,
  );
}, 30000);

// Server-compaction context hooks project temporary markers into a single provider request.
// Only the assistant entry, with its durable provider summary, may be seeded into a fork.
it('persists the original server compaction entry and never its transient request marker', async () => {
  const manager = SessionManager.inMemory('/fixture');
  manager.appendMessage({ role: 'user', content: 'Earlier work', timestamp: 1 });
  const stored = {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text: 'Answer.' }],
    api: 'anthropic-messages' as const,
    provider: 'anthropic',
    model,
    usage: {
      input: 1000,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1005,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop' as const,
    timestamp: 2,
    piarcCompaction: 'Persisted summary.',
  };
  manager.appendMessage(stored);
  const target = {
    sessionManager: manager,
    agent: {
      transformContext: () =>
        Promise.resolve([
          {
            ...stored,
            content: [
              { type: 'text' as const, text: 'TRANSIENT-REQUEST-MARKER' },
              ...stored.content,
            ],
          },
        ]),
    },
  } as unknown as AgentSession;
  trackForkContext(target);
  await target.agent.transformContext?.(manager.buildSessionContext().messages);
  const child = SessionManager.inMemory('/fixture');
  seedFork(child, forkContext(target));
  const entries = JSON.stringify(child.getBranch());
  expect(entries).toContain('Persisted summary.');
  expect(entries).toContain('Answer.');
  expect(entries).not.toContain('TRANSIENT-REQUEST-MARKER');
});

it('keeps side answers and denied tools in memory and preserves the serialized parent prefix', async () => {
  const script = [
    'Parent result.',
    { id: 'write-side', name: 'Write', input: { path: 'never.txt', content: 'PRIVATE' } },
    'PRIVATE answer.',
    'Second side answer.',
    'New panel.',
    'Parent continued.',
  ];
  await withSession(
    () => script.shift(),
    async (prompt, bodies, _starts, { registry, directory, calls }) => {
      await prompt('Parent question.');
      const files = async () =>
        (await readdir(directory, { recursive: true })).filter((name) => name.endsWith('.jsonl'));
      const before = await files();
      expect(before).toHaveLength(1);
      const [relative] = before;
      assert(relative);
      const file = path.join(directory, relative);
      const bytes = await readFile(file);
      const count = calls.length;
      const result = await registry.askSideChat('main', 'p1', 'PRIVATE side question.');
      expect(result.text).toBe('PRIVATE answer.');
      expect(result.usage).toHaveLength(2);
      expect(calls.slice(count)).toEqual([]);
      expect(bodies[1]?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            content: [{ type: 'text', text: 'Parent result.' }],
          }),
        ]),
      );
      const [mainWire, sideWire] = bodies;
      assert(mainWire && sideWire);
      for (const key of ['system', 'tools'] as const) {
        const bytes = Buffer.from(`"${key}":${JSON.stringify(mainWire[key])}`);
        expect(Buffer.from(mainWire.raw).includes(bytes)).toBe(true);
        expect(Buffer.from(sideWire.raw).includes(bytes)).toBe(true);
      }
      expect(JSON.stringify(bodies[2]?.messages)).toContain('Side chats cannot execute tools.');
      await registry.askSideChat('main', 'p1', 'Second side question.');
      expect(JSON.stringify(bodies[3]?.messages)).toContain('PRIVATE answer.');
      registry.controlSideChat('main', 'p1', true);
      await registry.askSideChat('main', 'p1', 'Clean panel?');
      expect(JSON.stringify(bodies[4]?.messages)).not.toContain('PRIVATE');
      expect(await files()).toEqual(before);
      expect(await readFile(file)).toEqual(bytes);
      await prompt('Continue.');
      expect(JSON.stringify(bodies[5]?.messages)).not.toContain('PRIVATE');
      expect(JSON.stringify(bodies[5]?.messages)).not.toContain('Clean panel?');
    },
  );
}, 30000);

it('discards a running panel, aborts its provider, and leaves an in-flight parent turn alone', async () => {
  const mainStarted = Promise.withResolvers<undefined>();
  const sideStarted = Promise.withResolvers<undefined>();
  const mainAnswer = Promise.withResolvers<string>();
  await withSession(
    async (body, signal) => {
      const tail = JSON.stringify(body.messages.at(-1));
      if (tail.includes('RUNNING-MAIN')) {
        mainStarted.resolve(undefined);
        return mainAnswer.promise;
      }
      if (tail.includes('WAIT-SIDE')) {
        sideStarted.resolve(undefined);
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(new Error('Stopped test stream'));
            },
            { once: true },
          );
        });
      }
      return 'Answer.';
    },
    async (prompt, bodies, _starts, { registry }) => {
      await prompt('COMPLETED-MAIN');
      const main = prompt('RUNNING-MAIN');
      try {
        await mainStarted.promise;
        const side = registry.askSideChat('main', 'run', 'WAIT-SIDE');
        await sideStarted.promise;
        expect(JSON.stringify(bodies.at(-1)?.messages)).toContain('COMPLETED-MAIN');
        expect(JSON.stringify(bodies.at(-1)?.messages)).not.toContain('RUNNING-MAIN');
        registry.controlSideChat('main', 'run', true);
        expect((await side).stopped).toBe(true);
        expect((await registry.askSideChat('main', 'run', 'Fresh panel?')).text).toBe('Answer.');
        expect(JSON.stringify(bodies.at(-1)?.messages)).not.toContain('WAIT-SIDE');
      } finally {
        mainAnswer.resolve('Parent finished.');
        await main;
      }
    },
  );
}, 30000);

it('stops a question without clearing earlier answers, and closes running requests with the parent', async () => {
  let waiting = Promise.withResolvers<undefined>();
  await withSession(
    async (body, signal) => {
      if (JSON.stringify(body.messages.at(-1)).includes('HOLD')) {
        waiting.resolve(undefined);
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(new Error('Closed test stream'));
            },
            { once: true },
          );
        });
      }
      return 'Completed answer.';
    },
    async (_prompt, bodies, _starts, { registry }) => {
      await registry.askSideChat('main', 'panel', 'Initial side question.');
      const interrupted = registry.askSideChat('main', 'panel', 'HOLD first request.');
      await waiting.promise;
      registry.controlSideChat('main', 'panel', false);
      expect((await interrupted).stopped).toBe(true);
      await registry.askSideChat('main', 'panel', 'Resume.');
      expect(JSON.stringify(bodies.at(-1)?.messages)).toContain('Initial side question.');
      expect(JSON.stringify(bodies.at(-1)?.messages)).not.toContain('HOLD first request.');
      waiting = Promise.withResolvers<undefined>();
      const pending = registry.askSideChat('main', 'panel', 'HOLD until parent closes.');
      await waiting.promise;
      await registry.close('main');
      expect((await pending).stopped).toBe(true);
      await expect(registry.askSideChat('main', 'panel', 'Is it open?')).rejects.toThrow();
    },
  );
}, 30000);
