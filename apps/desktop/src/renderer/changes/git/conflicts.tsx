// Conflicts (design addendum M3, B6): the state bar of an operation in progress or of conflicts
// left without one (a stash applied with conflicts), the conflicts dialog (take your side,
// theirs, or open the merge view), and the in-app confirmations of aborting, of marking a file
// that still has conflict markers resolved, of a merge's mode and of rebasing a pushed branch.
// "Yours" is the user's side whatever git calls it: Core swaps the sides during a rebase.
import { useId, useState } from 'react';

import { useT } from '../../app/app-context.js';
import { Dialog } from '../../shell/Dialog.js';
import { revealBidi } from '../../transcript/reveal.js';
import {
  openMergeView,
  setPrompt,
  useGitBoard,
  type GitActions,
  type GitPrompt,
} from './actions.js';
import { hasMarkers } from './merge3.js';
import { conflictSidesOf, gitCall, type Repository, type StatusFile } from './protocol.js';

type SideChange = 'modified' | 'added' | 'deleted';

const CLEAN = { kind: 'clean' } as const;

/** What each side did, from git's two-letter code (`UU`, `DU`…), as the user sees the sides. */
export function sidesOf(
  code: string | undefined,
  rebasing: boolean,
): { readonly yours: SideChange; readonly theirs: SideChange } {
  const change = (letter: string | undefined): SideChange =>
    letter === 'D' ? 'deleted' : letter === 'A' ? 'added' : 'modified';
  const ours = change(code?.[0]);
  const theirs = change(code?.[1]);
  return rebasing ? { yours: theirs, theirs: ours } : { yours: ours, theirs };
}

/** The names of the two sides for the user (branch, commit, stash). */
export function sideLabels(repo: Repository): { readonly yours: string; readonly theirs: string } {
  const branch = repo.branch ?? 'HEAD';
  const state = repo.state ?? CLEAN;
  switch (state.kind) {
    case 'merging':
      return { yours: branch, theirs: state.source ?? 'MERGE_HEAD' };
    case 'rebasing':
      return { yours: state.branch ?? branch, theirs: state.onto ?? '' };
    case 'cherryPicking':
    case 'reverting':
      return { yours: branch, theirs: (state.commit ?? '').slice(0, 7) };
    case 'clean':
      return { yours: branch, theirs: 'stash' };
  }
}

/** Marks `paths` resolved, asking first when one of them still has conflict markers. */
export async function markResolved(
  sessionId: string,
  actions: GitActions,
  paths: readonly string[],
): Promise<void> {
  for (const path of paths.slice(0, 20)) {
    const reply = await gitCall(sessionId, { op: 'conflictSides', path }, conflictSidesOf);
    if (reply.ok && reply.value.result !== undefined && hasMarkers(reply.value.result)) {
      setPrompt(sessionId, { kind: 'markResolved', paths });
      return;
    }
  }
  await actions.markResolved(paths);
}

/** A merge, rebase, cherry-pick or revert in progress, or conflicts left without one. */
export function StateBar({
  sessionId,
  repo,
  files,
  actions,
}: {
  readonly sessionId: string;
  readonly repo: Repository;
  readonly files: readonly StatusFile[];
  readonly actions: GitActions;
}) {
  const t = useT();
  const board = useGitBoard(sessionId);
  const state = repo.state ?? CLEAN;
  const conflicts = files.filter(
    (f) => f.conflict !== undefined || f.unstaged === 'conflicted',
  ).length;
  if (state.kind === 'clean' && conflicts === 0) return null;
  const text = (() => {
    switch (state.kind) {
      case 'merging':
        return t('git.state.merging', { source: state.source ?? '' });
      case 'rebasing':
        return state.step !== undefined && state.total !== undefined
          ? t('git.state.rebasingStep', {
              onto: state.onto ?? '',
              step: state.step,
              total: state.total,
            })
          : t('git.state.rebasing', { onto: state.onto ?? '' });
      case 'cherryPicking':
        return t('git.state.cherryPicking', { commit: (state.commit ?? '').slice(0, 7) });
      case 'reverting':
        return t('git.state.reverting', { commit: (state.commit ?? '').slice(0, 7) });
      case 'clean':
        return t('git.state.unresolved');
    }
  })();
  const busy = board.running.size > 0 || !repo.writable;
  return (
    <div className="git-state" role="status" data-testid="git-state" data-state={state.kind}>
      <p className="git-state-text">
        {revealBidi(text)}
        {conflicts > 0 ? (
          <span className="git-state-conflicts">
            {t('git.state.conflicts', { count: conflicts })}
          </span>
        ) : null}
      </p>
      <div className="git-state-actions">
        {conflicts === 0 ? null : (
          <button
            type="button"
            className="button button-small button-primary"
            disabled={busy}
            data-testid="git-resolve"
            onClick={() => {
              setPrompt(sessionId, { kind: 'conflicts' });
            }}
          >
            {t('git.state.resolve')}
          </button>
        )}
        {state.kind === 'clean' ? null : (
          <button
            type="button"
            className="button button-small"
            disabled={busy || conflicts > 0}
            data-testid="git-continue"
            onClick={() => void actions.sequence('continue')}
          >
            {t('git.state.continue')}
          </button>
        )}
        {state.kind !== 'rebasing' ? null : (
          <button
            type="button"
            className="button button-small"
            disabled={busy}
            data-testid="git-skip"
            onClick={() => void actions.sequence('skip')}
          >
            {t('git.state.skip')}
          </button>
        )}
        {state.kind === 'clean' ? null : (
          <button
            type="button"
            className="button button-small"
            disabled={busy}
            data-testid="git-abort"
            onClick={() => {
              setPrompt(sessionId, { kind: 'abort' });
            }}
          >
            {t('git.state.abort')}
          </button>
        )}
      </div>
    </div>
  );
}

