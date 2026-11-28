// Auto mode's state in the environment bar (T46): nothing while the reviewer works; a status
// when it cannot be used (no reviewer model, not configured, below the bar, no Agent Host),
// when review is paused after refusals, or when the settings turned Auto mode off. Read from
// the session's entry of Core's `core/sessions` snapshot.
import { useT } from '../app/app-context.js';
import type { AutoReviewReason } from '../store/snapshots.js';

export function AutoReviewStatus({
  state,
  reason,
}: {
  readonly state: 'ready' | 'unavailable' | 'paused' | undefined;
  readonly reason: AutoReviewReason | undefined;
}) {
  const t = useT();
  if (state === undefined || state === 'ready') return null;
  const text = t(`autoReview.status.${reason ?? (state === 'paused' ? 'consecutive' : 'noModel')}`);
  return (
    <span
      className="tag auto-review-warning"
      role="status"
      data-testid="env-auto-review"
      data-state={state}
      data-reason={reason}
    >
      {text}
    </span>
  );
}
