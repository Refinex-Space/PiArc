// T46: a tool call the Auto mode reviewer decided shows whether it allowed or refused it, the
// reviewer model, and (expanded) the reviewer's reason. Text nodes only; direction controls in
// the reason are revealed like every other model-written text.
import type { ToolReview } from '@piarc/protocol';

import { useApp } from '../../app/app-context.js';
import { revealBidi } from '../reveal.js';

export function ReviewNote({ review }: { readonly review: ToolReview | null | undefined }) {
  const { t } = useApp();
  if (review == null) return null;
  return (
    <details className="tool-review" data-testid="tool-review" data-verdict={review.verdict}>
      <summary>
        <span className={`tool-review-badge is-${review.verdict}`}>
          {t(review.verdict === 'allow' ? 'transcript.review.allow' : 'transcript.review.deny')}
        </span>{' '}
        <span className="muted">{review.model}</span>
      </summary>
      <p className="tool-review-reason" data-testid="tool-review-reason">
        {t('transcript.review.reason')} {revealBidi(review.reason)}
      </p>
    </details>
  );
}
