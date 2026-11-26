// The Git panel's write operations (ADR-0085): one entry that sends a request with an operation
// id (progress and cancel), refreshes the repository afterwards, and turns a failure into what
// the panel shows next. A plain failure becomes a notice in the panel; failures that ask the
// user to choose (local changes in the way of a checkout, a rejected push, no upstream yet, no
// pull mode configured) become a prompt the panel answers with a dialog. Notices with an undo
// (rolled back files, a deleted branch) stay longer. The main process asks natively before
// anything that loses work; nothing here confirms on its own.
import { useCallback, useMemo, useSyncExternalStore } from 'react';

import { useT } from '../../app/app-context.js';
import type { MessageId } from '../../../shared/i18n/index.js';
import { showPanel } from '../../shell/registry.js';
import { showTerminal } from '../../terminal/panel-state.js';
import {
  gitCall,
  opResultOf,
  type Failure,
  type FailureKind,
  type OpResult,
  type Reply,
} from './protocol.js';
import { gitSession, newOpId } from './state.js';

/** How long a notice stays: plain ones, and ones with an undo. */
export const NOTICE_MS = 8000;
export const UNDO_NOTICE_MS = 20_000;

export interface NoticeAction {
  readonly label: string;
  readonly testId: string;
  readonly run: () => void;
}

export interface GitNotice {
  readonly id: string;
  readonly tone: 'info' | 'error';
  readonly text: string;
  /** Git's own words (stderr), shown collapsed. */
  readonly detail?: string | undefined;
  readonly actions: readonly NoticeAction[];
  readonly timeout: number;
}

export interface PushTarget {
  readonly remote: string;
  readonly branch: string;
}

/** A choice the panel asks for with a dialog. */
export type GitPrompt =
  | {
      readonly kind: 'checkout';
      readonly target: string;
      readonly paths: readonly string[];
      readonly untracked: boolean;
    }
  | { readonly kind: 'pushRejected'; readonly target?: PushTarget | undefined }
  | { readonly kind: 'pushTarget'; readonly branch: string }
  | { readonly kind: 'pullMode'; readonly thenPush?: PushTarget | undefined | null }
  | {
      readonly kind: 'branchName';
      readonly mode: 'create' | 'rename';
      readonly from?: string | undefined;
      readonly start?: string | undefined;
    };

interface Board {
  readonly notices: readonly GitNotice[];
  readonly prompt: GitPrompt | undefined;
  /** Running operations by id, with the label shown while they run. */
  readonly running: ReadonlyMap<string, string>;
}

const EMPTY_BOARD: Board = { notices: [], prompt: undefined, running: new Map() };
const boards = new Map<string, Board>();
const listeners = new Map<string, Set<() => void>>();
let noticeCounter = 0;

function boardOf(sessionId: string): Board {
  return boards.get(sessionId) ?? EMPTY_BOARD;
}

function setBoard(sessionId: string, change: Partial<Board>): void {
  boards.set(sessionId, { ...boardOf(sessionId), ...change });
  for (const listener of listeners.get(sessionId) ?? []) listener();
}

export function pushNotice(
  sessionId: string,
  notice: Omit<GitNotice, 'id' | 'timeout'> & { readonly timeout?: number },
): string {
  noticeCounter += 1;
  const id = `n${String(noticeCounter)}`;
  const full: GitNotice = {
    ...notice,
    id,
    timeout: notice.timeout ?? (notice.actions.length > 0 ? UNDO_NOTICE_MS : NOTICE_MS),
  };
  // At most three at a time; the oldest gives way.
  setBoard(sessionId, { notices: [...boardOf(sessionId).notices, full].slice(-3) });
  return id;
}

export function dismissNotice(sessionId: string, id: string): void {
  setBoard(sessionId, { notices: boardOf(sessionId).notices.filter((n) => n.id !== id) });
}

export function setPrompt(sessionId: string, prompt: GitPrompt | undefined): void {
  setBoard(sessionId, { prompt });
}