function ConfirmFrame({
  title,
  body,
  testId,
  confirm,
  danger = false,
  onConfirm,
  onClose,
}: {
  readonly title: string;
  readonly body: string;
  readonly testId: string;
  readonly confirm: string;
  readonly danger?: boolean;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}) {
  const t = useT();
  const titleId = useId();
  return (
    <Dialog labelledBy={titleId} onCancel={onClose} testId={testId}>
      <h2 id={titleId} className="dialog-title">
        {title}
      </h2>
      <p>{body}</p>
      <div className="dialog-actions">
        <button type="button" className="button" data-autofocus onClick={onClose}>
          {t('dialog.cancel')}
        </button>
        <button
          type="button"
          className={`button ${danger ? 'button-destructive' : 'button-primary'}`}
          data-testid={`${testId}-confirm`}
          onClick={() => {
            onClose();
            onConfirm();
          }}
        >
          {confirm}
        </button>
      </div>
    </Dialog>
  );
}

/** The G4 prompts: conflicts, marking resolved, aborting, merging and rebasing. */
export function ConflictPrompt({
  sessionId,
  prompt,
  repo,
  files,
  actions,
  onClose,
}: {
  readonly sessionId: string;
  readonly prompt: Extract<
    GitPrompt,
    { kind: 'conflicts' | 'markResolved' | 'abort' | 'merge' | 'rebase' }
  >;
  readonly repo: Repository;
  readonly files: readonly StatusFile[];
  readonly actions: GitActions;
  readonly onClose: () => void;
}) {
  const t = useT();
  switch (prompt.kind) {
    case 'conflicts':
      return (
        <ConflictsDialog
          sessionId={sessionId}
          repo={repo}
          files={files}
          actions={actions}
          onClose={onClose}
        />
      );
    case 'markResolved':
      return (
        <ConfirmFrame
          title={t('git.conflicts.markersTitle')}
          body={t('git.conflicts.markersBody', { count: prompt.paths.length })}
          testId="git-markers-dialog"
          confirm={t('git.commit.markResolved')}
          onConfirm={() => void actions.markResolved(prompt.paths)}
          onClose={onClose}
        />
      );
    case 'abort':
      return (
        <ConfirmFrame
          title={t('git.state.abortTitle')}
          body={t('git.state.abortBody')}
          testId="git-abort-dialog"
          confirm={t('git.state.abort')}
          danger
          onConfirm={() => void actions.sequence('abort')}
          onClose={onClose}
        />
      );
    case 'rebase':
      return (
        <ConfirmFrame
          title={t('git.branch.rebaseTitle', {
            branch: revealBidi(repo.branch ?? 'HEAD'),
            onto: revealBidi(prompt.onto),
          })}
          body={t('git.branch.rebasePushed')}
          testId="git-rebase-onto-dialog"
          confirm={t('git.branch.rebaseConfirm')}
          onConfirm={() => void actions.rebase(prompt.onto)}
          onClose={onClose}
        />
      );
    case 'merge':
      return <MergeDialog prompt={prompt} repo={repo} actions={actions} onClose={onClose} />;
  }
}

