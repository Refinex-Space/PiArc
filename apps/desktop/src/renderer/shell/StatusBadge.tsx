// The session status badge (architecture section 8.2): error, waiting for approval, running and
// unread each look different by shape, not only by color (forced colors and color blindness);
// idle shows nothing.
import type { BadgeState } from '../store/status.js';
import { useT } from '../app/app-context.js';
import { ActivityMark } from '../transcript/rows/ActivityMark.js';

export function StatusBadge({ state }: { readonly state: BadgeState }) {
  const t = useT();
  if (state === 'idle') {
    return <span className="badge badge-idle" aria-hidden="true" />;
  }
  const label = t(`session.status.${state}`);
  return (
    <span
      className={`badge badge-${state}`}
      role="img"
      aria-label={label}
      data-tooltip={label}
      data-testid="status-badge"
      data-state={state}
    >
      {state === 'running' ? (
        <ActivityMark activity="think" size={14} />
      ) : state === 'error' ? (
        '!'
      ) : state === 'awaiting' ? (
        '?'
      ) : (
        ''
      )}
    </span>
  );
}
