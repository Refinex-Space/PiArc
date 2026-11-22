// Actions refer to the revision and host connection shown. Only a newer Core snapshot can
// remove the row. In particular, cancelling the native confirmation leaves it actionable.
import { approvalLabel } from '../../approvals/approval-label.js';
import type { ApprovalRequest } from '@piarc/protocol';
import { useRef, useState } from 'react';
import type { ApprovalAnswer } from '../../../shared/ipc.js';
import { useApp } from '../../app/app-context.js';
import { revealBidi } from '../reveal.js';
import { reason } from '../../shell/errors.js';
import { useApprovalKeys } from '../../approvals/use-approval-keys.js';
import { canAlwaysAllow } from './approval-keys.js';
import { DiffView } from './tools.js';
import { ApprovalOrigin } from '../../approvals/ApprovalOrigin.js';

const PREVIEW_CHARS = 480;
const PREVIEW_LINES = 8;

export function ApprovalCard({ request }: { readonly request: ApprovalRequest }) {
  const { t } = useApp();
  const card = useRef<HTMLElement>(null);
  const [feedback, setFeedback] = useState('');
  const offered = request.rules ?? [];
  const [rules, setRules] = useState(offered.join('\n'));
  const edited = rules
    .split('\n')
    .map((r) => r.trim())
    .filter(Boolean);
  const [directory, setDirectory] = useState(request.directory ?? '');
  const [expanded, setExpanded] = useState(false);
  const busy = useRef(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');
  const content = [request.command, request.diff?.unified].filter(Boolean).join('\n');
  const long = content.length > PREVIEW_CHARS || content.split('\n').length > PREVIEW_LINES;
  // T39: a network-domain card names a host; its "always" adds it to the allowed domains.
  const network = request.tool === 'SandboxNetwork' && request.domain != null;
  const allowPersistent =
    !network && request.protectedPath !== true && (offered.length > 0 || request.directory != null);
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
        ...(decision === 'allowAlways' && offered.length > 0 ? { rules: edited } : {}),
        ...(decision === 'allowAlways' && request.directory != null ? { directory } : {}),
        ...(decision === 'allowAlways' && network && request.domain != null
          ? { domain: request.domain }
          : {}),
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
  // T46: while the Auto mode reviewer decides, the card takes no answer.
  const reviewing = request.review?.state === 'reviewing';
  useApprovalKeys(
    card,
    (key) => {
      answer(key);
    },
    (key) => reviewing || (key === 'allowSession' && request.protectedPath === true),
  );
  return (
    <section
      ref={card}
      className="row approval-card"
      tabIndex={-1}
      aria-label={approvalLabel(request, t)}
      data-testid="approval-card"
      data-approval-card={request.kind}
      data-request-id={request.requestId}
    >
      <header>
        <strong>{network ? t('approval.network') : t(`approval.kind.${request.kind}`)}</strong>{' '}
        {!network && <span className="muted">{request.tool}</span>}
        {request.sandbox != null && !network && (
          <span
            className={`approval-sandbox${request.sandbox === 'unsandboxed' ? ' is-outside' : ''}`}
            data-testid="approval-sandbox"
            data-place={request.sandbox}
          >
            {t(
              request.sandbox === 'unsandboxed' ? 'approval.outsideSandbox' : 'approval.inSandbox',
            )}
          </span>
        )}
      </header>
      <ApprovalOrigin request={request} />
      <ReviewLine request={request} />
      {network && request.domain != null && (
        <div className="approval-path" data-testid="approval-domain">
          {t('approval.networkHost', { target: request.domain })}
        </div>
      )}
      {request.cwd && (
        <div className="approval-path">{t('approval.cwd', { path: revealBidi(request.cwd) })}</div>
      )}
      {request.path && <div className="approval-path">{revealBidi(request.path)}</div>}
      {request.directory && (
        <div className="approval-path">
          {t('approval.directory')} · {revealBidi(request.directory)}
        </div>
      )}
      {long && !expanded ? (
        <pre className="bash-command">
          {revealBidi(
            content.split('\n').slice(0, PREVIEW_LINES).join('\n').slice(0, PREVIEW_CHARS),
          )}
          …
        </pre>
      ) : (
        <>
          {request.command && <pre className="bash-command">{revealBidi(request.command)}</pre>}
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
                {revealBidi(request.diff.unified) || t('transcript.file.noDiff')}
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
      {!reviewing && (
        <>
          {!network && (
            <label>
              {t('approval.feedback')}
              <input
                value={feedback}
                onChange={(e) => {
                  setFeedback(e.target.value);
                }}
              />
            </label>
          )}
          {allowPersistent && offered.length > 0 && (
            <label>
              {t('approval.rule')}
              <textarea
                value={rules}
                rows={Math.min(Math.max(rules.split('\n').length, 1), 6)}
                data-testid="approval-rules"
                readOnly={request.kind === 'permissionExpansion' && request.tool === 'MemoryImport'}
                onChange={(e) => {
                  setRules(e.target.value);
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
                  (offered.length > 0 && edited.length === 0) ||
                  (request.directory != null && !directory.trim())
                }
                onClick={() => {
                  answer('allowAlways');
                }}
              >
                {t('approval.always')}
              </button>
            )}
            {network && (
              <button
                type="button"
                className="button"
                disabled={waiting}
                data-testid="approval-add-domain"
                onClick={() => {
                  answer('allowAlways');
                }}
              >
                {t('approval.addToAllowlist')}
              </button>
            )}
          </div>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

/** T46: the Auto mode reviewer is deciding the card, or why the card came back to the user. */
function ReviewLine({ request }: { readonly request: ApprovalRequest }) {
  const { t } = useApp();
  const review = request.review;
  if (review == null) return null;
  if (review.state === 'reviewing') {
    return (
      <p className="approval-review is-reviewing" data-testid="approval-reviewing" role="status">
        {review.model == null
          ? t('approval.review.reviewing')
          : t('approval.review.reviewingWith', { model: review.model })}
      </p>
    );
  }
  const why = review.fallback ?? 'unsure';
  return (
    <p className="approval-review" data-testid="approval-review" data-fallback={why}>
      {t(`approval.review.fallback.${why}`)}
      {review.reason != null && review.reason !== '' && (
        <>
          {' '}
          <span className="approval-review-reason">{revealBidi(review.reason)}</span>
        </>
      )}
    </p>
  );
}
