// T27 without a live session: the compaction threshold, what a compaction gives back and its
// limits, the circuit breaker, the summary prompt and the context usage by category.
import path from 'node:path';
import os from 'node:os';

import { SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PROFILE } from '../tools/profile.js';
import { SessionCompaction } from './compaction.js';
import {
  autoCompactThreshold,
  effectiveWindow,
  piReserveTokens,
  shouldAutoCompact,
} from './compaction-threshold.js';
import {
  ContextUsageTracker,
  estimateCategories,
  totalOf,
  withReportedTotal,
  type UsageLimits,
} from './context-usage.js';
import { fileLists, SUMMARY_HEADINGS, summaryPrompt } from './prompts/compaction.js';
import {
  invokedSkills,
  recentFiles,
  RESTORE_LIMITS,
  restoreSections,
  SKILL_ENTRY,
  type RestoreSources,
} from './reinjection.js';
import { REMINDER_ENTRY, reminderMessage, Reminders } from './reminders.js';
import { SessionMemory } from './session-memory.js';
import { estimateTokens, truncateToTokens } from './tokens.js';

const same = (tool: string): string => tool;

describe('automatic compaction threshold', () => {
  const model = { contextWindow: 200_000, maxOutput: 32_000 };

  it('is W − min(O, 20K) − 13K and triggers at the threshold, not one token below', () => {
    const threshold = autoCompactThreshold(model);
    expect(threshold).toBe(200_000 - 20_000 - 13_000);
    expect(shouldAutoCompact(threshold, threshold)).toBe(true);
    expect(shouldAutoCompact(threshold - 1, threshold)).toBe(false);
    expect(autoCompactThreshold({ contextWindow: 32_000, maxOutput: 4096 })).toBe(14_904);
  });

  it('takes the smaller of the model window and the automatic compaction window', () => {
    const capped = { ...model, contextWindow: 1_000_000, autoCompactWindow: 300_000 };
    expect(effectiveWindow(capped)).toBe(300_000);
    expect(autoCompactThreshold(capped)).toBe(300_000 - 20_000 - 13_000);
    expect(effectiveWindow({ ...model, autoCompactWindow: 500_000 })).toBe(200_000);
    // A per-model window setting (T29) replaces the model's window.
    expect(effectiveWindow({ ...model, contextWindowOverride: 150_000 })).toBe(150_000);
  });

  it("gives Pi a reserve whose `>` check is the threshold's `>=`", () => {
    const window = 1_000_000;
    const threshold = autoCompactThreshold({
      ...model,
      contextWindow: window,
      autoCompactWindow: 300_000,
    });
    const reserve = piReserveTokens(window, threshold);
    const piCompacts = (tokens: number) => tokens > window - reserve;
    expect(piCompacts(threshold)).toBe(true);
    expect(piCompacts(threshold - 1)).toBe(false);
    expect(piReserveTokens(100, 500)).toBe(0);
  });
});

