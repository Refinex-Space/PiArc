// The interactive rebase dialog (design addendum M5): the commits from the chosen one to `HEAD`,
// oldest first, each with an action (pick, reword with a new message, squash, fixup, drop) and
// moved with its buttons or Alt+↑/↓. Core rebases only if `HEAD` and the commits are still those
// the dialog listed; conflicts stop the rebase for the state bar to continue or abort.
import { useEffect, useId, useState, type KeyboardEvent } from 'react';

import { useT } from '../../app/app-context.js';
import { IconButton } from '../../app/IconButton.js';
import { Dialog } from '../../shell/Dialog.js';
import { ArrowUpIcon, ChevronDownIcon } from '../../shell/icons.js';
import { revealBidi } from '../../transcript/reveal.js';
import { pushNotice, setPrompt, type GitActions } from './actions.js';
import { shortId } from './history-actions.js';
import { gitCall, rebasePlanOf, type RebaseCommit, type RebasePlan } from './protocol.js';

export type RebaseAction = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop';
const ACTIONS: readonly RebaseAction[] = ['pick', 'reword', 'squash', 'fixup', 'drop'];

export interface RebaseRow {
  readonly commit: RebaseCommit;
  readonly action: RebaseAction;
  readonly message: string;
}

/** Why the rows cannot be run, if they cannot. */
export function rowsProblem(
  rows: readonly RebaseRow[],
): 'merge' | 'fold' | 'message' | 'empty' | undefined {
  if (rows.some((r) => r.commit.merge)) return 'merge';
  const kept = rows.filter((r) => r.action !== 'drop');
  if (kept.length === 0) return 'empty';
  const first = kept[0];
  if (first !== undefined && (first.action === 'squash' || first.action === 'fixup')) return 'fold';
  if (rows.some((r) => r.action === 'reword' && r.message.trim() === '')) return 'message';
  return undefined;
}

/** `rows` with the row at `index` moved by `by` places (clamped). */
export function moved(rows: readonly RebaseRow[], index: number, by: number): RebaseRow[] {
  const to = Math.max(0, Math.min(rows.length - 1, index + by));
  const next = [...rows];
  const [row] = next.splice(index, 1);
  if (row !== undefined) next.splice(to, 0, row);
  return next;
}