function MergeDialog({
  prompt,
  repo,
  actions,
  onClose,
}: {
  readonly prompt: Extract<GitPrompt, { kind: 'merge' }>;
  readonly repo: Repository;
  readonly actions: GitActions;
  readonly onClose: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const name = useId();
  const [mode, setMode] = useState<'ff' | 'noFf' | 'squash'>('ff');
  return (
    <Dialog labelledBy={titleId} onCancel={onClose} testId="git-merge-dialog">
      <h2 id={titleId} className="dialog-title">
        {t('git.merge.title', {
          branch: revealBidi(prompt.branch),
          current: revealBidi(repo.branch ?? 'HEAD'),
        })}
      </h2>
      <form
        className="git-dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          onClose();
          void actions.merge(prompt.branch, mode);
        }}
      >
        <fieldset className="git-dialog-modes">
          <legend className="visually-hidden">{t('git.merge.mode')}</legend>
          {(['ff', 'noFf', 'squash'] as const).map((option) => (
            <label key={option} className="git-dialog-mode">
              <input
                type="radio"
                name={name}
                value={option}
                checked={mode === option}
                data-testid={`git-merge-${option}`}
                onChange={() => {
                  setMode(option);
                }}
              />
              <span>
                <span className="git-dialog-mode-name">{t(`git.merge.${option}`)}</span>
                <span className="muted">{t(`git.merge.${option}Hint`)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose}>
            {t('dialog.cancel')}
          </button>
          <button type="submit" className="button button-primary" data-testid="git-merge-submit">
            {t('git.merge.submit')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** The conflicted files: take a side for one or several, or open one in the merge view. */
function ConflictsDialog({
  sessionId,
  repo,
  files,
  actions,
  onClose,
}: {
  readonly sessionId: string;
  readonly repo: Repository;
  readonly files: readonly StatusFile[];
  readonly actions: GitActions;
  readonly onClose: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const conflicted = files.filter((f) => f.conflict !== undefined || f.unstaged === 'conflicted');
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const labels = sideLabels(repo);
  const rebasing = repo.state?.kind === 'rebasing';
  const take = (paths: readonly string[], side: 'yours' | 'theirs') => {
    void (async () => {
      for (const path of paths) {
        const reply = await actions.run({ op: 'resolveConflict', path, take: side });
        if (!reply.ok) return;
      }
      setChosen(new Set());
    })();
  };
  return (
    <Dialog labelledBy={titleId} onCancel={onClose} testId="git-conflicts" wide>
      <h2 id={titleId} className="dialog-title">
        {t('git.conflicts.title', { count: conflicted.length })}
      </h2>
      <p className="muted">
        {t('git.conflicts.sides', {
          yours: revealBidi(labels.yours),
          theirs: revealBidi(labels.theirs),
        })}
      </p>
      {conflicted.length === 0 ? (
        <p data-testid="git-conflicts-done">{t('git.conflicts.none')}</p>
      ) : (
        <table className="git-conflicts-table">
          <thead>
            <tr>
              <th scope="col">
                <span className="visually-hidden">{t('git.conflicts.select')}</span>
              </th>
              <th scope="col">{t('git.conflicts.file')}</th>
              <th scope="col">{t('git.conflicts.yours')}</th>
              <th scope="col">{t('git.conflicts.theirs')}</th>
              <th scope="col">
                <span className="visually-hidden">{t('git.conflicts.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {conflicted.map((file) => {
              const sides = sidesOf(file.conflict, rebasing);
              return (
                <tr key={file.path} data-testid="git-conflict-row" data-path={file.path}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={t('git.conflicts.choose', { path: revealBidi(file.path) })}
                      checked={chosen.has(file.path)}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setChosen((old) => {
                          const next = new Set(old);
                          if (checked) next.add(file.path);
                          else next.delete(file.path);
                          return next;
                        });
                      }}
                    />
                  </td>
                  <td className="git-conflict-path">{revealBidi(file.path)}</td>
                  <td>{t(`git.conflicts.${sides.yours}`)}</td>
                  <td>{t(`git.conflicts.${sides.theirs}`)}</td>
                  <td className="git-conflict-actions">
                    <button
                      type="button"
                      className="button button-small"
                      data-testid="git-conflict-yours"
                      onClick={() => {
                        take([file.path], 'yours');
                      }}
                    >
                      {t('git.conflicts.useYours')}
                    </button>
                    <button
                      type="button"
                      className="button button-small"
                      data-testid="git-conflict-theirs"
                      onClick={() => {
                        take([file.path], 'theirs');
                      }}
                    >
                      {t('git.conflicts.useTheirs')}
                    </button>
                    <button
                      type="button"
                      className="button button-small button-primary"
                      data-testid="git-conflict-merge"
                      onClick={() => {
                        openMergeView(sessionId, file.path);
                      }}
                    >
                      {t('git.conflicts.merge')}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="dialog-actions">
        {chosen.size === 0 ? null : (
          <>
            <button
              type="button"
              className="button"
              onClick={() => {
                take([...chosen], 'yours');
              }}
            >
              {t('git.conflicts.useYoursSelected', { count: chosen.size })}
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                take([...chosen], 'theirs');
              }}
            >
              {t('git.conflicts.useTheirsSelected', { count: chosen.size })}
            </button>
          </>
        )}
        <button
          type="button"
          className="button"
          data-testid="git-conflicts-close"
          onClick={onClose}
        >
          {t('git.conflicts.close')}
        </button>
      </div>
    </Dialog>
  );
}
