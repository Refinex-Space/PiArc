// The plan card (T26): an ExitPlanMode call waiting for the user. It shows the start of the
// plan and the comment count; the plan panel shows the whole text and takes inline comments.
// Three answers: approve and accept edits (Mod+Enter), approve and review edits
// (Mod+Shift+Enter), keep planning (Esc) with the feedback and the comments. The answer names
// the card's revision and Agent Host connection, like every approval.
import { approvalLabel } from './approval-label.js';
import type { ApprovalRequest } from '@piarc/protocol';
import { useEffect, useRef, useState } from 'react';

import { useApp } from '../app/app-context.js';
import { Keycaps } from '../app/Keycaps.js';
import { reason } from '../shell/errors.js';
import { showPanel } from '../shell/registry.js';
import { planPreview } from '../transcript/rows/harness.js';
import { answerRequest } from './answer.js';
import { planComments, usePlanComments } from './plan-comments.js';
import { useApprovalKeys } from './use-approval-keys.js';
import { ApprovalOrigin } from './ApprovalOrigin.js';

type Choice = 'acceptEdits' | 'default' | 'keepPlanning';

export function PlanApprovalCard({ request }: { readonly request: ApprovalRequest }) {
  const { t, keyPlatform } = useApp();
  const card = useRef<HTMLElement>(null);
  const comments = usePlanComments(request.requestId);
  const [feedback, setFeedback] = useState('');
  const busy = useRef(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');
  const plan = request.plan ?? '';
  // The whole plan is read in the panel: bring it forward when a plan arrives.
  useEffect(() => {
    showPanel('plan');
  }, [request.requestId]);

  function answer(choice: Choice) {
    if (busy.current) return;
    busy.current = true;
    setWaiting(true);
    setError('');
    const sent =
      choice === 'keepPlanning'
        ? {
            decision: 'deny' as const,
            ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
            ...(comments.length === 0
              ? {}
              : {
                  comments: comments.map(({ start, end, quote, text }) => ({
                    start,
                    end,
                    quote,
                    text,
                  })),
                }),
          }
        : { decision: 'allowOnce' as const, mode: choice };
    answerRequest(request, sent)
      .then((outcome) => {
        if (outcome === 'applied') planComments.clear(request.requestId);
        if (outcome === 'handled') setError(t('approval.handled'));
        if (outcome === 'cancelled') {
          busy.current = false;
          setWaiting(false);
        }
      })
      .catch((e: unknown) => {
        setError(reason(e));
        busy.current = false;
        setWaiting(false);
      });
  }
  useApprovalKeys(card, (key) => {
    answer(
      key === 'allowOnce' ? 'acceptEdits' : key === 'allowSession' ? 'default' : 'keepPlanning',
    );
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
      <div className="approval-box">
        <header className="approval-title">
          <strong>{t('approval.kind.plan')}</strong>
          <span className="approval-tool">{request.tool}</span>
        </header>
        <ApprovalOrigin request={request} />
        <pre className="plan-preview" data-testid="plan-preview">
          {planPreview(plan)}
        </pre>
        <div className="plan-card-meta">
          <span data-testid="plan-comment-count">
            {t('plan.comments', { count: comments.length })}
          </span>
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
        </div>
        <p className="muted">{t('plan.commentsHint')}</p>
        <label className="approval-field">
          <span className="approval-field-label">{t('approval.feedback')}</span>
          <textarea
            rows={2}
            value={feedback}
            data-testid="plan-feedback"
            onChange={(e) => {
              setFeedback(e.target.value);
            }}
          />
        </label>
        <div className="approval-actions">
          <button
            type="button"
            className="button"
            disabled={waiting}
            data-testid="plan-keep-planning"
            onClick={() => {
              answer('keepPlanning');
            }}
          >
            {t('plan.keepPlanning')}
          </button>
          <button
            type="button"
            className="button"
            disabled={waiting}
            data-testid="plan-approve-manual"
            onClick={() => {
              answer('default');
            }}
          >
            {t('plan.approveManual')}
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={waiting}
            data-testid="plan-approve-auto"
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
        {error && (
          <p className="approval-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
