// T47: the `Memory` tool forwards to Core and tells the session about its own change; the
// injected index and the organization's instructions say what they are; notes the session used
// come back after a compaction.
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { MemoryApplyParams, MemoryApplyResult, MemoryFile } from '@piarc/protocol';
import { describe, expect, it } from 'vitest';

import { parseMemoryApply, parseMemoryStatus } from '../tools/core-io.js';
import type { CoreIo } from '../tools/core-io.js';
import { DEFAULT_PROFILE } from '../tools/profile.js';
import { createMemoryTool } from './auto-memory.js';
import { parseMemoryFile } from './memory-io.js';
import { MEMORY_PREAMBLE } from './prompts/auto-memory.js';
import { sourced } from './prompts/system.js';
import { RESTORE_LIMITS, recentNotes, restoreSections } from './reinjection.js';

const index: MemoryFile = {
  path: '/data/auto-memory/repo-0123456789ab/MEMORY.md',
  content: '# Auto memory\n\n- [build](build.md) (project, 2026-11-22) — Run cargo check first\n',
  kind: 'autoMemory',
};

describe('the Memory tool', () => {
  it('sends the call to Core and acknowledges the index it changed', async () => {
    const sent: Omit<MemoryApplyParams, 'sessionId'>[] = [];
    const acknowledged: MemoryFile[] = [];
    const answers: MemoryApplyResult[] = [
      { text: 'Saved memory "build".', index, changed: true },
      { text: 'Memory "build" (project, saved …)' },
      { text: 'Deleted memory "build".', changed: true },
    ];
    const io = {
      memoryApply: (params: Omit<MemoryApplyParams, 'sessionId'>) => {
        sent.push(params);
        const answer = answers.shift();
        if (answer === undefined) throw new Error('no answer');
        return Promise.resolve(answer);
      },
    } as unknown as CoreIo;
    const tool = createMemoryTool(DEFAULT_PROFILE.Memory, {
      io,
      changed: (file) => acknowledged.push(file),
    });
    expect(tool.name).toBe('Memory');
    const run = (id: string, params: Record<string, unknown>) =>
      tool.execute(id, params, undefined, undefined, undefined as never);
    const saved = await run('c1', {
      action: 'save',
      name: ' build ',
      type: 'project',
      description: 'Run cargo check first',
      content: 'cargo check --workspace',
    });
    expect(saved.content).toEqual([{ type: 'text', text: 'Saved memory "build".' }]);
    expect(saved.details).toEqual({ action: 'save', name: 'build', changed: true });
    await run('c2', { action: 'read', name: 'build' });
    await run('c3', { action: 'delete', name: 'build' });
    expect(sent).toEqual([
      {
        toolCallId: 'c1',
        action: 'save',
        name: 'build',
        type: 'project',
        description: 'Run cargo check first',
        content: 'cargo check --workspace',
      },
      { toolCallId: 'c2', action: 'read', name: 'build' },
      { toolCallId: 'c3', action: 'delete', name: 'build' },
    ]);
    // Only the save came back with an index; a read changes nothing.
    expect(acknowledged).toEqual([index]);
  });

  it('reads Core’s answers strictly', () => {
    expect(parseMemoryStatus({ enabled: true, tool: false })).toEqual({
      enabled: true,
      tool: false,
    });
    expect(parseMemoryStatus({ enabled: true })).toBeUndefined();
    expect(parseMemoryApply({ text: 't', index, changed: true })).toEqual({
      text: 't',
      index,
      changed: true,
    });
    expect(parseMemoryApply({ text: 't', index: { path: 'p' } })).toBeUndefined();
    expect(parseMemoryFile({ path: 'p', content: 'c', kind: 'other' })).toBeUndefined();
    expect(parseMemoryFile({ path: 'p', content: 'c', kind: 'managed' })).toEqual({
      path: 'p',
      content: 'c',
      kind: 'managed',
    });
  });
});

describe('memory documents in the project context', () => {
  it('frames the index and the organization’s instructions', () => {
    const auto = sourced(index);
    expect(auto.startsWith(MEMORY_PREAMBLE)).toBe(true);
    expect(auto).toContain(`Source: ${index.path}\n# Auto memory`);
    const managed = sourced({ path: '/Library/Application Support/PiArc/CLAUDE.md', content: 'x' });
    expect(managed).toBe('Source: /Library/Application Support/PiArc/CLAUDE.md\nx');
    expect(
      sourced({
        path: '/Library/Application Support/PiArc/CLAUDE.md',
        content: 'x',
        kind: 'managed',
      }),
    ).toMatch(
      /^Source: \/Library\/Application Support\/PiArc\/CLAUDE\.md \(instructions your organization manages/,
    );
  });
});

describe('notes after a compaction', () => {
  function call(name: string, args: Record<string, string>, id: string): AssistantMessage {
    return {
      role: 'assistant',
      content: [{ type: 'toolCall', id, name, arguments: args }],
      api: 'openai-completions',
      provider: 'test',
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
      timestamp: Date.now(),
    };
  }

  it('lists the notes read or saved, most recent first, and restores them within the limit', async () => {
    const manager = SessionManager.inMemory('/w');
    manager.appendMessage(call('Memory', { action: 'save', name: 'old' }, 'a'));
    manager.appendMessage(call('Memory', { action: 'read' }, 'b'));
    manager.appendMessage(call('Memory', { action: 'delete', name: 'gone' }, 'c'));
    manager.appendMessage(call('Read', { path: 'x' }, 'd'));
    manager.appendMessage(call('Memory', { action: 'read', name: 'new' }, 'e'));
    manager.appendMessage(call('Memory', { action: 'save', name: 'old' }, 'f'));
    const notes = recentNotes(manager.getBranch(), (tool) => tool);
    expect(notes).toEqual(['old', 'new']);
    const many = Array.from({ length: 7 }, (_, n) => `note-${String(n)}`);
    const read: string[] = [];
    const sections = await restoreSections({
      memory: [],
      plan: undefined,
      todos: [],
      skills: [],
      files: [],
      readFile: () => Promise.resolve({ kind: 'unreadable' }),
      notes: many,
      readNote: (name) => {
        read.push(name);
        return Promise.resolve(name === 'note-1' ? undefined : `Memory "${name}": text`);
      },
    });
    expect(read).toEqual(many.slice(0, RESTORE_LIMITS.notes));
    const restored = sections.filter((s) => s.key.startsWith('restore:note:'));
    expect(restored.map((s) => s.source)).toEqual(['note-0', 'note-2', 'note-3', 'note-4']);
    expect(restored.every((s) => s.category === 'memory')).toBe(true);
  });
});
