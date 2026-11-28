// The Git panel's dialogs and notices. Dialogs answer the choices an operation came back with
// (local changes in the way of a checkout, a rejected push, a first push, the pull mode, a
// branch name); the destructive answers (force checkout, force push) are confirmed again
// natively by the main process with facts Core read. Notices are the panel's own toasts:
// results, failures with Git's words, and undo for rollbacks and deleted branches.
import { useEffect, useId, useState } from 'react';

import { useApp, useT } from '../../app/app-context.js';
import { Dialog } from '../../shell/Dialog.js';
import { PULL_MODES, type PullMode } from '../../../shared/preferences.js';
import { revealBidi } from '../../transcript/reveal.js';
import {
  dismissNotice,
  setPrompt,
  useGitBoard,
  type GitActions,
  type GitNotice,
  type GitPrompt,
  type PushTarget,
} from './actions.js';
import { ConflictPrompt } from './conflicts.js';
import type { Repository } from './protocol.js';
import { useGit } from './state.js';

/** Paths a dialog lists before "and N more". */
const LISTED = 10;

/** Whether `name` could be a branch name (Core checks again with `git check-ref-format`). */
export function branchNameProblem(name: string): 'empty' | 'invalid' | undefined {
  if (name.trim() === '') return 'empty';
  return /[\s~^:?*[\\]|\.\.|\/\/|@\{|^[-/.]|[/.]$|\.lock$/u.test(name) ||
    // eslint-disable-next-line no-control-regex -- control characters are what it refuses
    /[\x00-\x1f\x7f]/u.test(name)
    ? 'invalid'
    : undefined;
}

export function GitPrompts({
  sessionId,
  repo,
  actions,
}: {
  readonly sessionId: string;
  readonly repo: Repository | undefined;
  readonly actions: GitActions;
}) {
  const board = useGitBoard(sessionId);
  const files = useGit(sessionId).status.value?.files ?? [];
  const prompt = board.prompt;
  if (prompt === undefined || repo === undefined) return null;
  const close = () => {
    setPrompt(sessionId, undefined);
  };
  switch (prompt.kind) {
    case 'checkout':
      return <CheckoutPrompt prompt={prompt} actions={actions} onClose={close} />;
    case 'pushRejected':
      return (
        <RejectedPrompt
          prompt={prompt}
          protectedBranch={repo.protected}
          actions={actions}
          onClose={close}
        />
      );
    case 'pushTarget':
      return <PushTargetPrompt prompt={prompt} repo={repo} actions={actions} onClose={close} />;
    case 'pullMode':
      return <PullModePrompt prompt={prompt} actions={actions} onClose={close} />;
    case 'branchName':
      return <BranchNamePrompt prompt={prompt} actions={actions} onClose={close} />;
    case 'conflicts':
    case 'markResolved':
    case 'abort':
    case 'merge':
    case 'rebase':
      return (
        <ConflictPrompt
          sessionId={sessionId}
          prompt={prompt}
          repo={repo}
          files={files}
          actions={actions}
          onClose={close}
        />
      );
  }
}

function PathList({ paths }: { readonly paths: readonly string[] }) {
  const t = useT();
  return (
    <ul className="git-dialog-paths">
      {paths.slice(0, LISTED).map((p) => (
        <li key={p}>{revealBidi(p)}</li>
      ))}
      {paths.length > LISTED ? (
        <li className="muted">{t('git.dialog.more', { count: paths.length - LISTED })}</li>
      ) : null}
    </ul>
  );
}

function CheckoutPrompt({
  prompt,
  actions,
  onClose,
}: {
  readonly prompt: Extract<GitPrompt, { kind: 'checkout' }>;
  readonly actions: GitActions;
  readonly onClose: () => void;
}) {
  const t = useT();
  const title = useId();
  return (
    <Dialog labelledBy={title} onCancel={onClose} testId="git-checkout-dialog">
      <h2 id={title} className="dialog-title">
        {t('git.dialog.checkoutTitle', { target: revealBidi(prompt.target) })}
      </h2>
      <p className="muted">
        {t(prompt.untracked ? 'git.dialog.checkoutUntracked' : 'git.dialog.checkoutLocal')}
      </p>
      <PathList paths={prompt.paths} />
      <div className="dialog-actions">
        <button type="button" className="button" onClick={onClose}>
          {t('dialog.cancel')}
        </button>
        <button
          type="button"
          className="button button-destructive"
          data-testid="git-checkout-force"
          onClick={() => {
            onClose();
            void actions.checkout(prompt.target, 'force');
          }}
        >
          {t('git.dialog.forceCheckout')}
        </button>
        {prompt.untracked ? null : (
          <button
            type="button"
            className="button button-primary"
            data-autofocus
            data-testid="git-checkout-smart"
            onClick={() => {
              onClose();
              void actions.checkout(prompt.target, 'smart');
            }}
          >
            {t('git.dialog.smartCheckout')}
          </button>
        )}
      </div>
    </Dialog>
  );
}

function RejectedPrompt({
  prompt,
  protectedBranch,
  actions,
  onClose,
}: {
  readonly prompt: Extract<GitPrompt, { kind: 'pushRejected' }>;
  /** Core never force-pushes a protected branch: no button for it. */
  readonly protectedBranch: boolean;
  readonly actions: GitActions;
  readonly onClose: () => void;
}) {
  const t = useT();
  const title = useId();
  return (
    <Dialog labelledBy={title} onCancel={onClose} testId="git-rejected-dialog">
      <h2 id={title} className="dialog-title">
        {t('git.dialog.rejectedTitle')}
      </h2>
      <p className="muted">{t('git.dialog.rejectedBody')}</p>
      <div className="dialog-actions">
        <button type="button" className="button" onClick={onClose}>
          {t('dialog.cancel')}
        </button>
        {protectedBranch ? null : (
          <button
            type="button"
            className="button button-destructive"
            data-testid="git-force-push"
            onClick={() => {
              onClose();
              void actions.push(prompt.target, true);
            }}
          >
            {t('git.dialog.forcePush')}
          </button>
        )}
        <button
          type="button"
          className="button button-primary"
          data-autofocus
          data-testid="git-pull-push"
          onClick={() => {
            onClose();
            void actions.pull(undefined, prompt.target ?? null);
          }}
        >
          {t('git.dialog.pullThenPush')}
        </button>
      </div>
    </Dialog>
  );
}

function PushTargetPrompt({
  prompt,
  repo,
  actions,
  onClose,
}: {
  readonly prompt: Extract<GitPrompt, { kind: 'pushTarget' }>;
  readonly repo: Repository;
  readonly actions: GitActions;
  readonly onClose: () => void;
}) {
  const t = useT();
  const title = useId();
  const remoteId = useId();
  const branchId = useId();
  const [remote, setRemote] = useState(
    repo.remotes.includes('origin') ? 'origin' : (repo.remotes[0] ?? ''),
  );
  const [branch, setBranch] = useState(prompt.branch);
  const problem = branchNameProblem(branch);
  const submit = () => {
    if (problem !== undefined || remote === '') return;
    onClose();
    const target: PushTarget = { remote, branch };
    void actions.push(target);
  };
  return (
    <Dialog labelledBy={title} onCancel={onClose} testId="git-push-target-dialog">
      <h2 id={title} className="dialog-title">
        {t('git.dialog.pushTargetTitle', { branch: revealBidi(prompt.branch) })}
      </h2>
      <p className="muted">{t('git.dialog.pushTargetBody')}</p>
      <form
        className="git-dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label htmlFor={remoteId}>{t('git.dialog.remote')}</label>
        <select
          id={remoteId}
          value={remote}
          onChange={(event) => {
            setRemote(event.target.value);
          }}
        >
          {repo.remotes.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <label htmlFor={branchId}>{t('git.dialog.remoteBranch')}</label>
        <input
          id={branchId}
          type="text"
          value={branch}
          data-autofocus
          aria-invalid={problem !== undefined}
          onChange={(event) => {
            setBranch(event.target.value);
          }}
        />
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose}>
            {t('dialog.cancel')}
          </button>
          <button
            type="submit"
            className="button button-primary"
            disabled={problem !== undefined || remote === ''}
            data-testid="git-push-target"
          >
            {t('git.dialog.push')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function PullModePrompt({
  prompt,
  actions,
  onClose,
}: {
  readonly prompt: Extract<GitPrompt, { kind: 'pullMode' }>;
  readonly actions: GitActions;
  readonly onClose: () => void;
}) {
  const t = useT();
  const title = useId();
  const [remember, setRemember] = useState(true);
  const choose = (mode: Exclude<PullMode, 'config'>) => {
    onClose();
    if (remember) void window.piarc.setPreference({ key: 'git.pullMode', value: mode });
    void actions.pull(mode, prompt.thenPush);
  };
  return (
    <Dialog labelledBy={title} onCancel={onClose} testId="git-pull-mode-dialog">
      <h2 id={title} className="dialog-title">
        {t('git.dialog.pullModeTitle')}
      </h2>
      <p className="muted">{t('git.dialog.pullModeBody')}</p>
      <ul className="interactive-list git-dialog-choices">
        {PULL_MODES.filter((m): m is Exclude<PullMode, 'config'> => m !== 'config').map(
          (mode, index) => (
            <li key={mode}>
              <button
                type="button"
                className="style-choice"
                data-testid={`git-pull-mode-${mode}`}
                {...(index === 0 ? { 'data-autofocus': true } : {})}
                onClick={() => {
                  choose(mode);
                }}
              >
                <span className="style-name">{t(`git.pullMode.${mode}`)}</span>
                <span className="muted">{t(`git.pullMode.${mode}Hint`)}</span>
              </button>
            </li>
          ),
        )}
      </ul>
      <label className="git-dialog-check">
        <input
          type="checkbox"
          checked={remember}
          onChange={(event) => {
            setRemember(event.target.checked);
          }}
        />
        {t('git.dialog.rememberPullMode')}
      </label>
      <div className="dialog-actions">
        <button type="button" className="button" onClick={onClose}>
          {t('dialog.cancel')}
        </button>
      </div>
    </Dialog>
  );
}

function BranchNamePrompt({
  prompt,
  actions,
  onClose,
}: {
  readonly prompt: Extract<GitPrompt, { kind: 'branchName' }>;
  readonly actions: GitActions;
  readonly onClose: () => void;
}) {
  const { t, preferences } = useApp();
  const title = useId();
  const inputId = useId();
  const errorId = useId();
  const create = prompt.mode === 'create';
  const [name, setName] = useState(create ? preferences.git.branchPrefix : (prompt.from ?? ''));
  const [checkout, setCheckout] = useState(true);
  const [touched, setTouched] = useState(false);
  const problem = branchNameProblem(name);
  const submit = () => {
    setTouched(true);
    if (problem !== undefined) return;
    onClose();
    if (create) void actions.createBranch(name, prompt.start, checkout);
    else if (prompt.from !== undefined && prompt.from !== name)
      void actions.renameBranch(prompt.from, name);
  };
  return (
    <Dialog labelledBy={title} onCancel={onClose} testId="git-branch-name-dialog">
      <h2 id={title} className="dialog-title">
        {create
          ? prompt.start === undefined
            ? t('git.dialog.newBranch')
            : t('git.dialog.newBranchFrom', { start: revealBidi(prompt.start) })
          : t('git.dialog.renameBranch', { name: revealBidi(prompt.from ?? '') })}
      </h2>
      <form
        className="git-dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label htmlFor={inputId}>{t('git.dialog.branchName')}</label>
        <input
          id={inputId}
          type="text"
          value={name}
          data-autofocus
          data-testid="git-branch-name"
          spellCheck={false}
          aria-invalid={touched && problem !== undefined}
          aria-describedby={touched && problem !== undefined ? errorId : undefined}
          onChange={(event) => {
            setName(event.target.value);
            setTouched(true);
          }}
        />
        {touched && problem !== undefined ? (
          <p id={errorId} className="error-text" role="alert">
            {t(problem === 'empty' ? 'git.dialog.nameEmpty' : 'git.dialog.nameInvalid')}
          </p>
        ) : null}
        {create ? (
          <label className="git-dialog-check">
            <input
              type="checkbox"
              checked={checkout}
              data-testid="git-branch-checkout-new"
              onChange={(event) => {
                setCheckout(event.target.checked);
              }}
            />
            {t('git.dialog.checkoutNew')}
          </label>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose}>
            {t('dialog.cancel')}
          </button>
          <button
            type="submit"
            className="button button-primary"
            data-testid="git-branch-name-submit"
          >
            {create ? t('git.dialog.create') : t('git.dialog.rename')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** The panel's notices, newest last; each leaves after its time unless hovered. */
export function GitNotices({ sessionId }: { readonly sessionId: string }) {
  const board = useGitBoard(sessionId);
  if (board.notices.length === 0) return null;
  return (
    <div className="git-notices" role="status" data-testid="git-notices">
      {board.notices.map((notice) => (
        <Notice key={notice.id} sessionId={sessionId} notice={notice} />
      ))}
    </div>
  );
}

function Notice({ sessionId, notice }: { readonly sessionId: string; readonly notice: GitNotice }) {
  const t = useT();
  const [held, setHeld] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (held) return;
    const timer = setTimeout(() => {
      dismissNotice(sessionId, notice.id);
    }, notice.timeout);
    return () => {
      clearTimeout(timer);
    };
  }, [held, sessionId, notice.id, notice.timeout]);
  return (
    <div
      className={`git-notice is-${notice.tone}`}
      data-testid="git-notice"
      data-tone={notice.tone}
      onPointerEnter={() => {
        setHeld(true);
      }}
      onPointerLeave={() => {
        setHeld(false);
      }}
      onFocus={() => {
        setHeld(true);
      }}
      onBlur={() => {
        setHeld(false);
      }}
    >
      <p className="git-notice-text">{revealBidi(notice.text)}</p>
      {notice.detail === undefined ? null : (
        <>
          <button
            type="button"
            className="git-link-button"
            aria-expanded={open}
            onClick={() => {
              setOpen(!open);
            }}
          >
            {t(open ? 'git.notice.hideDetails' : 'git.notice.showDetails')}
          </button>
          {open ? <pre className="git-notice-detail">{revealBidi(notice.detail)}</pre> : null}
        </>
      )}
      <div className="git-notice-actions">
        {notice.actions.map((action) => (
          <button
            key={action.testId}
            type="button"
            className="button button-small"
            data-testid={action.testId}
            onClick={action.run}
          >
            {action.label}
          </button>
        ))}
        <button
          type="button"
          className="git-link-button git-notice-dismiss"
          aria-label={t('git.notice.dismiss')}
          onClick={() => {
            dismissNotice(sessionId, notice.id);
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}
