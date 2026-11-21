// Watches the session list for sessions that start needing the user (finished and unread, in
// error, waiting for approval): the main process notifies when the window is not in front, the
// window shows an in-app reminder, and the attention count goes to the Dock badge / taskbar
// overlay (the rule is `store/status.ts`). A session waiting for approval hands its first card to
// the notification (T42: buttons answer it through Core's ledger); an answer the ledger did not
// apply comes back as an app event and shows as a reminder.
import type { ApprovalRequest } from '@piarc/protocol';
import { useEffect, useRef } from 'react';

import type { NotificationApproval } from '../../shared/ipc.js';

import { useT } from '../app/app-context.js';
import { isWindowFocused } from '../app/window-focus.js';
import { useSessions } from '../store/hooks.js';
import { attentionCount, badgeOf, needsAttention, type BadgeState } from '../store/status.js';
import { sessionTitle } from './SessionRow.js';
import { useUi } from './ui.js';

/** What a notification shows of `card` and how it answers it. */
export function notificationApproval(card: ApprovalRequest): NotificationApproval {
  const summary =
    card.command ?? card.path ?? card.domain ?? (card.kind === 'plan' ? 'plan' : card.tool);
  return {
    requestId: card.requestId,
    sessionId: card.sessionId,
    revision: card.revision,
    connectionEpoch: card.connectionEpoch,
    tool: card.tool,
    summary: summary.slice(0, 4096),
    allow: card.notificationAllow === true,
  };
}

export function useAttention(): void {
  const t = useT();
  const ui = useUi();
  const sessions = useSessions();
  const previous = useRef<Map<string, BadgeState> | undefined>(undefined);
  const count = attentionCount(sessions);
  useEffect(() => {
    window.piarc.setAttentionCount(count).catch((error: unknown) => {
      console.error('[attention] cannot set the count', error);
    });
  }, [count]);
  useEffect(() => {
    const before = previous.current;
    const now = new Map(sessions.map((s) => [s.id, badgeOf(s)]));
    previous.current = now;
    if (before === undefined) {
      // The first list is the state at start: nothing new happened.
      return;
    }
    for (const session of sessions) {
      const was = before.get(session.id);
      const is = now.get(session.id);
      if (is === was || is === undefined || !needsAttention(session)) {
        continue;
      }
      const shown = ui.view.kind === 'session' && ui.view.id === session.id && isWindowFocused();
      if (shown) {
        continue;
      }
      const kind = is === 'awaiting' ? 'awaiting' : is === 'error' ? 'failed' : 'completed';
      const title = sessionTitle(session.title, t('session.untitled'));
      const card = kind === 'awaiting' ? session.approvals[0] : undefined;
      ui.addToast({
        sessionId: session.id,
        text: t(
          kind === 'awaiting'
            ? 'notify.awaiting'
            : kind === 'failed'
              ? 'notify.failed'
              : 'notify.completed',
          {
            title,
          },
        ),
      });
      window.piarc
        .notifyAttention({
          kind,
          sessionId: session.id,
          title,
          ...(card === undefined ? {} : { approval: notificationApproval(card) }),
        })
        .catch((error: unknown) => {
          console.error('[attention] cannot notify', error);
        });
    }
  }, [sessions, ui, t]);
  useEffect(
    () =>
      window.piarc.onAppEvent((event) => {
        if (event.type === 'approvalNotice') {
          ui.addToast({ sessionId: event.sessionId, text: t('notify.approvalStale') });
        }
      }),
    [ui, t],
  );
}
