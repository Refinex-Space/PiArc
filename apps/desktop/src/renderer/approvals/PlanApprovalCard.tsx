// The plan card (T26, ADR-0103): an ExitPlanMode call waiting for the user, as a compact decision
// bar under the plan's own row (which shows the plan; the plan panel shows it whole, with
// comments). Approve and accept edits (Mod+Enter), approve and review edits (Mod+Shift+Enter),
// revise (Esc: the composer takes the reply; a message sent while the card waits declines the
// plan with that message), send the inline comments alone, or stop the turn. The answer names the
// card's revision and Agent Host connection, like every approval.
import type { ApprovalRequest } from '@piarc/protocol';
import { useEffect, useRef, useState } from 'react';

import { useApp } from '../app/app-context.js';
import { IconButton } from '../app/IconButton.js';
import { Keycaps } from '../app/Keycaps.js';
import { reason } from '../shell/errors.js';
import { CloseIcon, CommentIcon } from '../shell/icons.js';
import { showPanel } from '../shell/registry.js';
import { approvalLabel } from './approval-label.js';
import { answerRequest } from './answer.js';
import { ApprovalOrigin } from './ApprovalOrigin.js';
import { planComments, usePlanComments } from './plan-comments.js';
import { commentsOf } from './plan-reply.js';
import { useApprovalKeys } from './use-approval-keys.js';

type Choice = 'acceptEdits' | 'default' | 'comments' | 'stop';

/** Puts the caret in the composer of the conversation `from` is in. */
function focusComposer(from: HTMLElement | null): void {
  const input = from
    ?.closest('.conversation')
    ?.querySelector<HTMLElement>('.composer [contenteditable="true"]');
  input?.focus();
}

export function PlanApprovalCard({ request }: { readonly request: ApprovalRequest }) {
  const { t, keyPlatform } = useApp();
  const card = useRef<HTMLElement>(null);
  const comments = usePlanComments(request.requestId);
  const busy = useRef(false);
  const [waiting, setWaiting] = useState<Choice | undefined>(undefined);
  const [error, setError] = useState('');
  // The plan is read in the panel: bring it forward when a plan arrives.
  useEffect(() => {
    showPanel('plan');
  }, [request.requestId]);

  function settle(work: Promise<unknown>, choice: Choice) {
    if (busy.current) return;
    busy.current = true;
    setWaiting(choice);
    setError('');
    work
      .then((outcome) => {
        if (outcome === 'applied' && choice === 'comments') planComments.clear(request.requestId);
        if (outcome === 'handled') setError(t('approval.handled'));
        if (outcome === 'cancelled' || choice === 'stop') {
          busy.current = false;
          setWaiting(undefined);
        }
      })
      .catch((e: unknown) => {
        setError(reason(e));
        busy.current = false;
        setWaiting(undefined);
      });
  }

  function answer(choice: 'acceptEdits' | 'default' | 'comments') {
    settle(
      answerRequest(
        request,
        choice === 'comments'
          ? { decision: 'deny', comments: commentsOf(request) }
          : { decision: 'allowOnce', mode: choice },
      ),
      choice,
    );
  }

  const revise = () => {
    focusComposer(card.current);
  };
  useApprovalKeys(card, (key) => {
    if (key === 'allowOnce') answer('acceptEdits');
    else if (key === 'allowSession') answer('default');
    else revise();
  });

  return (
    <section
      ref={card}
      className="row approval-card plan-card"
      tabIndex={-1}
      aria-label={approvalLabel(request, t)}
      data-testid="approval-card"
      data-approval-card="plan"
      data-request-id={request.requestId}
    >
      <div className="approval-box is-plan" aria-busy={waiting !== undefined}>
        <header className="approval-title">
          <strong>{t('approval.kind.plan')}</strong>
          <span className="approval-title-end">
            <button
              type="button"
              className="approval-link"
              data-testid="plan-open-panel"
              onClick={() => {
                showPanel('plan');
              }}
            >
              {t('plan.openPanel')}
            </button>
          </span>
        </header>
        <ApprovalOrigin request={request} />
        <p className="approval-message plan-card-hint">{t('plan.card.hint')}</p>
        {comments.length > 0 && (
          <ul
            className="plan-card-comments"
            data-testid="plan-comments"
            aria-label={t('plan.comments', { count: comments.length })}
          >
            {comments.map((c) => (
              <li key={c.id} data-testid="plan-comment">
                <button
                  type="button"
                  className="plan-card-comment"
                  onClick={() => {
                    showPanel('plan');
                    planComments.open(request.requestId, c.id);
                  }}
                >
                  <span className="plan-card-quote">
                    <CommentIcon />
                    <span className="truncate">{c.quote}</span>
                  </span>
                  <span className="plan-card-text">{c.text}</span>
                </button>
                <IconButton
                  size="xs"
                  label={t('plan.comment.delete')}
                  className="plan-card-remove"
                  onClick={() => {
                    planComments.remove(request.requestId, c.id);
                  }}
                >
                  <CloseIcon />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
        <div className="approval-actions plan-actions">
          <div className="approval-persist">
            <button
              type="button"
              className="button button-ghost"
              disabled={waiting !== undefined}
              data-testid="plan-stop"
              data-tooltip={t('plan.stopHint')}
              onClick={() => {
                settle(window.piarc.abort(request.sessionId), 'stop');
              }}
            >
              {t('plan.stop')}
            </button>
            {comments.length > 0 ? (
              <button
                type="button"
                className="button"
                disabled={waiting !== undefined}
                data-testid="plan-send-comments"
                onClick={() => {
                  answer('comments');
                }}
              >
                {t('plan.sendComments', { count: comments.length })}
              </button>
            ) : (
              <button
                type="button"
                className="button"
                disabled={waiting !== undefined}
                data-testid="plan-revise"
                data-tooltip={t('plan.reviseHint')}
                aria-keyshortcuts="Escape"
                onClick={revise}
              >
                {t('plan.revise')}
              </button>
            )}
          </div>
          <div className="approval-main">
            <button
              type="button"
              className="button"
              disabled={waiting !== undefined}
              data-testid="plan-approve-manual"
              data-tooltip={t('plan.approveManualHint')}
              data-tooltip-keys="Mod+Shift+Enter"
              aria-keyshortcuts={keyPlatform === 'mac' ? 'Meta+Shift+Enter' : 'Control+Shift+Enter'}
              onClick={() => {
                answer('default');
              }}
            >
              {t('plan.approveManual')}
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={waiting !== undefined}
              data-testid="plan-approve-auto"
              aria-keyshortcuts={keyPlatform === 'mac' ? 'Meta+Enter' : 'Control+Enter'}
              onClick={() => {
                answer('acceptEdits');
              }}
            >
              {t('plan.approveAuto')}
              <span className="approval-keys" aria-hidden="true">
                <Keycaps binding="Mod+Enter" platform={keyPlatform} />
              </span>
            </button>
          </div>
        </div>
        {error && (
          <p className="approval-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
