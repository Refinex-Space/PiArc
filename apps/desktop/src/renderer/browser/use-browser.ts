// The browser state of one session as the main process sends it (ADR-0088): the panel never
// keeps its own copy of tabs, it shows the newest state it got.
import { useEffect, useState } from 'react';

import type { BrowserRequest, BrowserSessionState } from '../../shared/browser.js';

function isState(value: unknown, sessionId: string): value is BrowserSessionState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'sessionId' in value &&
    value.sessionId === sessionId &&
    'revision' in value &&
    typeof value.revision === 'number' &&
    'tabs' in value &&
    Array.isArray(value.tabs) &&
    'spaces' in value &&
    Array.isArray(value.spaces) &&
    'prompts' in value &&
    Array.isArray(value.prompts)
  );
}

/** The session's browser state; `undefined` until the main process answered. */
export function useBrowserState(sessionId: string): {
  readonly state: BrowserSessionState | undefined;
  readonly failure: unknown;
} {
  const [state, setState] = useState<BrowserSessionState | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);
  useEffect(() => {
    let alive = true;
    const take = (next: BrowserSessionState) => {
      setState((current) =>
        current !== undefined && current.revision > next.revision ? current : next,
      );
    };
    const stop = window.piarc.onAppEvent((event) => {
      if (event.type === 'browser' && event.sessionId === sessionId) take(event.state);
    });
    window.piarc
      .browser(sessionId, { op: 'state' })
      .then((value) => {
        if (alive && isState(value, sessionId)) take(value);
      })
      .catch((error: unknown) => {
        if (alive) setFailure(error);
      });
    return () => {
      alive = false;
      stop();
    };
  }, [sessionId]);
  return { state, failure };
}

/** Sends `request` for the session; failures go to `onError`. */
export function browserCall(
  sessionId: string,
  request: BrowserRequest,
  onError: (error: unknown) => void,
): void {
  window.piarc.browser(sessionId, request).catch(onError);
}
