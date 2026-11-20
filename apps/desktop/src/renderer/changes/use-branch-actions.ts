// What a user message's branch buttons do (T28): switching continues the session on another
// branch (Core reopens it and the transcript reloads); "branch from here" opens a new session
// whose conversation stops before the message, with the message in its input.
import { useMemo } from 'react';

import { useT } from '../app/app-context.js';
import { reason } from '../shell/errors.js';
import { useUi } from '../shell/ui.js';
import { setDraft } from './drafts.js';

function sessionIdOf(text: string): string | undefined {
  const value: unknown = JSON.parse(text);
  return typeof value === 'object' && value !== null && 'sessionId' in value
    ? typeof value.sessionId === 'string'
      ? value.sessionId
      : undefined
    : undefined;
}

export function useBranchActions(
  sessionId: string,
  onError: (message: string) => void,
): {
  readonly switchBranch: (entryId: string) => void;
  readonly branchFrom: (turnId: string, text: string) => void;
} {
  const t = useT();
  const ui = useUi();
  return useMemo(
    () => ({
      switchBranch: (entryId: string) => {
        window.piarc.switchBranch(sessionId, entryId).catch((failure: unknown) => {
          onError(t('branches.failed', { reason: reason(failure) }));
        });
      },
      branchFrom: (turnId: string, text: string) => {
        window.piarc.forkSession(sessionId, turnId).then(
          (answer) => {
            const forked = sessionIdOf(answer);
            if (forked === undefined) return;
            setDraft(forked, text);
            ui.show({ kind: 'session', id: forked });
          },
          (failure: unknown) => {
            onError(t('branches.forkFailed', { reason: reason(failure) }));
          },
        );
      },
    }),
    [sessionId, onError, t, ui],
  );
}
