// The shell's side of the first-run guide (ADR-0110): whether it opens by itself, opening it
// on "Connect a model" from Settings or the new session page, writing the preference when it
// is done, and the layer to render. Finishing in one window sets the preference, which every
// window receives: a guide that opened by itself closes everywhere.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { useApp } from '../app/app-context.js';
import type { AppStore } from '../store/app-store.js';
import { Onboarding, type OnboardingRequest } from './Onboarding.js';
import { autoShow } from './visibility.js';

export interface OnboardingControl {
  /** The layer covers the workbench (the guide, or the blank cover before it decides). */
  readonly covering: boolean;
  /** Opens "Connect a model" (Settings, the new session page). */
  readonly open: (from: 'settings' | 'home') => void;
  /** A link or a dropped folder started this window: the guide does not open by itself. */
  readonly noteLaunch: () => void;
  readonly layer: ReactNode;
}

export function useOnboarding(store: AppStore, settingsOpen: boolean): OnboardingControl {
  const { preferences } = useApp();
  const completed = preferences.onboarding.completed;
  const workspacesKnown = useSyncExternalStore(store.subscribeWorkspaces, store.hasWorkspaces);
  const workspaces = useSyncExternalStore(store.subscribeWorkspaces, store.workspaces).length;
  const [launched, setLaunched] = useState(false);
  const [request, setRequest] = useState<OnboardingRequest | null>(null);
  // Decided once per window: a workspace opened later does not close a guide already shown.
  const decided = useRef(false);
  const decision = autoShow({ completed, workspacesKnown, workspaces, launched });
  useEffect(() => {
    if (decided.current || decision === 'wait') return;
    decided.current = true;
    if (decision === 'show') setRequest({ step: 'welcome', from: 'auto', opener: null });
  }, [decision]);
  // Done in another window (or this one), or a link or dropped folder that arrived after the
  // first workspace snapshot: a guide that opened by itself closes (unfinished, so a later
  // plain start still offers it).
  useEffect(() => {
    if (completed || launched) setRequest((current) => (current?.from === 'auto' ? null : current));
  }, [completed, launched]);

  const close = useCallback((current: OnboardingRequest) => {
    setRequest(null);
    requestAnimationFrame(() => {
      if (current.opener?.isConnected === true) current.opener.focus();
    });
  }, []);
  const finish = useCallback(
    async (current: OnboardingRequest) => {
      if (!completed) {
        try {
          await window.piarc.setPreference({ key: 'onboarding.completed', value: true });
        } catch (error) {
          // Managed settings may lock the key: the guide still closes for this run.
          console.error('[onboarding] cannot save the first-run preference', error);
        }
      }
      close(current);
    },
    [completed, close],
  );
  const open = useCallback((from: 'settings' | 'home') => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRequest({ step: 'connect', from, opener });
  }, []);
  const noteLaunch = useCallback(() => {
    setLaunched(true);
  }, []);

  const pending = !decided.current && decision === 'wait';
  const layer =
    request !== null ? (
      <Onboarding
        key={`${request.from}-${request.step}`}
        request={request}
        hidden={settingsOpen}
        onFinish={() => finish(request)}
        onClose={() => {
          close(request);
        }}
      />
    ) : pending ? (
      <div className="onboarding-cover" data-testid="onboarding-cover" aria-hidden="true" />
    ) : null;
  return {
    covering: (request !== null && !settingsOpen) || pending,
    open,
    noteLaunch,
    layer,
  };
}
