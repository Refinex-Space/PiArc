// The log view's operations (design addendum 9.1): tags, cherry-pick, revert, reset and undo of
// the last commit, stashes, and deleting a remote branch (with a notice that pushes it back).
// Everything goes through `actions.run`, so failures, progress and refreshes behave like the
// commit view's; the main process asks natively before a hard reset, a stash drop and a remote
// deletion.
import { useMemo } from 'react';

import { useT } from '../../app/app-context.js';
import { dismissNotice, pushNotice, type GitActions } from './actions.js';
import type { Reply, OpResult, StashEntry } from './protocol.js';
import { gitSession } from './state.js';

export type ResetMode = 'soft' | 'mixed' | 'hard' | 'keep';

/** Seven characters of a commit id, as the log shows it. */
export function shortId(sha: string): string {
  return sha.slice(0, 7);
}

export function useHistoryActions(sessionId: string, actions: GitActions) {
  const t = useT();
  return useMemo(() => {
    const conflicts = (reply: Reply<OpResult>) => {
      if (reply.ok && reply.value.conflicts.length > 0) {
        pushNotice(sessionId, {
          tone: 'error',
          text: t('git.notice.conflicts', { count: reply.value.conflicts.length }),
          actions: [],
        });
        return true;
      }
      return false;
    };
    const pick = async (op: 'cherryPick' | 'revert', sha: string) => {
      const reply = await actions.run(
        { op, sha },
        { label: t(op === 'cherryPick' ? 'git.progress.cherryPick' : 'git.progress.revert') },
      );
      if (!conflicts(reply) && reply.ok) {
        pushNotice(sessionId, {
          tone: 'info',
          text: t(op === 'cherryPick' ? 'git.notice.cherryPicked' : 'git.notice.reverted', {
            short: shortId(sha),
          }),
          actions: [],
        });
      }
      return reply;
    };
    const deleteRemoteBranch = async (remote: string, branch: string) => {
      const reply = await actions.run(
        { op: 'deleteRemoteBranch', remote, branch },
        { label: t('git.progress.deleteRemote', { branch }) },
      );
      const gone = reply.ok ? reply.value.deletedRemote : undefined;
      if (gone !== undefined) {
        const noticeId = pushNotice(sessionId, {
          tone: 'info',
          text: t('git.notice.remoteBranchDeleted', { branch: gone.branch, remote: gone.remote }),
          actions: [
            {
              label: t('git.notice.restoreBranch'),
              testId: 'git-notice-restore-remote',
              run: () => {
                dismissNotice(sessionId, noticeId);
                void actions.run(
                  { op: 'restoreRemoteBranch', ...gone },
                  { done: t('git.notice.remoteBranchRestored', { branch: gone.branch }) },
                );
              },
            },
          ],
        });
      }
      return reply;
    };
    const stashApply = async (entry: StashEntry, pop: boolean) => {
      const reply = await actions.run(
        { op: 'stashApply', index: entry.index, oid: entry.oid, ...(pop ? { pop } : {}) },
        { label: t(pop ? 'git.progress.stashPop' : 'git.progress.stashApply') },
      );
      if (reply.ok && reply.value.stashKept === true) {
        pushNotice(sessionId, {
          tone: 'error',
          text: t('git.notice.stashKept', { count: reply.value.conflicts.length }),
          actions: [],
        });
      } else if (reply.ok) {
        pushNotice(sessionId, {
          tone: 'info',
          text: t(pop ? 'git.notice.stashPopped' : 'git.notice.stashApplied'),
          actions: [],
        });
      }
      return reply;
    };
    return {
      cherryPick: (sha: string) => pick('cherryPick', sha),
      revert: (sha: string) => pick('revert', sha),
      reset: (sha: string, mode: ResetMode, expect: string) =>
        actions.run(
          { op: 'reset', sha, mode, expect },
          { done: t('git.notice.reset', { short: shortId(sha) }) },
        ),
      undoCommit: (expect: string) =>
        actions.run({ op: 'undoCommit', expect }, { done: t('git.notice.commitUndone') }),
      createTag: (name: string, sha: string, message: string) =>
        actions.run(
          message.trim() === ''
            ? { op: 'createTag', name, sha }
            : { op: 'createTag', name, sha, message },
          { done: t('git.notice.tagCreated', { name }) },
        ),
      stashPush: (message: string, includeUntracked: boolean) =>
        actions.run(
          {
            op: 'stashPush',
            ...(message.trim() === '' ? {} : { message: message.trim() }),
            ...(includeUntracked ? { includeUntracked } : {}),
          },
          { label: t('git.progress.stash'), done: t('git.notice.stashed') },
        ),
      stashApply,
      stashDrop: (entry: StashEntry) =>
        actions.run(
          { op: 'stashDrop', index: entry.index, oid: entry.oid },
          { done: t('git.notice.stashDropped') },
        ),
      stashBranch: async (entry: StashEntry, name: string) => {
        const reply = await actions.run(
          { op: 'stashBranch', index: entry.index, oid: entry.oid, name },
          { done: t('git.notice.branchCreated', { name }) },
        );
        conflicts(reply);
        return reply;
      },
      deleteRemoteBranch,
      refresh: () => {
        gitSession(sessionId).changed();
      },
    };
  }, [actions, sessionId, t]);
}

export type HistoryActions = ReturnType<typeof useHistoryActions>;
