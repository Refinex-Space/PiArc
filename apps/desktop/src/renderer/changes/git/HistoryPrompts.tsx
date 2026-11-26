// Dialogs of the log view and of stashing (design addendum 9.1): a tag, a reset with its mode,
// checking out a revision (detached `HEAD`), undoing a pushed commit, stashing and a branch from
// a stash. Each only collects the choice; the operation goes through `history-actions.ts`, and
// the main process confirms a hard reset natively with the facts Core read.
import { useId, useState, type ReactNode } from 'react';

import { useT } from '../../app/app-context.js';
import { Dialog } from '../../shell/Dialog.js';
import { revealBidi } from '../../transcript/reveal.js';
import { branchNameProblem } from './GitPrompts.js';
import { shortId, type HistoryActions, type ResetMode } from './history-actions.js';
import type { StashEntry } from './protocol.js';

/** A dialog the log view or the commit view opened. */
export type HistoryDialog =
  | { readonly kind: 'tag'; readonly sha: string; readonly subject: string }
  | {
      readonly kind: 'reset';
      readonly sha: string;
      readonly subject: string;
      readonly head: string;
      readonly branch: string;
    }
  | { readonly kind: 'detach'; readonly sha: string; readonly subject: string }
  | { readonly kind: 'undoCommit'; readonly head: string; readonly subject: string }
  | { readonly kind: 'stash' }
  | { readonly kind: 'stashBranch'; readonly entry: StashEntry };

const RESET_MODES: readonly ResetMode[] = ['soft', 'mixed', 'keep', 'hard'];

