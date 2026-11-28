// The status badge and the "needs the user" definition (architecture section 8.2, 8.8). Kept in
// one place: the sidebar badge, the Dock badge / taskbar overlay count and the notifications
// all read it.
import type { SessionEntry } from './snapshots.js';

/** Badge states, highest priority first. */
export const BADGE_PRIORITY = ['error', 'awaiting', 'running', 'unread', 'idle'] as const;
export type BadgeState = (typeof BADGE_PRIORITY)[number];

/** The session's badge: error > waiting for approval > running > unread > idle. */
export function badgeOf(
  session: Pick<SessionEntry, 'status' | 'pendingApprovals' | 'unread'>,
): BadgeState {
  if (session.status === 'error') {
    return 'error';
  }
  if (session.pendingApprovals > 0) {
    return 'awaiting';
  }
  if (session.status === 'running') {
    return 'running';
  }
  return session.unread ? 'unread' : 'idle';
}

/**
 * Whether a session needs the user: waiting for approval, in error, or finished and unread.
 * Archived sessions never do.
 */
export function needsAttention(session: SessionEntry): boolean {
  if (session.archived) {
    return false;
  }
  const badge = badgeOf(session);
  return badge === 'error' || badge === 'awaiting' || badge === 'unread';
}

/** The number on the Dock badge / taskbar overlay. */
export function attentionCount(sessions: readonly SessionEntry[]): number {
  return sessions.filter(needsAttention).length;
}
