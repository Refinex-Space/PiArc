// Actions refer to the revision and host connection shown. Only a newer Core snapshot can
// remove the row. In particular, cancelling the native confirmation leaves it actionable.
import type { ApprovalRequest } from '@piarc/protocol';
import { useEffect, useRef, useState } from 'react';
import type { ApprovalAnswer } from '../../../shared/ipc.js';
import { useApp } from '../../app/app-context.js';
import { reason } from '../../shell/errors.js';
import { approvalKey, canAlwaysAllow, canAnswerByKey } from './approval-keys.js';
import { DiffView } from './tools.js';

const PREVIEW_CHARS = 480;
const PREVIEW_LINES = 8;

function firstVisible(card: HTMLElement): boolean {
  const scroller = card.closest('.transcript-scroller');
  if (!scroller) return false;
  const bounds = scroller.getBoundingClientRect();
  return (
    Array.from(scroller.querySelectorAll('[data-approval-card]')).find((el) => {
      const rect = el.getBoundingClientRect();
      return rect.height > 0 && rect.top < bounds.bottom && rect.bottom > bounds.top;
    }) === card
  );
}

export function ApprovalCard({ request }: { readonly request: ApprovalRequest }) {
  const { t, keyPlatform } = useApp();
  const card = useRef<HTMLElement>(null);
  const mountedAt = useRef(performance.now());
  const [feedback, setFeedback] = useState('');
  const [rule, setRule] = useState(request.rule ?? '');
  const [directory, setDirectory] = useState(request.directory ?? '');
  const [expanded, setExpanded] = useState(false);
  const busy = useRef(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');
  const content = [request.command, request.diff?.unified].filter(Boolean).join('\n');
  const long = content.length > PREVIEW_CHARS || content.split('\n').length > PREVIEW_LINES;
  const allowPersistent =
    request.protectedPath !== true && (request.rule != null || request.directory != null);
  function answer(decision: ApprovalAnswer['decision']) {
    if (busy.current) return;
    busy.current = true;
    setWaiting(true);
    setError('');
    const { sessionId, requestId, revision, connectionEpoch } = request;
    window.piarc
      .answerApproval({
        sessionId,
        requestId,
        revision,
        connectionEpoch,
        decision,
        ...(decision === 'deny' && feedback ? { feedback } : {}),
        ...(decision === 'allowAlways' && request.rule != null ? { rule } : {}),
        ...(decision === 'allowAlways' && request.directory != null ? { directory } : {}),
      })
      .then(async (raw) => {
        const value: unknown = JSON.parse(raw);
        const status =
          value && typeof value === 'object' && 'status' in value ? value.status : undefined;
        if (status === 'cancelled') {
          busy.current = false;
          setWaiting(false);
        } else if (status === 'stale' || status === 'alreadyHandled') {
          setError(t('approval.handled'));
          await window.piarc.resendSnapshots();
        } else if (status !== 'applied') throw new Error('Invalid approval response');
      })
      .catch((e: unknown) => {
        setError(reason(e));
        busy.current = false;
        setWaiting(false);
      });
  }
  const latest = useRef(answer);
  latest.current = answer;
  useEffect(() => {
    if (request.kind === 'question') return;
    let composing = false;
    const start = () => {
      composing = true;
    };
    const end = () => {
      composing = false;
    };
    const keydown = (ev: KeyboardEvent) => {
      const el = card.current;
      if (
        composing ||
        !el ||
        ev.defaultPrevented ||
        document.querySelector('[role="dialog"], [role="menu"]')
      )
        return;
      const key = approvalKey(ev, keyPlatform);
      if (!key || !firstVisible(el)) return;
      const composer = document.querySelector('.composer');
      const input = composer?.querySelector('[contenteditable="true"]');
      const composerEmpty =
        !input?.textContent && !composer?.querySelector('.composer-attachments');
      // Consume the shortcut even during the guard: it must not fall through to stop/queue.
      ev.preventDefault();
      ev.stopPropagation();
      if (key === 'allowSession' && request.protectedPath === true) return;
      if (
        canAnswerByKey(key, {
          firstVisible: true,
          ageMs: performance.now() - mountedAt.current,
          composerEmpty,
          cardFocused: el.contains(document.activeElement),
          repeat: ev.repeat,
        })
      )
        latest.current(key);
    };
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('compositionstart', start, true);
    window.addEventListener('compositionend', end, true);
    return () => {
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('compositionstart', start, true);
      window.removeEventListener('compositionend', end, true);
    };
  }, [keyPlatform, request.kind, request.protectedPath]);
  const unsupported = request.kind === 'question';
  return (
    <section
      ref={card}
      className="row approval-card"
      tabIndex={-1}
      data-testid="approval-card"
      data-approval-card={request.kind}
      data-request-id={request.requestId}
    >
      <header>
        <strong>{t(`approval.kind.${request.kind}`)}</strong>{' '}
        <span className="muted">{request.tool}</span>
      </header>
      {request.cwd && (
        <div className="approval-path">{t('approval.cwd', { path: request.cwd })}</div>
      )}
      {request.path && <div className="approval-path">{request.path}</div>}
      {request.directory && (
        <div className="approval-path">
          {t('approval.directory')} · {request.directory}
        </div>
      )}
      {long && !expanded ? (
        <pre className="bash-command">
          {content.split('\n').slice(0, PREVIEW_LINES).join('\n').slice(0, PREVIEW_CHARS)}…
        </pre>
      ) : (
        <>
          {request.command && <pre className="bash-command">{request.command}</pre>}
          {request.diff &&
            (request.diff.hunks.length ? (
              <DiffView
                hunks={request.diff.hunks}
                limit={Infinity}
                onShowAll={() => {
                  setExpanded(true);
                }}
              />
            ) : (
              <pre className="bash-command">
                {request.diff.unified || t('transcript.file.noDiff')}
              </pre>
            ))}
        </>
      )}
      {long && !expanded && (
        <button
          type="button"
          className="row-action"
          onClick={() => {
            setExpanded(true);
          }}
        >
          {t('approval.expand')}
        </button>
      )}
      {unsupported ? (
        <p role="status">{t('approval.unsupported')}</p>
      ) : (
        <>
          <label>
            {t('approval.feedback')}
            <input
              value={feedback}
              onChange={(e) => {
                setFeedback(e.target.value);
              }}
            />
          </label>
          {allowPersistent && request.rule != null && (
            <label>
              {t('approval.rule')}
              <input
                value={rule}
                readOnly={request.kind === 'permissionExpansion' && request.tool === 'MemoryImport'}
                onChange={(e) => {
                  setRule(e.target.value);
                }}
              />
            </label>
          )}
          {allowPersistent && request.directory != null && (
            <label>
              {t('approval.directory')}
              <input
                value={directory}
                onChange={(e) => {
                  setDirectory(e.target.value);
                }}
              />
            </label>
          )}
          <div className="approval-actions">
            <button
              type="button"
              className="button"
              disabled={waiting}
              onClick={() => {
                answer('deny');
              }}
            >
              {t('approval.deny')}
            </button>
            <button
              type="button"
              className="button"
              disabled={waiting}
              onClick={() => {
                answer('allowOnce');
              }}
            >
              {t('approval.once')}
            </button>
            {request.protectedPath !== true && (
              <button
                type="button"
                className="button"
                disabled={waiting}
                onClick={() => {
                  answer('allowSession');
                }}
              >
                {t('approval.session')}
              </button>
            )}
            {allowPersistent && (
              <button
                type="button"
                className="button"
                disabled={
                  waiting ||
                  !canAlwaysAllow(false, long, expanded) ||
                  (request.rule != null && !rule.trim()) ||
                  (request.directory != null && !directory.trim())
                }
                onClick={() => {
                  answer('allowAlways');
                }}
              >
                {t('approval.always')}
              </button>
            )}
          </div>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