function Frame({
  title,
  testId,
  onClose,
  onSubmit,
  submit,
  submitTestId,
  danger = false,
  children,
}: {
  readonly title: string;
  readonly testId: string;
  readonly onClose: () => void;
  readonly onSubmit: () => void;
  readonly submit: string;
  readonly submitTestId: string;
  readonly danger?: boolean;
  readonly children: ReactNode;
}) {
  const t = useT();
  const titleId = useId();
  return (
    <Dialog labelledBy={titleId} onCancel={onClose} testId={testId}>
      <h2 id={titleId} className="dialog-title">
        {title}
      </h2>
      <form
        className="git-dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        {children}
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose}>
            {t('dialog.cancel')}
          </button>
          <button
            type="submit"
            className={`button ${danger ? 'button-destructive' : 'button-primary'}`}
            data-testid={submitTestId}
          >
            {submit}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** A name field with the branch-name rules (tags follow the same reference rules). */
function NameField({
  label,
  value,
  onChange,
  touched,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly touched: boolean;
  readonly testId: string;
}) {
  const t = useT();
  const inputId = useId();
  const errorId = useId();
  const problem = branchNameProblem(value);
  const shown = touched && problem !== undefined;
  return (
    <>
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        type="text"
        value={value}
        data-autofocus
        data-testid={testId}
        spellCheck={false}
        aria-invalid={shown}
        aria-describedby={shown ? errorId : undefined}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {shown ? (
        <p id={errorId} className="error-text" role="alert">
          {t(problem === 'empty' ? 'git.dialog.nameEmpty' : 'git.dialog.nameInvalid')}
        </p>
      ) : null}
    </>
  );
}

export function HistoryPrompt({
  dialog,
  history,
  onCheckout,
  onClose,
}: {
  readonly dialog: HistoryDialog;
  readonly history: HistoryActions;
  readonly onCheckout: (sha: string) => void;
  readonly onClose: () => void;
}) {
  switch (dialog.kind) {
    case 'tag':
      return <TagDialog dialog={dialog} history={history} onClose={onClose} />;
    case 'reset':
      return <ResetDialog dialog={dialog} history={history} onClose={onClose} />;
    case 'detach':
      return <DetachDialog dialog={dialog} onCheckout={onCheckout} onClose={onClose} />;
    case 'undoCommit':
      return <UndoDialog dialog={dialog} history={history} onClose={onClose} />;
    case 'stash':
      return <StashDialog history={history} onClose={onClose} />;
    case 'stashBranch':
      return <StashBranchDialog dialog={dialog} history={history} onClose={onClose} />;
  }
}

function TagDialog({
  dialog,
  history,
  onClose,
}: {
  readonly dialog: Extract<HistoryDialog, { kind: 'tag' }>;
  readonly history: HistoryActions;
  readonly onClose: () => void;
}) {
  const t = useT();
  const messageId = useId();
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [touched, setTouched] = useState(false);
  return (
    <Frame
      title={t('git.dialog.newTag', { short: shortId(dialog.sha) })}
      testId="git-tag-dialog"
      onClose={onClose}
      submit={t('git.dialog.create')}
      submitTestId="git-tag-submit"
      onSubmit={() => {
        setTouched(true);
        if (branchNameProblem(name) !== undefined) return;
        onClose();
        void history.createTag(name, dialog.sha, message);
      }}
    >
      <p className="muted git-dialog-subject">{revealBidi(dialog.subject)}</p>
      <NameField
        label={t('git.dialog.tagName')}
        value={name}
        onChange={(value) => {
          setName(value);
          setTouched(true);
        }}
        touched={touched}
        testId="git-tag-name"
      />
      <label htmlFor={messageId}>{t('git.dialog.tagMessage')}</label>
      <textarea
        id={messageId}
        className="git-dialog-textarea"
        rows={3}
        value={message}
        data-testid="git-tag-message"
        onChange={(event) => {
          setMessage(event.target.value);
        }}
      />
      <p className="muted">{t('git.dialog.tagMessageHint')}</p>
    </Frame>
  );
}

function ResetDialog({
  dialog,
  history,
  onClose,
}: {
  readonly dialog: Extract<HistoryDialog, { kind: 'reset' }>;
  readonly history: HistoryActions;
  readonly onClose: () => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<ResetMode>('mixed');
  const name = useId();
  return (
    <Frame
      title={t('git.dialog.resetTitle', {
        branch: revealBidi(dialog.branch),
        short: shortId(dialog.sha),
      })}
      testId="git-reset-dialog"
      onClose={onClose}
      submit={t('git.dialog.reset')}
      submitTestId="git-reset-submit"
      danger={mode === 'hard'}
      onSubmit={() => {
        onClose();
        void history.reset(dialog.sha, mode, dialog.head);
      }}
    >
      <p className="muted git-dialog-subject">{revealBidi(dialog.subject)}</p>
      <fieldset className="git-dialog-modes">
        <legend className="visually-hidden">{t('git.dialog.resetMode')}</legend>
        {RESET_MODES.map((option) => (
          <label key={option} className="git-dialog-mode">
            <input
              type="radio"
              name={name}
              value={option}
              checked={mode === option}
              data-testid={`git-reset-${option}`}
              onChange={() => {
                setMode(option);
              }}
            />
            <span>
              <span className="git-dialog-mode-name">{t(`git.reset.${option}`)}</span>
              <span className="muted">{t(`git.reset.${option}Hint`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </Frame>
  );
}

function DetachDialog({
  dialog,
  onCheckout,
  onClose,
}: {
  readonly dialog: Extract<HistoryDialog, { kind: 'detach' }>;
  readonly onCheckout: (sha: string) => void;
  readonly onClose: () => void;
}) {
  const t = useT();
  return (
    <Frame
      title={t('git.dialog.detachTitle', { short: shortId(dialog.sha) })}
      testId="git-detach-dialog"
      onClose={onClose}
      submit={t('git.dialog.checkout')}
      submitTestId="git-detach-submit"
      onSubmit={() => {
        onClose();
        onCheckout(dialog.sha);
      }}
    >
      <p className="muted git-dialog-subject">{revealBidi(dialog.subject)}</p>
      <p>{t('git.dialog.detachBody')}</p>
    </Frame>
  );
}

function UndoDialog({
  dialog,
  history,
  onClose,
}: {
  readonly dialog: Extract<HistoryDialog, { kind: 'undoCommit' }>;
  readonly history: HistoryActions;
  readonly onClose: () => void;
}) {
  const t = useT();
  return (
    <Frame
      title={t('git.dialog.undoTitle')}
      testId="git-undo-dialog"
      onClose={onClose}
      submit={t('git.dialog.undo')}
      submitTestId="git-undo-submit"
      onSubmit={() => {
        onClose();
        void history.undoCommit(dialog.head);
      }}
    >
      <p className="muted git-dialog-subject">{revealBidi(dialog.subject)}</p>
      <p>{t('git.dialog.undoPushed')}</p>
    </Frame>
  );
}

function StashDialog({
  history,
  onClose,
}: {
  readonly history: HistoryActions;
  readonly onClose: () => void;
}) {
  const t = useT();
  const messageId = useId();
  const [message, setMessage] = useState('');
  const [untracked, setUntracked] = useState(false);
  return (
    <Frame
      title={t('git.dialog.stashTitle')}
      testId="git-stash-dialog"
      onClose={onClose}
      submit={t('git.dialog.stash')}
      submitTestId="git-stash-submit"
      onSubmit={() => {
        onClose();
        void history.stashPush(message, untracked);
      }}
    >
      <label htmlFor={messageId}>{t('git.dialog.stashMessage')}</label>
      <input
        id={messageId}
        type="text"
        value={message}
        maxLength={1000}
        data-autofocus
        data-testid="git-stash-message"
        onChange={(event) => {
          setMessage(event.target.value);
        }}
      />
      <label className="git-dialog-check">
        <input
          type="checkbox"
          checked={untracked}
          data-testid="git-stash-untracked"
          onChange={(event) => {
            setUntracked(event.target.checked);
          }}
        />
        {t('git.dialog.stashUntracked')}
      </label>
    </Frame>
  );
}

function StashBranchDialog({
  dialog,
  history,
  onClose,
}: {
  readonly dialog: Extract<HistoryDialog, { kind: 'stashBranch' }>;
  readonly history: HistoryActions;
  readonly onClose: () => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  return (
    <Frame
      title={t('git.dialog.stashBranchTitle')}
      testId="git-stash-branch-dialog"
      onClose={onClose}
      submit={t('git.dialog.create')}
      submitTestId="git-stash-branch-submit"
      onSubmit={() => {
        setTouched(true);
        if (branchNameProblem(name) !== undefined) return;
        onClose();
        void history.stashBranch(dialog.entry, name);
      }}
    >
      <p className="muted git-dialog-subject">{revealBidi(dialog.entry.message)}</p>
      <NameField
        label={t('git.dialog.branchName')}
        value={name}
        onChange={(value) => {
          setName(value);
          setTouched(true);
        }}
        touched={touched}
        testId="git-stash-branch-name"
      />
    </Frame>
  );
}