export function RebaseDialog({
  sessionId,
  sha,
  actions,
  onClose,
}: {
  readonly sessionId: string;
  readonly sha: string;
  readonly actions: GitActions;
  readonly onClose: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const [plan, setPlan] = useState<RebasePlan | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [rows, setRows] = useState<readonly RebaseRow[]>([]);
  useEffect(() => {
    void gitCall(sessionId, { op: 'rebasePlan', from: sha }, rebasePlanOf).then((reply) => {
      if (reply.ok) {
        setPlan(reply.value);
        setRows(
          reply.value.commits.map((commit) => ({
            commit,
            action: 'pick',
            message: commit.message,
          })),
        );
      } else {
        setFailure(reply.failure.message ?? reply.failure.kind);
      }
    });
  }, [sessionId, sha]);
  const update = (index: number, change: Partial<RebaseRow>) => {
    setRows((old) => old.map((row, i) => (i === index ? { ...row, ...change } : row)));
  };
  const move = (index: number, by: number) => {
    setRows((old) => moved(old, index, by));
    requestAnimationFrame(() => {
      document
        .querySelectorAll<HTMLElement>('[data-testid=git-rebase-row] select')
        [Math.max(0, Math.min(rows.length - 1, index + by))]?.focus();
    });
  };
  const onRowKey = (event: KeyboardEvent<HTMLElement>, index: number) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    move(index, event.key === 'ArrowUp' ? -1 : 1);
  };
  const problem = rowsProblem(rows);
  const pushed = rows.filter((r) => r.commit.pushed && r.action !== 'pick').length;
  const start = () => {
    if (plan === undefined || problem !== undefined) return;
    onClose();
    const steps = rows.map((row) =>
      row.action === 'reword'
        ? { sha: row.commit.sha, action: row.action, message: row.message }
        : { sha: row.commit.sha, action: row.action },
    );
    void actions
      .run(
        {
          op: 'rebaseInteractive',
          ...(plan.base === undefined ? {} : { base: plan.base }),
          head: plan.head,
          steps,
        },
        { label: t('git.progress.rebase', { onto: shortId(plan.base ?? sha) }) },
      )
      .then((reply) => {
        if (reply.ok && reply.value.conflicts.length > 0) {
          setPrompt(sessionId, { kind: 'conflicts' });
        } else if (reply.ok) {
          pushNotice(sessionId, {
            tone: 'info',
            text: t('git.notice.rebasedInteractive'),
            actions: [],
          });
        }
      });
  };
  return (
    <Dialog labelledBy={titleId} onCancel={onClose} testId="git-rebase-dialog" wide>
      <h2 id={titleId} className="dialog-title">
        {t('git.rebase.title', { count: rows.length })}
      </h2>
      {failure !== undefined ? (
        <p className="error-text" role="alert">
          {revealBidi(failure)}
        </p>
      ) : plan === undefined ? (
        <p className="muted">{t('git.diff.loading')}</p>
      ) : (
        <ol className="git-rebase-rows" aria-label={t('git.rebase.commits')}>
          {rows.map((row, index) => (
            <li
              key={row.commit.sha}
              className={`git-rebase-row is-${row.action}`}
              data-testid="git-rebase-row"
              data-sha={row.commit.sha}
              onKeyDown={(event) => {
                onRowKey(event, index);
              }}
            >
              <select
                className="input git-rebase-action"
                value={row.action}
                aria-label={t('git.rebase.actionOf', { short: shortId(row.commit.sha) })}
                data-testid="git-rebase-action"
                onChange={(event) => {
                  const action = ACTIONS.find((a) => a === event.target.value);
                  if (action !== undefined) update(index, { action });
                }}
              >
                {ACTIONS.map((action) => (
                  <option key={action} value={action}>
                    {t(`git.rebase.${action}`)}
                  </option>
                ))}
              </select>
              <span className="git-rebase-commit">
                <span className="git-rebase-sha">{shortId(row.commit.sha)}</span>{' '}
                {revealBidi(row.commit.subject)}
                {row.commit.pushed ? (
                  <span className="git-ref is-remote">{t('git.rebase.pushed')}</span>
                ) : null}
              </span>
              <span className="git-rebase-move">
                <IconButton
                  label={t('git.rebase.up')}
                  size="xs"
                  disabled={index === 0}
                  onClick={() => {
                    move(index, -1);
                  }}
                >
                  <ArrowUpIcon />
                </IconButton>
                <IconButton
                  label={t('git.rebase.down')}
                  size="xs"
                  disabled={index === rows.length - 1}
                  onClick={() => {
                    move(index, 1);
                  }}
                >
                  <ChevronDownIcon />
                </IconButton>
              </span>
              {row.action !== 'reword' ? null : (
                <textarea
                  className="git-dialog-textarea git-rebase-message"
                  rows={3}
                  aria-label={t('git.rebase.messageOf', { short: shortId(row.commit.sha) })}
                  data-testid="git-rebase-message"
                  value={row.message}
                  onChange={(event) => {
                    update(index, { message: event.target.value });
                  }}
                />
              )}
            </li>
          ))}
        </ol>
      )}
      {problem === undefined || plan === undefined ? null : (
        <p className="error-text" role="alert" data-testid="git-rebase-problem">
          {t(`git.rebase.problem.${problem}`)}
        </p>
      )}
      {pushed === 0 ? null : (
        <p className="muted" data-testid="git-rebase-pushed">
          {t('git.rebase.forcePush', { count: pushed })}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="button" onClick={onClose}>
          {t('dialog.cancel')}
        </button>
        <button
          type="button"
          className="button button-primary"
          disabled={plan === undefined || problem !== undefined}
          data-testid="git-rebase-start"
          onClick={start}
        >
          {t('git.rebase.start')}
        </button>
      </div>
    </Dialog>
  );
}
