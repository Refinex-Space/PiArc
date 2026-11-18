// M1 has no question form. Answer even when its session is not on screen; concurrent
// windows may both answer, and Core accepts the first one.
import { useEffect, useRef } from 'react';
import { useT } from '../app/app-context.js';
import { useSessions } from '../store/hooks.js';
import { reason } from './errors.js';
import { useUi } from './ui.js';

export function useUnsupportedQuestions(): void {
  const sessions = useSessions();
  const ui = useUi();
  const t = useT();
  const sent = useRef(new Set<string>());
  useEffect(() => {
    const active = new Set<string>();
    for (const session of sessions) {
      for (const request of session.approvals) {
        if (request.kind !== 'question') continue;
        const { sessionId, requestId, revision, connectionEpoch } = request;
        const key = JSON.stringify([sessionId, requestId, revision, connectionEpoch]);
        active.add(key);
        if (sent.current.has(key)) continue;
        sent.current.add(key);
        const feedback = t('approval.unsupported');
        window.piarc
          .answerApproval({
            sessionId,
            requestId,
            revision,
            connectionEpoch,
            decision: 'deny',
            feedback,
          })
          .then(
            () => {
              ui.addToast({ sessionId, text: feedback });
            },
            (failure: unknown) => {
              ui.addToast({ sessionId, text: reason(failure) });
            },
          );
      }
    }
    for (const key of sent.current) if (!active.has(key)) sent.current.delete(key);
  }, [sessions, t, ui]);
}
