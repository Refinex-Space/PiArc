import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => null } }));

import { IPC_CHANNELS } from '../../shared/ipc.js';
import { Translator } from '../../shared/i18n/index.js';
import {
  confirmationFor,
  confirmationText,
  gitRequest,
  registerGitHandlers,
  reveal,
  type GitCore,
} from './git-ipc.js';
import { NativeConfirm } from './plugins-ipc.js';

type Handler = (event: { sender: unknown }, args: unknown[]) => unknown;

function harness(describeAnswer: Record<string, unknown> = { result: {} }, recentInput = true) {
  const handlers = new Map<string, Handler>();
  const register = ((channel: string, handler: Handler) => {
    handlers.set(channel, handler);
  }) as unknown as Parameters<typeof registerGitHandlers>[0];
  const sent: { session: string; json: Record<string, unknown> }[] = [];
  const core: GitCore = {
    gitRequest: (session: string, json: string) => {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      sent.push({ session, json: parsed });
      const request = parsed.request as Record<string, unknown>;
      return Promise.resolve(
        JSON.stringify(request.op === 'describe' ? describeAnswer : { result: { ok: true } }),
      );
    },
    cancelGit: () => true,
  };
  const confirm = new NativeConfirm();
  const inputs: unknown[] = [];
  const input = {
    requireInput: (_contents: unknown, target?: unknown) => {
      inputs.push(target);
      if (!recentInput) throw new Error('no recent input in this window');
    },
  };
  registerGitHandlers(
    register,
    core,
    () => new Translator('en'),
    confirm,
    input,
    () => 'zh-CN',
  );
  const call = (args: unknown[]) => {
    const handler = handlers.get(IPC_CHANNELS.gitRequest);
    if (handler === undefined) throw new Error('not registered');
    return handler({ sender: {} }, args);
  };
  return { call, sent, confirm, inputs };
}

