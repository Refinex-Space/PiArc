// The rewind dialog (T28, architecture section 6.9): from a user message's "rewind to here" or
// `/rewind` (which first lists the branch's messages). It shows the four options, the files a
// code rewind puts back or removes, and each file changed outside the session with the choice to
// keep it or overwrite it with the snapshot; cancelling changes nothing. After the rewind it
// lists what happened to each file and offers to undo the file changes.
import type { RewindPreview, RewindReport, RewindScope } from '@piarc/protocol';
import { useEffect, useState } from 'react';

import { useT } from '../app/app-context.js';
import { Dialog } from '../shell/Dialog.js';
import { reason } from '../shell/errors.js';
import {
  affectedFiles,
  initialChoices,
  previewOf,
  reportOf,
  requestOf,
  restoresCode,
  SCOPES,
} from './rewind.js';

/** A user message the dialog can go back to. */
export interface RewindTarget {
  readonly turnId: string;
  readonly text: string;
}

type Step =
  | { readonly kind: 'pick' }
  | { readonly kind: 'loading'; readonly target: RewindTarget }
  | { readonly kind: 'choose'; readonly target: RewindTarget; readonly preview: RewindPreview }
  | { readonly kind: 'running'; readonly target: RewindTarget; readonly preview: RewindPreview }
  | { readonly kind: 'report'; readonly report: RewindReport; readonly undone: boolean };

const TITLE_ID = 'rewind-title';

