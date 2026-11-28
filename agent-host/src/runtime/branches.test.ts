import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BRANCH_ENTRY,
  branchPoints,
  entriesFromTurn,
  forkedManager,
  rewindToTurn,
  summarizeFromTurn,
  switchTo,
  turnText,
} from './branches.js';
import { projectHistory } from './history.js';
import { INPUT_ENTRY } from './input.js';

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function reply(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'piarc-mock',
    model: 'mock-large',
    usage,
    stopReason: 'stop',
    timestamp: 2,
  };
}

/** One turn as the registry writes it: the input record with `from`, the message, a reply. */
function turn(manager: SessionManager, turnId: string, text: string): string {
  const from = manager.getLeafId();
  manager.appendCustomEntry(INPUT_ENTRY, { turnId, from });
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 });
  return manager.appendMessage(reply(`reply to ${text}`));
}

function texts(manager: SessionManager): string[] {
  return projectHistory(manager.getBranch(), (t) => t, false, true).flatMap(({ item }) =>
    item.type === 'userMessage' || item.type === 'agentMessage' ? [item.text] : [item.type],
  );
}

describe('branches', () => {
  it('rewinds before a turn, keeps the old branch and switches between branches', () => {
    const m = SessionManager.inMemory('/w');
    turn(m, 't1', 'first');
    const second = turn(m, 't2', 'second');
    expect(branchPoints(m)).toEqual([]);

    expect(rewindToTurn(m, 't2')).toBe('second');
    expect(texts(m)).toEqual(['first', 'reply to first']);
    const leaf = m.getLeafEntry();
    expect(leaf?.type === 'custom' && leaf.customType).toBe(BRANCH_ENTRY);
    // Rewound and nothing sent yet: the old branch is offered at the end.
    expect(branchPoints(m)).toEqual([
      { options: [{ entryId: second, turnId: 't2', preview: 'second' }] },
    ]);

    const third = turn(m, 't3', 'third');
    expect(texts(m)).toEqual(['first', 'reply to first', 'third', 'reply to third']);
    expect(branchPoints(m)).toEqual([
      {
        turnId: 't3',
        index: 1,
        options: [
          { entryId: second, turnId: 't2', preview: 'second' },
          { entryId: third, turnId: 't3', preview: 'third' },
        ],
      },
    ]);
    expect(m.getEntries().length, 'nothing was deleted').toBe(10);

    switchTo(m, second);
    expect(texts(m)).toEqual(['first', 'reply to first', 'second', 'reply to second']);
    expect(branchPoints(m)[0]).toMatchObject({ turnId: 't2', index: 0 });
    // Continuing on the old branch: its tip moves to the newest entry below it.
    const fourth = turn(m, 't4', 'fourth');
    expect(branchPoints(m)[0]?.options[0]?.entryId).toBe(fourth);
  });

  it('summarizes a turn and what follows into a branch summary next to it', async () => {
    const m = SessionManager.inMemory('/w');
    turn(m, 't1', 'first');
    turn(m, 't2', 'second');
    turn(m, 't3', 'third');
    const { entries } = entriesFromTurn(m, 't2');
    expect(entries.filter((e) => e.type === 'message')).toHaveLength(4);
    let seen = 0;
    await summarizeFromTurn(m, 't2', (summarized) => {
      seen = summarized.length;
      return Promise.resolve({ summary: '## Task goal\nSecond and third.', details: {} });
    });
    expect(seen).toBe(entries.length);
    expect(texts(m)).toEqual(['first', 'reply to first', 'contextCompaction']);
    const context = m.buildSessionContext().messages;
    expect(context.at(-1)?.role).toBe('branchSummary');
    expect(branchPoints(m)).toEqual([
      { options: [expect.objectContaining({ turnId: 't2', preview: 'second' })] },
    ]);
  });

  it('refuses turns of another branch and unknown entries', () => {
    const m = SessionManager.inMemory('/w');
    turn(m, 't1', 'first');
    turn(m, 't2', 'second');
    rewindToTurn(m, 't2');
    expect(() => rewindToTurn(m, 't2')).toThrow(/not on the session's current branch/);
    expect(() => {
      switchTo(m, 'missing');
    }).toThrow(/no entry missing/);
  });

  it('starts older turns at their record’s parent and the first turn at the start', () => {
    const m = SessionManager.inMemory('/w');
    m.appendCustomEntry(INPUT_ENTRY, { turnId: 'old' });
    m.appendMessage({ role: 'user', content: [{ type: 'text', text: 'legacy' }], timestamp: 1 });
    m.appendMessage(reply('ok'));
    expect(turnText(m.getBranch(), m.getBranch()[0]?.id ?? '')).toBe('legacy');
    expect(rewindToTurn(m, 'old')).toBe('legacy');
    expect(texts(m)).toEqual([]);
  });
});

describe('forkedManager', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('copies the conversation up to where a turn started, or starts empty before the first', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'piarc branches 中文 '));
    dirs.push(dir);
    const m = SessionManager.create('/w', dir);
    turn(m, 't1', 'first');
    turn(m, 't2', 'second');
    const file = m.getSessionFile();
    const forked = forkedManager(m.getSessionId(), '/w', file, undefined, 't2');
    expect(texts(forked)).toEqual(['first', 'reply to first']);
    expect(forked.getSessionId()).not.toBe(m.getSessionId());
    const empty = forkedManager(m.getSessionId(), '/w', file, undefined, 't1');
    expect(empty.getEntries()).toEqual([]);
    expect(() => forkedManager('s', '/w', undefined, undefined, 't1')).toThrow(/no saved/);
  });
});