describe('Git panel IPC', () => {
  it('keeps known members and refuses malformed requests', () => {
    expect(gitRequest({ op: 'stage', paths: ['a.txt'], extra: 1 })).toEqual({
      op: 'stage',
      paths: ['a.txt'],
    });
    expect(gitRequest({ op: 'changes', scope: { kind: 'branch', base: 'main' } })).toEqual({
      op: 'changes',
      scope: { kind: 'branch', base: 'main' },
    });
    expect(() => gitRequest({ op: 'stage', paths: [] })).toThrow();
    expect(() => gitRequest({ op: 'stage', paths: ['a\0b'] })).toThrow();
    expect(() => gitRequest({ op: 'checkout', target: '--upload-pack=x' })).toThrow();
    expect(() => gitRequest({ op: 'deleteBranch', name: 'a\nb' })).toThrow();
    expect(() => gitRequest({ op: 'push', target: { remote: '-x', branch: 'b' } })).toThrow();
    expect(() => gitRequest({ op: 'exec', command: 'rm' })).toThrow('unknown Git operation');
    expect(() => gitRequest('stage')).toThrow();
  });

  it('confirms only operations that lose work', () => {
    expect(confirmationFor({ op: 'rollback', paths: ['a'] })).toEqual({
      kind: 'rollback',
      paths: ['a'],
    });
    expect(confirmationFor({ op: 'checkout', target: 'x', mode: 'force' })?.kind).toBe(
      'forceCheckout',
    );
    expect(confirmationFor({ op: 'checkout', target: 'x', mode: 'smart' })).toBeUndefined();
    expect(confirmationFor({ op: 'push', force: true })?.kind).toBe('forcePush');
    expect(confirmationFor({ op: 'push' })).toBeUndefined();
    expect(confirmationFor({ op: 'deleteBranch', name: 'x', force: true })?.kind).toBe(
      'deleteBranch',
    );
    expect(confirmationFor({ op: 'deleteBranch', name: 'x' })).toBeUndefined();
    expect(confirmationFor({ op: 'stage', paths: ['a'] })).toBeUndefined();
  });

  it('shows bidirectional controls as escapes in confirmations', () => {
    expect(reveal('main‮txt.exe')).toBe('main\\u{202e}txt.exe');
    const { text } = confirmationText(
      new Translator('en'),
      { kind: 'forcePush' },
      { branch: 'feat⁦x', remote: 'origin', remoteOid: 'a'.repeat(40), localOid: 'b'.repeat(40) },
    );
    expect(text.message).toContain('feat\\u{2066}x');
    expect(text.detail).toContain('aaaaaaaaaaaa');
  });

  it('asks natively, sends nothing on cancel and passes the shown lease on confirm', async () => {
    const facts = {
      branch: 'feature',
      remote: 'origin',
      remoteOid: 'c'.repeat(40),
      localOid: 'd'.repeat(40),
    };
    const { call, sent, confirm, inputs } = harness({ result: facts });
    confirm.answerNext(false);
    const cancelled = await call(['s1', { op: 'push', force: true }, 'op-1']);
    expect(JSON.parse(String(cancelled))).toEqual({ failure: { kind: 'cancelled' } });
    expect(sent.map((s) => (s.json.request as { op: string }).op)).toEqual(['describe']);
    expect(confirm.shown()[0]?.message).toContain('Force push feature to origin');
    expect(inputs).toEqual(['s1']);

    confirm.answerNext(true);
    await call(['s1', { op: 'push', force: true }, 'op-2']);
    const last = sent.at(-1)?.json;
    expect(last?.opId).toBe('op-2');
    expect(last?.request).toEqual({ op: 'push', force: true, expect: 'c'.repeat(40) });
  });

  it('stops at Core’s refusal before asking', async () => {
    const { call, sent, confirm } = harness({ result: { refused: { kind: 'protected' } } });
    const answer = await call(['s1', { op: 'push', force: true }]);
    expect(JSON.parse(String(answer))).toEqual({ failure: { kind: 'protected' } });
    expect(confirm.shown()).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it('fills the interface language; reads need no input, a commit message does', async () => {
    const { call, sent, inputs } = harness();
    await call(['s1', { op: 'commitMessage', instructions: 'x', language: 'en' }]);
    expect(sent[0]?.json.request).toEqual({
      op: 'commitMessage',
      instructions: 'x',
      language: 'zh-CN',
    });
    // It sends the staged changes to the model provider: only on the user's click (ADR-0086).
    expect(inputs).toEqual(['s1']);
    await call(['s1', { op: 'status' }]);
    expect(inputs).toEqual(['s1']);
    await expect(Promise.resolve().then(() => call(['../s', { op: 'status' }]))).rejects.toThrow();
  });

  it('sends no write and no commit message without recent real input', async () => {
    const { call, sent } = harness({ result: {} }, false);
    for (const request of [
      { op: 'stage', paths: ['a.txt'] },
      { op: 'commit', message: 'm' },
      { op: 'push' },
      { op: 'commitMessage', instructions: 'x' },
    ]) {
      await expect(Promise.resolve().then(() => call(['s1', request]))).rejects.toThrow(
        'no recent input',
      );
    }
    expect(sent).toEqual([]);
    await call(['s1', { op: 'status' }]);
    expect(sent).toHaveLength(1);
  });

  it('checks the history requests and refuses option-like or overlong values', () => {
    expect(
      gitRequest({ op: 'log', revs: { kind: 'ref', name: 'origin/main' }, skip: 200, extra: 1 }),
    ).toEqual({ op: 'log', revs: { kind: 'ref', name: 'origin/main' }, skip: 200 });
    expect(gitRequest({ op: 'fetch', background: true })).toEqual({
      op: 'fetch',
      background: true,
    });
    expect(gitRequest({ op: 'stashApply', index: 0, oid: 'a'.repeat(40), pop: true })).toEqual({
      op: 'stashApply',
      index: 0,
      oid: 'a'.repeat(40),
      pop: true,
    });
    expect(() => gitRequest({ op: 'log', revs: { kind: 'ref', name: '--all' } })).toThrow();
    expect(() => gitRequest({ op: 'log', revs: { kind: 'head' }, limit: 201 })).toThrow();
    expect(() =>
      gitRequest({ op: 'log', revs: { kind: 'head' }, text: 'x'.repeat(201) }),
    ).toThrow();
    expect(() => gitRequest({ op: 'reset', sha: 'a', mode: 'merge', expect: 'b' })).toThrow();
    expect(() => gitRequest({ op: 'stashDrop', index: -1, oid: 'a' })).toThrow();
    expect(() => gitRequest({ op: 'deleteRemoteBranch', remote: '-o', branch: 'x' })).toThrow();
  });

  it('confirms a hard reset, a stash drop and a remote deletion natively', async () => {
    expect(confirmationFor({ op: 'reset', sha: 'a', mode: 'soft', expect: 'b' })).toBeUndefined();
    expect(confirmationFor({ op: 'reset', sha: 'a', mode: 'hard', expect: 'b' })).toEqual({
      kind: 'reset',
      sha: 'a',
      mode: 'hard',
    });
    expect(confirmationFor({ op: 'stashDrop', index: 1, oid: 'c' })?.kind).toBe('stashDrop');
    const facts = { branch: 'topic', remote: 'origin', remoteOid: 'e'.repeat(40) };
    const { call, sent, confirm } = harness({ result: facts });
    confirm.answerNext(true);
    await call(['s1', { op: 'deleteRemoteBranch', remote: 'origin', branch: 'topic' }]);
    expect(confirm.shown()[0]?.message).toBe('Delete topic on origin?');
    expect(sent.at(-1)?.json.request).toEqual({
      op: 'deleteRemoteBranch',
      remote: 'origin',
      branch: 'topic',
      expect: 'e'.repeat(40),
    });
    const { text } = confirmationText(
      new Translator('en'),
      { kind: 'reset', sha: 'f'.repeat(40), mode: 'hard' },
      { branch: 'main', leaving: 2, pushed: 1, paths: ['a.txt'] },
    );
    expect(text.message).toBe('Reset main to ffffffffffff and discard local changes?');
    expect(text.detail).toContain('2 commits leave the branch (1 already pushed');
    expect(text.detail).toContain('• a.txt');
  });

  it('checks merges, conflict resolutions and interactive rebases', async () => {
    expect(gitRequest({ op: 'merge', branch: 'topic', mode: 'noFf', strategy: 'ours' })).toEqual({
      op: 'merge',
      branch: 'topic',
      mode: 'noFf',
    });
    expect(() => gitRequest({ op: 'merge', branch: '--strategy=ours', mode: 'ff' })).toThrow();
    expect(() => gitRequest({ op: 'resolveConflict', path: 'a', take: 'both' })).toThrow();
    expect(
      gitRequest({ op: 'saveResolution', path: 'a.ts', content: 'x\n\ty', expect: 'absent' }),
    ).toEqual({ op: 'saveResolution', path: 'a.ts', content: 'x\n\ty', expect: 'absent' });
    expect(() =>
      gitRequest({
        op: 'saveResolution',
        path: 'a.ts',
        content: 'x'.repeat(5 * 1024 * 1024 + 1),
        expect: 'absent',
      }),
    ).toThrow();
    const steps = [{ sha: 'a'.repeat(40), action: 'reword', message: 'm', extra: 1 }];
    expect(gitRequest({ op: 'rebaseInteractive', head: 'b'.repeat(40), steps })).toEqual({
      op: 'rebaseInteractive',
      head: 'b'.repeat(40),
      steps: [{ sha: 'a'.repeat(40), action: 'reword', message: 'm' }],
    });
    expect(() =>
      gitRequest({ op: 'rebaseInteractive', head: 'b', steps: [{ sha: 'a', action: 'exec' }] }),
    ).toThrow();
    expect(() => gitRequest({ op: 'rebaseInteractive', head: 'b', steps: [] })).toThrow();
    // Reading the sides needs no click; writing the result does.
    const { call, sent } = harness({ result: {} }, false);
    await call(['s1', { op: 'conflictSides', path: 'a.ts' }]);
    expect(sent).toHaveLength(1);
    await expect(
      Promise.resolve().then(() =>
        call(['s1', { op: 'resolveConflict', path: 'a.ts', take: 'yours' }]),
      ),
    ).rejects.toThrow('no recent input');
  });

  it('lets an automatic fetch run without a click, and nothing else', async () => {
    const { call, sent } = harness({ result: {} }, false);
    await call(['s1', { op: 'fetch', background: true }]);
    expect(sent.at(-1)?.json.request).toEqual({ op: 'fetch', background: true });
    for (const request of [
      { op: 'fetch' },
      { op: 'stashPush' },
      { op: 'cherryPick', sha: 'a'.repeat(40) },
    ]) {
      await expect(Promise.resolve().then(() => call(['s1', request]))).rejects.toThrow(
        'no recent input',
      );
    }
    await call(['s1', { op: 'log', revs: { kind: 'all' } }]);
    expect(sent).toHaveLength(2);
  });

  it('checks the pull request requests and fills the language of descriptions and reviews', async () => {
    expect(
      gitRequest({ op: 'createPullRequest', title: '--web', body: '## a\n', base: 'main' }),
    ).toEqual({ op: 'createPullRequest', title: '--web', body: '## a\n', base: 'main' });
    expect(() =>
      gitRequest({ op: 'createPullRequest', title: ' ', body: '', base: 'main' }),
    ).toThrow();
    expect(() =>
      gitRequest({ op: 'createPullRequest', title: 'a\nb', body: '', base: 'main' }),
    ).toThrow();
    expect(() =>
      gitRequest({ op: 'createPullRequest', title: 'x'.repeat(257), body: '', base: 'main' }),
    ).toThrow();
    expect(() =>
      gitRequest({ op: 'createPullRequest', title: 't', body: '', base: '--repo=x/y' }),
    ).toThrow();
    expect(() => gitRequest({ op: 'mergePullRequest', number: 0, method: 'squash' })).toThrow();
    expect(() => gitRequest({ op: 'mergePullRequest', number: 1, method: 'auto' })).toThrow();
    expect(() => gitRequest({ op: 'review', scope: { kind: 'commit', sha: 'a' } })).toThrow();
    expect(() =>
      gitRequest({ op: 'prDescription', instructions: 'x'.repeat(8 * 1024 + 1) }),
    ).toThrow();

    const { call, sent, inputs } = harness({ result: {} }, true);
    await call(['s1', { op: 'prDescription', instructions: 'i', base: 'main', language: 'en' }]);
    await call(['s1', { op: 'review', scope: { kind: 'uncommitted' } }]);
    expect(sent.map((s) => s.json.request)).toEqual([
      { op: 'prDescription', instructions: 'i', base: 'main', language: 'zh-CN' },
      { op: 'review', scope: { kind: 'uncommitted' }, language: 'zh-CN' },
    ]);
    // Both send the diff to the model provider: only on a click. The status read needs none.
    expect(inputs).toEqual(['s1', 's1']);
    await call(['s1', { op: 'pullRequest' }]);
    expect(inputs).toHaveLength(2);
  });

  it('merges a pull request only after the native confirmation that names it', async () => {
    const facts = { message: 'Add login', branch: 'main', remote: 'octo/app' };
    const { call, sent, confirm } = harness({ result: facts });
    confirm.answerNext(false);
    const cancelled = await call(['s1', { op: 'mergePullRequest', number: 7, method: 'rebase' }]);
    expect(JSON.parse(String(cancelled))).toEqual({ failure: { kind: 'cancelled' } });
    expect(sent.map((s) => s.json.request)).toEqual([
      { op: 'describe', action: { kind: 'mergePullRequest', number: 7, method: 'rebase' } },
    ]);
    expect(confirm.shown()[0]).toEqual({
      message: 'Merge pull request #7 “Add login”?',
      detail:
        'GitHub merges it into main of octo/app (Rebase and merge). This cannot be undone from PiArc.',
    });
    confirm.answerNext(true);
    await call(['s1', { op: 'mergePullRequest', number: 7, method: 'rebase' }]);
    expect(sent.at(-1)?.json.request).toEqual({
      op: 'mergePullRequest',
      number: 7,
      method: 'rebase',
    });
  });
});
