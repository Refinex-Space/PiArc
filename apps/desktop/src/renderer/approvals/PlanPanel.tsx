// The plan panel (T26, a dock tile): the whole plan of the selected session. A plan waiting for
// review takes inline comments: select a passage, write the comment; the passage is marked and
// the comment listed, and the plan card sends them with "Keep planning". Without a pending plan
// the panel shows the last approved one, read-only. The plan is shown as its source text so
// that selections map to UTF-16 offsets of the plan exactly.
import type { ApprovalRequest } from '@piarc/protocol';
import { useRef, useState, type ReactNode } from 'react';

import { useT } from '../app/app-context.js';
import { useHarness, useSession } from '../store/hooks.js';
import { planComments, usePlanComments, type DraftComment } from './plan-comments.js';
import { selectionRange } from './selection.js';

/** The plan split at the comments: plain text and marked passages, nothing else. */
function marked(plan: string, comments: readonly DraftComment[]): ReactNode[] {
  const parts: ReactNode[] = [];
  let at = 0;
  comments.forEach((c, i) => {
    if (c.start > at) parts.push(plan.slice(at, c.start));
    parts.push(
      <mark key={c.id} className="plan-comment-mark" data-testid="plan-mark" title={c.text}>
        {plan.slice(c.start, c.end)}
        <sup aria-hidden="true" className="plan-comment-ref" data-index={String(i + 1)} />
      </mark>,
    );
    at = c.end;
  });
  if (at < plan.length) parts.push(plan.slice(at));
  return parts;
}

function PendingPlan({ request }: { readonly request: ApprovalRequest }) {
  const t = useT();
  const plan = request.plan ?? '';
  const comments = usePlanComments(request.requestId);
  const text = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<{ start: number; end: number } | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const pickSelection = () => {
    const selection = window.getSelection();
    const container = text.current;
    if (selection === null || selection.rangeCount === 0 || container === null) return;
    const found = selectionRange(container, selection.getRangeAt(0));
    if (found !== undefined) {
      setRange(found);
      setError('');
    }
  };
  const add = () => {
    if (range === undefined) return;
    if (planComments.add(request.requestId, plan, range.start, range.end, draft)) {
      setRange(undefined);
      setDraft('');
      window.getSelection()?.removeAllRanges();
    } else {
      setError(t('plan.panel.overlap'));
    }
  };
  return (
    <div className="plan-panel" data-testid="plan-panel" data-state="pending">
      <h2 className="plan-panel-title">{t('plan.panel.pending')}</h2>
      <p className="muted">{t('plan.commentsHint')}</p>
      <div
        ref={text}
        className="plan-text"
        data-testid="plan-text"
        onMouseUp={pickSelection}
        onKeyUp={pickSelection}
      >
        {marked(plan, comments)}
      </div>
      {range !== undefined && (
        <div className="plan-comment-editor" data-testid="plan-comment-editor">
          <blockquote>{plan.slice(range.start, range.end)}</blockquote>
          <label>
            {t('plan.panel.commentLabel')}
            <textarea
              rows={2}
              value={draft}
              data-testid="plan-comment-input"
              onChange={(e) => {
                setDraft(e.target.value);
              }}
            />
          </label>
          <div className="approval-actions">
            <button
              type="button"
              className="button"
              onClick={() => {
                setRange(undefined);
                setDraft('');
              }}
            >
              {t('plan.panel.cancel')}
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={!draft.trim()}
              data-testid="plan-comment-add"
              onClick={add}
            >
              {t('plan.panel.addComment')}
            </button>
          </div>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {comments.length > 0 && (
        <ol className="plan-comments" data-testid="plan-comments">
          {comments.map((c) => (
            <li key={c.id} data-testid="plan-comment">
              <blockquote>{c.quote}</blockquote>
              <span>{c.text}</span>
              <button
                type="button"
                className="row-action"
                onClick={() => {
                  planComments.remove(request.requestId, c.id);
                }}
              >
                {t('plan.panel.remove')}
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function PlanPanel({ sessionId }: { readonly sessionId: string | undefined }) {
  const t = useT();
  const session = useSession(sessionId);
  const harness = useHarness(sessionId);
  const pending = session?.approvals.find((r) => r.kind === 'plan');
  if (pending !== undefined) return <PendingPlan key={pending.requestId} request={pending} />;
  const approved = harness?.plan;
  if (approved === undefined) {
    return <p className="muted plan-panel">{t('plan.panel.empty')}</p>;
  }
  return (
    <div className="plan-panel" data-testid="plan-panel" data-state="approved">
      <h2 className="plan-panel-title">
        {t('plan.panel.approved')}{' '}
        <span className="muted">· {t(`approval.mode.${approved.mode}`)}</span>
      </h2>
      <div className="plan-text" data-testid="plan-text">
        {approved.plan}
      </div>
    </div>
  );
}