/** The session's notices, prompt and running operations. */
export function useGitBoard(sessionId: string): Board {
  const subscribe = useCallback(
    (listener: () => void) => {
      let set = listeners.get(sessionId);
      if (set === undefined) {
        set = new Set();
        listeners.set(sessionId, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    [sessionId],
  );
  return useSyncExternalStore(subscribe, () => boardOf(sessionId));
}

/** The message id that explains a failure kind. */
export function failureText(kind: FailureKind): MessageId {
  return `git.failure.${kind}`;
}

/** Opens a terminal in the session and copies `command` for the user to run there. */
export function runInTerminal(sessionId: string, command: string | undefined): void {
  if (command !== undefined) void navigator.clipboard.writeText(command);
  void window.piarc
    .openSessionTerminal(sessionId, { cols: 80, rows: 24, cellWidth: 8, cellHeight: 16 })
    .then((opened) => {
      showPanel('terminal');
      showTerminal(sessionId, opened.taskId);
    });
}

type Request = Record<string, unknown> & { readonly op: string };

export interface RunOptions {
  /** Shown while the operation runs (the progress line). */
  readonly label?: string | undefined;
  /** Leave failures of these kinds to the caller. */
  readonly handled?: readonly FailureKind[] | undefined;
  /** A notice after success. */
  readonly done?: string | undefined;
}

export function useGitActions(sessionId: string) {
  const t = useT();
  const session = gitSession(sessionId);

  const report = useCallback(
    (failure: Failure) => {
      if (failure.kind === 'cancelled') return;
      const paths =
        failure.paths.length === 0
          ? ''
          : `\n${failure.paths.slice(0, 5).join('\n')}${failure.paths.length > 5 ? '\n…' : ''}`;
      const actions: NoticeAction[] = [];
      if (failure.kind === 'auth' || failure.kind === 'identity' || failure.kind === 'hookFailed') {
        actions.push({
          label: t('git.notice.runInTerminal'),
          testId: 'git-notice-terminal',
          run: () => {
            runInTerminal(sessionId, failure.command);
            // Say "copied" only when there was a command to copy.
            if (failure.command !== undefined) {
              pushNotice(sessionId, {
                tone: 'info',
                text: t('git.notice.commandCopied'),
                actions: [],
              });
            }
          },
        });
      }
      pushNotice(sessionId, {
        tone: 'error',
        text: `${t(failureText(failure.kind), { count: failure.sessions.length })}${paths}`,
        detail: failure.message,
        actions,
        timeout: actions.length > 0 ? UNDO_NOTICE_MS : NOTICE_MS,
      });
    },
    [sessionId, t],
  );

  const run = useCallback(
    async (request: Request, options: RunOptions = {}): Promise<Reply<OpResult>> => {
      const opId = newOpId();
      const running = new Map(boardOf(sessionId).running);
      running.set(opId, options.label ?? '');
      setBoard(sessionId, { running });
      let reply: Reply<OpResult>;
      try {
        reply = await gitCall(sessionId, request, opResultOf, opId);
      } finally {
        const after = new Map(boardOf(sessionId).running);
        after.delete(opId);
        setBoard(sessionId, { running: after });
        session.setProgress(opId, undefined);
      }
      // A failed write may still have changed the repository (a conflicted pull).
      session.changed();
      if (!reply.ok) {
        if (!(options.handled ?? []).includes(reply.failure.kind)) report(reply.failure);
      } else if (options.done !== undefined) {
        pushNotice(sessionId, { tone: 'info', text: options.done, actions: [] });
      }
      return reply;
    },
    [sessionId, session, report],
  );

  return useMemo(() => {
    const rollback = async (paths: readonly string[]) => {
      const reply = await run({ op: 'rollback', paths });
      if (reply.ok && reply.value.restoreId !== undefined) {
        const restoreId = reply.value.restoreId;
        const noticeId = pushNotice(sessionId, {
          tone: 'info',
          text: t('git.notice.rolledBack', { count: paths.length }),
          actions: [
            {
              label: t('git.notice.undo'),
              testId: 'git-notice-undo',
              run: () => {
                dismissNotice(sessionId, noticeId);
                void run({ op: 'undoRollback', restoreId }, { done: t('git.notice.restored') });
              },
            },
          ],
        });
      }
      return reply;
    };

    const checkout = async (target: string, mode?: 'smart' | 'force') => {
      const reply = await run(
        mode === undefined ? { op: 'checkout', target } : { op: 'checkout', target, mode },
        {
          label: t('git.progress.checkout', { target }),
          handled: ['localChanges', 'untrackedOverwritten'],
        },
      );
      if (
        !reply.ok &&
        (reply.failure.kind === 'localChanges' || reply.failure.kind === 'untrackedOverwritten')
      ) {
        setPrompt(sessionId, {
          kind: 'checkout',
          target,
          paths: reply.failure.paths,
          untracked: reply.failure.kind === 'untrackedOverwritten',
        });
      } else if (reply.ok && reply.value.keptStash !== undefined) {
        pushNotice(sessionId, {
          tone: 'error',
          text: t('git.notice.keptStash', { stash: reply.value.keptStash }),
          actions: [],
        });
      } else if (reply.ok && reply.value.conflicts.length > 0) {
        pushNotice(sessionId, {
          tone: 'error',
          text: t('git.notice.conflicts', { count: reply.value.conflicts.length }),
          actions: [],
        });
      }
      return reply;
    };

    const deleteBranch = async (name: string, force = false) => {
      const reply = await run(
        force ? { op: 'deleteBranch', name, force } : { op: 'deleteBranch', name },
        {
          handled: ['notMerged'],
        },
      );
      if (!reply.ok && reply.failure.kind === 'notMerged') {
        // The main process shows how many commits would be lost before it goes ahead.
        return deleteBranch(name, true);
      }
      const deleted = reply.ok ? reply.value.deleted : undefined;
      if (deleted !== undefined) {
        const noticeId = pushNotice(sessionId, {
          tone: 'info',
          text: t('git.notice.branchDeleted', { name: deleted.name }),
          actions: [
            {
              label: t('git.notice.restoreBranch'),
              testId: 'git-notice-restore-branch',
              run: () => {
                dismissNotice(sessionId, noticeId);
                void run(
                  deleted.upstream === undefined
                    ? { op: 'restoreBranch', name: deleted.name, oid: deleted.oid }
                    : {
                        op: 'restoreBranch',
                        name: deleted.name,
                        oid: deleted.oid,
                        upstream: deleted.upstream,
                      },
                  { done: t('git.notice.branchRestored', { name: deleted.name }) },
                );
              },
            },
          ],
        });
      }
      return reply;
    };

    const push = async (target?: PushTarget, force = false): Promise<Reply<OpResult>> => {
      const request: Request = {
        op: 'push',
        ...(target === undefined ? {} : { target }),
        ...(force ? { force } : {}),
      };
      const reply = await run(request, {
        label: t('git.progress.push'),
        handled: ['rejected', 'noUpstream'],
        done: t('git.notice.pushed'),
      });
      if (!reply.ok && reply.failure.kind === 'rejected') {
        setPrompt(sessionId, { kind: 'pushRejected', target });
      } else if (!reply.ok && reply.failure.kind === 'noUpstream') {
        const branch = session.snapshot().status.value?.repository.branch;
        if (branch !== undefined) setPrompt(sessionId, { kind: 'pushTarget', branch });
      }
      return reply;
    };

    const pull = async (mode?: 'merge' | 'rebase' | 'ffOnly', thenPush?: PushTarget | null) => {
      const reply = await run(mode === undefined ? { op: 'pull' } : { op: 'pull', mode }, {
        label: t('git.progress.pull'),
        handled: ['choosePullMode'],
      });
      if (!reply.ok && reply.failure.kind === 'choosePullMode') {
        setPrompt(sessionId, { kind: 'pullMode', thenPush });
      } else if (reply.ok && reply.value.conflicts.length > 0) {
        pushNotice(sessionId, {
          tone: 'error',
          text: t('git.notice.conflicts', { count: reply.value.conflicts.length }),
          actions: [],
        });
      } else if (reply.ok && thenPush !== undefined) {
        await push(thenPush ?? undefined);
      } else if (reply.ok) {
        pushNotice(sessionId, { tone: 'info', text: t('git.notice.pulled'), actions: [] });
      }
      return reply;
    };

    return {
      run,
      report,
      rollback,
      checkout,
      deleteBranch,
      push,
      pull,
      fetch: () =>
        run({ op: 'fetch' }, { label: t('git.progress.fetch'), done: t('git.notice.fetched') }),
      stage: (paths: readonly string[]) => run({ op: 'stage', paths }),
      unstage: (paths: readonly string[]) => run({ op: 'unstage', paths }),
      markResolved: (paths: readonly string[]) => run({ op: 'markResolved', paths }),
      sequence: (op: 'continue' | 'abort' | 'skip') =>
        run({ op }, { label: t(`git.progress.${op}`) }),
      createBranch: (name: string, start: string | undefined, checkout: boolean) =>
        run(
          { op: 'createBranch', name, ...(start === undefined ? {} : { start }), checkout },
          { done: t('git.notice.branchCreated', { name }) },
        ),
      renameBranch: (from: string, to: string) => run({ op: 'renameBranch', from, to }),
      setUpstream: (branch: string, upstream: string | undefined) =>
        run(
          upstream === undefined
            ? { op: 'setUpstream', branch }
            : { op: 'setUpstream', branch, upstream },
        ),
      cancel: (opId: string) => {
        void window.piarc.cancelGit(opId);
      },
    };
  }, [run, report, sessionId, session, t]);
}

export type GitActions = ReturnType<typeof useGitActions>;
