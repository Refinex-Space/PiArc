import path from 'node:path';
import { SessionManager, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CoreBridge } from '../runtime/core-bridge.js';
import { profileWithOverrides } from '../tools/profile.js';
import { memoryReader, type ReadMemory } from './memory-io.js';
import { anthropicMemoryPayload } from './memory-wire.js';
import { SessionMemory } from './session-memory.js';

const cwd = path.resolve('example');
const source = path.join(cwd, 'CLAUDE.md');

interface Notice {
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
}
interface Started {
  systemPrompt: string;
  message?: Notice;
}

function harness(manager: SessionManager, read?: ReadMemory) {
  const profile = profileWithOverrides({ Read: { name: 'view_file' } });
  const memory = new SessionMemory(manager, cwd, profile, read, (name) =>
    name === 'view_file' ? 'Read' : name,
  );
  const hooks = new Map<string, (event: unknown, ctx: object) => Promise<unknown>>();
  const messages: Notice[] = [];
  function deliver(notice: Notice) {
    messages.push(notice);
    manager.appendCustomMessageEntry(
      notice.customType,
      notice.content,
      notice.display,
      notice.details,
    );
  }
  void memory.extension({
    on: (key: string, handler: (event: unknown, ctx: object) => Promise<unknown>) =>
      hooks.set(key, handler),
    sendMessage: deliver,
  } as unknown as ExtensionAPI);
  const trigger = (name: string, event: object, ctx: object = {}) => {
    const hook = hooks.get(name);
    if (hook === undefined) throw new Error('Missing ' + name);
    return hook(event, ctx);
  };
  return {
    memory,
    messages,
    start: async (turnId?: string) => {
      await memory.prepare(turnId);
      const result = (await trigger('before_agent_start', {
        systemPromptOptions: {
          selectedTools: ['view_file', 'Edit', 'PowerShell'],
          hiddenTools: ['PowerShell'],
        },
      })) as Started;
      if (result.message) deliver(result.message);
      return result;
    },
    wire: (payload: unknown, api = 'anthropic-messages') =>
      trigger('before_provider_request', { payload }, { model: { api } }),
    tool: (name: string, id: string, file: string, isError = false) =>
      trigger('tool_result', { toolName: name, toolCallId: id, input: { path: file }, isError }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('session memory', () => {
  it('keeps the opening system bytes across midnight, a memory edit and a branch reload', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 0, 1, 23, 59));
    const manager = SessionManager.inMemory(cwd);
    let text = 'The first version.';
    const read: ReadMemory = (_dirs, git) =>
      Promise.resolve({
        files: [{ path: source, content: text }],
        ...(git ? { gitStatus: '?? initial.txt' } : {}),
      });
    const before = harness(manager, read);
    const first = await before.start();
    expect(first.systemPrompt).toContain('view_file: show a text file');
    expect(first.systemPrompt).not.toContain('PowerShell');
    expect(first.systemPrompt).toContain('Session date: 2026-01-01');
    expect(first.message).toBeUndefined();
    vi.setSystemTime(new Date(2026, 0, 2));
    text = 'The second version.';
    const second = await before.start();
    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(second.message?.content).toContain('Current date: 2026-01-02');
    expect(second.message?.content).toContain(text);
    const resumed = harness(manager, read);
    expect(await resumed.start()).toEqual({ systemPrompt: first.systemPrompt });
  });

  it('delivers an edit before the first prompt alongside the opening system in one memory request', async () => {
    const original = [{ path: source, content: 'Opened with this instruction.' }] as const;
    const current = [{ path: source, content: 'Edited before speaking.' }] as const;
    const sent = vi.fn((raw: object) => {
      const { id, params } = raw as { id: number; params: { includeGit: boolean } };
      const snapshot = params.includeGit
        ? { files: original, currentFiles: current }
        : { files: current };
      queueMicrotask(() => {
        bridge.handleResponse({ jsonrpc: '2.0', id, result: { chunk: JSON.stringify(snapshot) } });
      });
    });
    const bridge = new CoreBridge(sent);
    const session = harness(SessionManager.inMemory(cwd), memoryReader(bridge, 'session'));
    const first = await session.start();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(first.systemPrompt).toContain(original[0].content);
    expect(first.systemPrompt).not.toContain(current[0].content);
    expect(first.message?.content).toContain(current[0].content);
    expect(await session.start()).toEqual({ systemPrompt: first.systemPrompt });
  });

  it('loads successful child accesses once, including structured search results; ignores refused and outside paths', async () => {
    const sub = path.join(cwd, 'sub', 'child');
    const nested = path.join(sub, 'AGENTS.md');
    const manager = SessionManager.inMemory(cwd);
    const read = vi.fn<ReadMemory>((dirs) =>
      Promise.resolve({
        files: dirs.includes(sub) ? [{ path: nested, content: 'Nested conventions.' }] : [],
      }),
    );
    const session = harness(manager, read);
    await session.start();
    await session.tool('view_file', 'denied', path.join(sub, 'a'), true);
    await session.tool('Edit', 'outside', path.join(cwd, '..', 'out', 'a'));
    expect(read).toHaveBeenCalledTimes(1);
    session.memory.searched('search', [cwd, sub]);
    await Promise.all([
      session.tool('Grep', 'search', '.'),
      session.tool('view_file', 'second', path.join(sub, 'b')),
    ]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(session.messages.map((m) => m.content)).toEqual([
      `[PiArc memory]\n\nSource: ${nested}\nNested conventions.`,
    ]);
    await expect(harness(manager, read).start()).resolves.not.toHaveProperty('message');
  });

  it('pages snapshots at UTF-8 byte boundaries and binds an approval to the waiting call', async () => {
    const bridge = new CoreBridge((raw) => {
      const frame = raw as { id: number; params: { toolCallId: string; offset?: number } };
      const prefix = '{"files":[{"path":"文';
      const second = frame.params.offset !== undefined;
      queueMicrotask(() => {
        expect(bridge.awaitingApproval('session', frame.params.toolCallId)).toBe(true);
        if (second) expect(frame.params.offset).toBe(Buffer.byteLength(prefix));
        bridge.handleResponse({
          jsonrpc: '2.0',
          id: frame.id,
          result: second
            ? { chunk: '件","content":"ok"}]}' }
            : { chunk: prefix, nextOffset: Buffer.byteLength(prefix) },
        });
      });
    });
    const read = memoryReader(bridge, 'session');
    await expect(read([], true)).resolves.toEqual({ files: [{ path: '文件', content: 'ok' }] });
  });
  it('loads a conditional rule on the first matching file access, once, and keeps it after a reload', async () => {
    const rule = path.join(cwd, '.claude', 'rules', 'ts.md');
    const calls: { files: string[]; rules: string[] }[] = [];
    const read: ReadMemory = (_dirs, _git, _signal, _turn, scan) => {
      const files = scan?.files ?? [];
      const rules = scan?.rules ?? [];
      calls.push({ files, rules });
      const active = rules.includes(rule) || files.some((f) => f.endsWith('.ts'));
      return Promise.resolve({
        files: [
          { path: source, content: 'Project memory.' },
          ...(active ? [{ path: rule, content: 'TypeScript rule.', paths: ['**/*.ts'] }] : []),
        ],
        ...(active ? {} : { inactiveRules: true }),
      });
    };
    const manager = SessionManager.inMemory(cwd);
    const session = harness(manager, read);
    const first = await session.start();
    expect(first.systemPrompt).not.toContain('TypeScript rule.');
    // A file in an already visited directory that does not match: asked, nothing new.
    await session.tool('view_file', 'a', 'notes.md');
    await session.tool('view_file', 'b', 'src/app.ts');
    await session.tool('Edit', 'c', 'src/other.ts');
    const rules = session.messages.filter((m) => m.content.includes('TypeScript rule.'));
    expect(rules).toHaveLength(1);
    expect(rules[0]?.content).toContain('[PiArc memory]');
    expect(rules[0]?.content).toContain(`Source: ${rule}`);
    // Once every rule is loaded, file accesses in known directories do not ask Core.
    const asked = calls.length;
    await session.tool('view_file', 'd', 'src/third.ts');
    expect(calls).toHaveLength(asked);
    // The next turn keeps it without a message, and the opening system is unchanged.
    const next = await session.start();
    expect(next.systemPrompt).toBe(first.systemPrompt);
    expect(next.message).toBeUndefined();
    expect(calls.at(-1)).toEqual({ files: [], rules: [rule] });
    const reopened = harness(manager, read);
    expect(await reopened.start()).toEqual({ systemPrompt: first.systemPrompt });
    expect(calls.at(-1)?.rules).toEqual([rule]);
  });
});

it('keeps tool results ahead of Anthropic memory blocks, preserving cache metadata and the transcript', () => {
  const tool = { type: 'tool_result', tool_use_id: 'a', content: 'Done' };
  const memory = {
    type: 'text',
    text: '[PiArc memory]\nNested.',
    cache_control: { type: 'ephemeral' },
  };
  const first = { role: 'user', content: [tool] };
  const payload = {
    messages: [first, { role: 'user', content: [memory] }, { role: 'user', content: 'Continue' }],
  };
  expect(anthropicMemoryPayload(payload)).toEqual({
    messages: [{ role: 'user', content: [tool, memory, { type: 'text', text: 'Continue' }] }],
  });
  expect(payload.messages).toHaveLength(3);
  expect(first.content).toEqual([tool]);
  expect(anthropicMemoryPayload({ messages: [first] })).toBeUndefined();
});

it('splits the frozen Anthropic system at the project section without changing the bytes or cache TTL', async () => {
  const session = harness(SessionManager.inMemory(cwd));
  const { systemPrompt } = await session.start();
  const split = systemPrompt.indexOf('<project_context>');
  const cache = { type: 'ephemeral', ttl: '1h' };
  const providerNote = { type: 'text', text: 'Separate provider instructions.' };
  const original = { type: 'text', text: systemPrompt, cache_control: cache };
  const user = { role: 'user', content: [{ type: 'text', text: 'go', cache_control: cache }] };
  const tools = [{ name: 'one', cache_control: cache }];
  const payload = { system: [providerNote, original], tools, messages: [user] };
  const expected = {
    ...payload,
    system: [
      providerNote,
      { ...original, text: systemPrompt.slice(0, split) },
      { ...original, text: systemPrompt.slice(split) },
    ],
  };
  expect(await session.wire(payload)).toEqual(expected);
  expect((await session.start()).systemPrompt).toBe(systemPrompt);
  expect(await session.wire(payload)).toEqual(expected);
  expect(payload.system).toEqual([providerNote, original]);
  expect(
    await session.wire({ ...payload, system: [{ type: 'text', text: systemPrompt }] }),
  ).toBeUndefined();
  expect(await session.wire(payload, 'openai-completions')).toBeUndefined();
  expect(await session.wire({ ...payload, cache_control: cache })).toBeUndefined();
});

it('binds initial and lazy memory calls to their turn and rotates the id for a follow-up', async () => {
  const turns: (string | undefined)[] = [];
  const bridge = new CoreBridge((raw) => {
    const request = raw as { id: number; params: { turnId?: string } };
    turns.push(request.params.turnId);
    queueMicrotask(() => {
      bridge.handleResponse({ jsonrpc: '2.0', id: request.id, result: { chunk: '{"files":[]}' } });
    });
  });
  const session = harness(SessionManager.inMemory(cwd), memoryReader(bridge, 'session'));
  await session.start('original');
  await session.tool('view_file', 'read', path.join(cwd, 'sub', 'notes.txt'));
  await session.start('next');
  await session.start();
  expect(turns).toEqual(['original', 'original', 'next', undefined]);
});