describe('restore after compaction', () => {
  const big = (tokens: number, fill = 'x') => fill.repeat(tokens * 4);
  const sources = (over: Partial<RestoreSources> = {}): RestoreSources => ({
    memory: [],
    plan: undefined,
    todos: [],
    skills: [],
    files: [],
    readFile: () => Promise.resolve({ kind: 'unreadable' }),
    ...over,
  });

  it('limits each skill to 5K tokens and all of them to 25K, most recent first', async () => {
    const skills = Array.from({ length: 7 }, (_, n) => ({
      name: `skill-${String(n)}`,
      content: big(6_000, String(n)),
    }));
    const sections = await restoreSections(sources({ skills }));
    const restored = sections.filter((s) => s.category === 'skills');
    expect(restored.length).toBeGreaterThan(0);
    for (const s of restored)
      expect(estimateTokens(s.text)).toBeLessThanOrEqual(RESTORE_LIMITS.skill);
    const total = restored.reduce((sum, s) => sum + estimateTokens(s.text), 0);
    expect(total).toBeLessThanOrEqual(RESTORE_LIMITS.skillsTotal);
    expect(restored[0]?.source).toBe('skill-0');
    expect(restored[0]?.text).toContain('more tokens left out');
  });

  it('gives back at most 5 recent files within 50K tokens; the rest only by path', async () => {
    const files = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'];
    const content: Record<string, string> = {
      f1: 'one',
      f2: big(19_000),
      f3: big(19_000),
      f4: big(19_000),
      f5: 'five',
      f6: 'six',
    };
    const read: string[] = [];
    const sections = await restoreSections(
      sources({
        files,
        readFile: (file, maxChars) => {
          read.push(file);
          const text = content[file] ?? '';
          return Promise.resolve(
            text.length > maxChars ? { kind: 'tooLong' } : { kind: 'text', text },
          );
        },
      }),
    );
    expect(read).toEqual(['f1', 'f2', 'f3', 'f4', 'f5']);
    const restored = sections.filter((s) => s.key.startsWith('restore:file:'));
    expect(restored.map((s) => s.source)).toEqual(['f1', 'f2', 'f3', 'f5']);
    const total = restored.reduce((sum, s) => sum + estimateTokens(s.text), 0);
    expect(total).toBeLessThanOrEqual(RESTORE_LIMITS.filesTotal);
    expect(sections.find((s) => s.key === 'restore:omitted')?.text).toContain('- f4');
    // A file over the per-file limit is named only.
    const huge = await restoreSections(
      sources({
        files: ['huge'],
        readFile: () => Promise.resolve({ kind: 'tooLong' }),
      }),
    );
    expect(huge.find((s) => s.key === 'restore:omitted')?.text).toContain('- huge');
  });

  it('reads invoked skills and recent files from the branch', () => {
    const manager = SessionManager.inMemory('/w');
    manager.appendCustomEntry(SKILL_ENTRY, { name: 'lint', content: 'old body' });
    manager.appendCustomEntry(SKILL_ENTRY, { name: 'test', content: 'test body' });
    manager.appendCustomEntry(SKILL_ENTRY, { name: 'lint', content: 'new body' });
    expect(invokedSkills(manager.getBranch())).toEqual([
      { name: 'lint', content: 'new body' },
      { name: 'test', content: 'test body' },
    ]);
    const call = (name: string, path: string, id: string) =>
      ({ type: 'toolCall', id, name, arguments: { path } }) as const;
    const reply: AssistantMessage = {
      role: 'assistant',
      content: [
        call('Read', 'a.txt', '1'),
        call('Edit', './b.txt', '2'),
        call('Read', '/w/a.txt', '3'),
      ],
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
    manager.appendMessage(reply);
    expect(recentFiles(manager.getBranch(), same, '/w')).toEqual(['/w/a.txt', './b.txt']);
  });

  it('truncates to the limit with its note', () => {
    const { text, truncated } = truncateToTokens(big(100), 10, (n) => `[${String(n)} left]`);
    expect(truncated).toBe(true);
    expect(estimateTokens(text)).toBeLessThanOrEqual(10);
  });
});

describe('summary prompt', () => {
  it('has the fixed sections and carries the focus and the hook instructions as written', () => {
    const prompt = summaryPrompt({
      transcript: '[User]: hi',
      previousSummary: 'Earlier.',
      focus: 'Keep the API decisions.',
      hookInstructions: 'Mention the ticket.',
    });
    for (const heading of SUMMARY_HEADINGS) expect(prompt).toContain(`## ${heading}`);
    expect(prompt).toContain('Focus requested by the user: Keep the API decisions.');
    expect(prompt).toContain('Instructions from PreCompact hooks: Mention the ticket.');
    expect(prompt).toContain('<previous-summary>\nEarlier.\n</previous-summary>');
    expect(fileLists([], [])).toBe('');
    expect(fileLists(['a'], ['b'])).toContain('Files modified in the summarized part:\n- b');
  });
});

describe('circuit breaker', () => {
  function compaction(threshold = 1000) {
    const manager = SessionManager.inMemory('/w');
    const reminders = new Reminders();
    const published: unknown[] = [];
    let applied = 0;
    const session = {
      model: { contextWindow: threshold + 33_000, maxTokens: 20_000, provider: 'p', id: 'm' },
      settingsManager: {
        applyOverrides: () => {
          applied++;
        },
      },
    };
    const memory = new SessionMemory(manager, '/w', DEFAULT_PROFILE, undefined, same, reminders);
    const tracker: ContextUsageTracker = new ContextUsageTracker({
      sink: {
        event: (_m, payload) => published.push(payload),
        delta: () => undefined,
        replaceable: () => undefined,
      },
      limits: (): UsageLimits => breaker.limits(),
      mcpTools: () => new Set(),
      messages: () => [],
      system: () => undefined,
      tools: () => [],
    });
    const breaker: SessionCompaction = new SessionCompaction({
      sessionId: 's',
      manager,
      cwd: '/w',
      session: () => session as never,
      reminders,
      memory,
      canonical: same,
      usage: (): ContextUsageTracker => tracker,
      bridge: undefined,
      io: undefined,
      hooks: undefined,
      appended: () => undefined,
      log: () => undefined,
    });
    return { breaker, published, applied: () => applied };
  }
  const failed = { reason: 'threshold', aborted: false };

  it('stops after three failed automatic compactions in a row and a manual one resets it', () => {
    const { breaker, published, applied } = compaction();
    breaker.ended(failed);
    breaker.ended(failed);
    expect(breaker.limits().autoCompact).toBe('on');
    breaker.ended(failed);
    expect(breaker.takeNote()).toEqual({ stopped: 'failed' });
    expect(breaker.limits()).toMatchObject({
      autoCompact: 'stopped',
      autoCompactStopped: 'failed',
    });
    expect(published).toHaveLength(1);
    expect(applied()).toBe(3);
    // A cancelled compaction (a PreCompact block) does not count; a manual success resets.
    breaker.ended({ reason: 'manual', aborted: false, result: {} });
    expect(breaker.limits().autoCompact).toBe('on');
    expect(published).toHaveLength(2);
  });

  it('an effective automatic compaction clears the count; a hook cancel does not count', () => {
    const { breaker } = compaction();
    breaker.ended(failed);
    breaker.ended(failed);
    breaker.ended({ reason: 'threshold', aborted: true });
    breaker.ended({ reason: 'threshold', aborted: false, result: {} });
    breaker.ended(failed);
    breaker.ended(failed);
    expect(breaker.limits().autoCompact).toBe('on');
  });
});

describe('context usage', () => {
  const tools = [
    { name: 'Read', description: 'Reads a file.', parameters: { type: 'object' } },
    { name: 'srv_query', description: 'An MCP tool.', parameters: { type: 'object' } },
  ];
  const memory = reminderMessage([
    {
      key: 'memory:a',
      type: 'memoryLazyLoad',
      source: 'a',
      text: 'm'.repeat(400),
      category: 'memory',
    },
    { key: 'todo', type: 'todoStale', source: 'TodoWrite', text: 't'.repeat(40) },
  ]);
  const messages = [
    { role: 'system', content: 'ignored', toolsAdded: tools },
    { role: 'user', content: 'u'.repeat(400) },
    { role: 'toolResult', content: [{ type: 'text', text: 'r'.repeat(800) }] },
    {
      role: 'custom',
      customType: REMINDER_ENTRY,
      content: memory.content,
      details: memory.details,
    },
  ];
  const system = `<identity>\nI\n</identity>\n\n<project_context>\n${'p'.repeat(400)}\n</project_context>`;

  it('splits the frozen system prompt, the tools, the messages and the reminders', () => {
    const categories = estimateCategories(messages, new Set(['srv_query']), { system });
    // The project context section (437 characters) and the memory reminder (400).
    expect(categories.memory).toBe(Math.ceil((437 + 400) / 4));
    // The rest of the system text; the transcript's own system content is not what is sent.
    expect(categories.systemPrompt).toBe(Math.ceil(26 / 4));
    const [read, mcp] = tools.map((tool) => JSON.stringify(tool).length);
    expect(categories.tools).toBe(Math.ceil((read ?? 0) / 4));
    expect(categories.mcpTools).toBe(Math.ceil((mcp ?? 0) / 4));
    expect(categories.toolResults).toBe(200);
    // The user message, the task list reminder and the reminder message's marker.
    expect(categories.conversation).toBe(Math.ceil((400 + 40 + 20) / 4));
    expect(categories.unclassified).toBe(0);
  });

  it("takes the provider's count as the total: the rest is unclassified, more is scaled down", () => {
    const estimate = estimateCategories(messages, new Set(), { system });
    const sum = totalOf(estimate);
    const larger = withReportedTotal(estimate, sum + 123);
    expect(larger.unclassified).toBe(123);
    expect(totalOf(larger)).toBe(sum + 123);
    const smaller = withReportedTotal(estimate, 50);
    expect(totalOf(smaller)).toBe(50);
    expect(smaller.unclassified).toBe(0);
  });
});

describe('session settings overrides', () => {
  it("survive Pi's settings reload because they are applied before every run", async () => {
    const dir = path.join(os.tmpdir(), `piarc-t27-settings-${String(process.pid)}`);
    const settings = SettingsManager.create(dir, dir, { projectTrusted: false });
    // What T14 did: an override before the session's resources load is lost on reload.
    settings.applyOverrides({ retry: { provider: { maxRetries: 0 } } });
    await settings.reload();
    expect(settings.getSettings().retry).toBeUndefined();
    const model = { contextWindow: 32_000, maxTokens: 4096, provider: 'p', id: 'm' };
    const manager = SessionManager.inMemory('/w');
    const reminders = new Reminders();
    const compaction: SessionCompaction = new SessionCompaction({
      sessionId: 's',
      manager,
      cwd: '/w',
      session: () => ({ model, settingsManager: settings }) as never,
      reminders,
      memory: new SessionMemory(manager, '/w', DEFAULT_PROFILE, undefined, same, reminders),
      canonical: same,
      usage: () => {
        throw new Error('not used');
      },
      bridge: undefined,
      io: undefined,
      hooks: undefined,
      appended: () => undefined,
      log: () => undefined,
    });
    compaction.apply();
    const applied = settings.getCompactionSettings(model);
    expect(settings.getProviderRetrySettings().maxRetries).toBe(0);
    expect(applied.enabled).toBe(true);
    // Pi compacts when tokens > window − reserve: exactly from the threshold 14,904.
    expect(32_000 - applied.reserveTokens).toBe(14_904 - 1);
  });
});
