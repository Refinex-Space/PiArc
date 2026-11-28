// The session status badge (architecture section 8.2): quiet marks like the reference's sidebar
// (a small dot family, a warning sign for errors), still told apart by shape, not only by color
// (forced colors and color blindness): error a warning triangle, awaiting a ring around a dot,
// running PiArc's activity mark, unread a dot; idle shows nothing.
import type { BadgeState } from '../store/status.js';
import { useT } from '../app/app-context.js';
import { ActivityMark } from '../transcript/rows/ActivityMark.js';
import { WarningGlyph } from './icons.js';

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
        <WarningGlyph size={12} />
      ) : null}
    </span>
  );
}