function Pick({
  turns,
  onPick,
}: {
  readonly turns: readonly RewindTarget[];
  readonly onPick: (target: RewindTarget) => void;
}) {
  const t = useT();
  if (turns.length === 0) return <p className="muted">{t('rewind.pickEmpty')}</p>;
  return (
    <>
      <p>{t('rewind.pick')}</p>
      <ul className="rewind-turns" data-testid="rewind-turns">
        {[...turns].reverse().map((turn) => (
          <li key={turn.turnId}>
            <button
              type="button"
              className="rewind-turn"
              data-testid="rewind-turn"
              onClick={() => {
                onPick(turn);
              }}
            >
              {turn.text}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function Files({
  preview,
  choices,
  onChoice,
  disabled,
}: {
  readonly preview: RewindPreview;
  readonly choices: ReadonlyMap<string, boolean>;
  readonly onChoice: (path: string, overwrite: boolean) => void;
  readonly disabled: boolean;
}) {
  const t = useT();
  if (!preview.codeAvailable) {
    return (
      <p className="muted" data-testid="rewind-unavailable">
        {t('rewind.codeUnavailable')}
      </p>
    );
  }
  const files = affectedFiles(preview);
  if (files.length === 0) {
    return (
      <p className="muted" data-testid="rewind-no-files">
        {t('rewind.files.none')}
      </p>
    );
  }
  return (
    <ul className="rewind-files" data-testid="rewind-files">
      {files.map((file) => (
        <li
          key={file.path}
          className="rewind-file"
          data-testid="rewind-file"
          data-path={file.label}
          data-action={file.action}
        >
          <div className="rewind-file-head">
            <span className="rewind-file-path" title={file.path}>
              {file.label}
            </span>
            <span className={`badge rewind-action is-${file.action}`}>
              {t(`rewind.action.${file.action}`)}
            </span>
          </div>
          {file.approval === true ? (
            <p className="rewind-file-note warning-text">{t('rewind.approval')}</p>
          ) : null}
          {file.action !== 'conflict' ? null : (
            <div className="rewind-choice" role="radiogroup" aria-label={file.label}>
              <label>
                <input
                  type="radio"
                  name={`choice:${file.path}`}
                  data-testid="rewind-keep"
                  checked={choices.get(file.path) !== true}
                  disabled={disabled}
                  onChange={() => {
                    onChoice(file.path, false);
                  }}
                />
                {t('rewind.conflict.keep')}
              </label>
              <label>
                <input
                  type="radio"
                  name={`choice:${file.path}`}
                  data-testid="rewind-overwrite"
                  checked={choices.get(file.path) === true}
                  disabled={disabled}
                  onChange={() => {
                    onChoice(file.path, true);
                  }}
                />
                {t(file.deletes === true ? 'rewind.conflict.delete' : 'rewind.conflict.overwrite')}
              </label>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function Report({
  report,
  undone,
  onUndo,
  busy,
}: {
  readonly report: RewindReport;
  readonly undone: boolean;
  readonly onUndo: () => void;
  readonly busy: boolean;
}) {
  const t = useT();
  const files = report.files ?? [];
  return (
    <div data-testid="rewind-report" data-completed={report.completed ? 'true' : 'false'}>
      <p role="status" className={report.completed ? undefined : 'warning-text'}>
        {undone
          ? t('rewind.undone')
          : report.completed
            ? t('rewind.done')
            : t('rewind.stopped', { reason: report.error ?? '' })}
      </p>
      {files.length === 0 ? null : (
        <ul className="rewind-files" data-testid="rewind-results">
          {files.map((file) => (
            <li
              key={file.path}
              className="rewind-file"
              data-testid="rewind-result"
              data-path={file.label}
              data-outcome={file.outcome}
            >
              <div className="rewind-file-head">
                <span className="rewind-file-path" title={file.path}>
                  {file.label}
                </span>
                <span className={`badge rewind-outcome is-${file.outcome}`}>
                  {t(`rewind.outcome.${file.outcome}`)}
                </span>
              </div>
              {file.error === undefined ? null : (
                <p className="rewind-file-note warning-text">{file.error}</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {report.restoreId == null || undone ? null : (
        <button
          type="button"
          className="button"
          data-testid="rewind-undo"
          disabled={busy}
          onClick={onUndo}
        >
          {t('rewind.undo')}
        </button>
      )}
    </div>
  );
}

export function RewindDialog({
  sessionId,
  target,
  turns,
  onDone,
  onClose,
}: {
  readonly sessionId: string;
  /** The message to go back to; absent for `/rewind`, which lists `turns` first. */
  readonly target: RewindTarget | undefined;
  readonly turns: readonly RewindTarget[];
  /** The rewind ran (or its files were undone): the conversation and the changes moved. */
  readonly onDone: (report: RewindReport) => void;
  readonly onClose: () => void;
}) {
  const t = useT();
  const [step, setStep] = useState<Step>(
    target === undefined ? { kind: 'pick' } : { kind: 'loading', target },
  );
  const [scope, setScope] = useState<RewindScope>('codeAndConversation');
  const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const loading = step.kind === 'loading' ? step.target : undefined;
  useEffect(() => {
    if (loading === undefined) return;
    let active = true;
    window.piarc.rewindPreview(sessionId, loading.turnId).then(
      (text) => {
        if (!active) return;
        const preview = previewOf(text);
        setChoices(initialChoices(preview));
        if (!preview.codeAvailable) setScope('conversation');
        setStep({ kind: 'choose', target: loading, preview });
      },
      (error: unknown) => {
        if (active) setFailure(t('rewind.failed', { reason: reason(error) }));
      },
    );
    return () => {
      active = false;
    };
  }, [sessionId, loading, t]);

  const confirm = () => {
    if (step.kind !== 'choose') return;
    setFailure(undefined);
    setStep({ kind: 'running', target: step.target, preview: step.preview });
    window.piarc.rewind(sessionId, requestOf(step.preview, scope, choices)).then(
      (text) => {
        const report = reportOf(text);
        setStep({ kind: 'report', report, undone: false });
        onDone(report);
      },
      (error: unknown) => {
        setFailure(t('rewind.failed', { reason: reason(error) }));
        setStep({ kind: 'choose', target: step.target, preview: step.preview });
      },
    );
  };

  const undo = () => {
    const restoreId = step.kind === 'report' ? step.report.restoreId : undefined;
    if (restoreId == null) return;
    setBusy(true);
    window.piarc
      .undoRewind(sessionId, restoreId)
      .then(
        (text) => {
          const report = reportOf(text);
          setStep({ kind: 'report', report: { ...report, restoreId: null }, undone: true });
          onDone(report);
        },
        (error: unknown) => {
          setFailure(t('rewind.failed', { reason: reason(error) }));
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };

  const choosing = step.kind === 'choose' || step.kind === 'running';
  const shownTarget = step.kind === 'choose' || step.kind === 'running' || step.kind === 'loading';
  return (
    <Dialog labelledBy={TITLE_ID} onCancel={onClose} testId="rewind-dialog" wide>
      <h2 id={TITLE_ID} className="dialog-title">
        {t('rewind.title')}
      </h2>
      {step.kind === 'pick' ? (
        <Pick
          turns={turns}
          onPick={(picked) => {
            setStep({ kind: 'loading', target: picked });
          }}
        />
      ) : null}
      {shownTarget ? (
        <>
          <p className="muted">{t('rewind.before')}</p>
          <blockquote className="rewind-message" data-testid="rewind-message">
            {step.target.text}
          </blockquote>
        </>
      ) : null}
      {step.kind === 'loading' && failure === undefined ? (
        <p className="muted">{t('changes.loading')}</p>
      ) : null}
      {choosing ? (
        <>
          <fieldset className="rewind-scopes" data-testid="rewind-scopes">
            {SCOPES.map((option) => {
              const unavailable = restoresCode(option) && !step.preview.codeAvailable;
              return (
                <label key={option} className="rewind-scope" data-scope={option}>
                  <input
                    type="radio"
                    name="rewind-scope"
                    data-testid={`rewind-scope-${option}`}
                    checked={scope === option}
                    disabled={unavailable || step.kind === 'running'}
                    onChange={() => {
                      setScope(option);
                    }}
                  />
                  <span>
                    <span className="rewind-scope-name">{t(`rewind.scope.${option}`)}</span>
                    <span className="rewind-scope-hint muted">
                      {t(`rewind.scope.${option}.hint`)}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>
          {restoresCode(scope) ? (
            <>
              <h3 className="rewind-section">{t('rewind.files')}</h3>
              <Files
                preview={step.preview}
                choices={choices}
                disabled={step.kind === 'running'}
                onChoice={(path, overwrite) => {
                  setChoices((current) => new Map(current).set(path, overwrite));
                }}
              />
            </>
          ) : null}
          <p className="muted rewind-note" data-testid="rewind-bash-note">
            {t('rewind.bashNote')}
          </p>
        </>
      ) : null}
      {step.kind === 'report' ? (
        <Report report={step.report} undone={step.undone} onUndo={undo} busy={busy} />
      ) : null}
      {failure === undefined ? null : (
        <p className="warning-text" role="alert" data-testid="rewind-error">
          {failure}
        </p>
      )}
      <div className="dialog-actions">
        {step.kind === 'report' ? (
          <button
            type="button"
            className="button button-primary"
            data-testid="rewind-close"
            onClick={onClose}
          >
            {t('rewind.close')}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="button"
              data-testid="rewind-cancel"
              disabled={step.kind === 'running'}
              onClick={onClose}
            >
              {t('dialog.cancel')}
            </button>
            {choosing ? (
              <button
                type="button"
                className="button button-primary"
                data-testid="rewind-confirm"
                disabled={step.kind === 'running'}
                onClick={confirm}
              >
                {step.kind === 'running' ? t('rewind.running') : t('rewind.confirm')}
              </button>
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  );
}
