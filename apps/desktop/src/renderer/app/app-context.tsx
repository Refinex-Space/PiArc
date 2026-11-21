// What every window's React tree shares besides the store: the platform, the current
// preferences and the translator. Preferences change through `window.piarc.setPreference`; the
// main process then sends the new ones to every window (an app event), which re-renders here.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { AppEvent, AppState } from '../../shared/ipc.js';
import {
  Translator,
  type Locale,
  type MessageId,
  type MessageValues,
} from '../../shared/i18n/index.js';
import { keyPlatformOf, type KeyPlatform } from '../../shared/keybindings.js';
import type { Preferences } from '../../shared/preferences.js';
import { applyAppearance } from './appearance.js';
import { setWindowFocused } from './window-focus.js';
import { setWindowVisible } from './window-visibility.js';

export interface AppContextValue {
  readonly platform: string;
  readonly keyPlatform: KeyPlatform;
  /** The system shows PiArc's notifications (T42). */
  readonly notificationsSupported: boolean;
  readonly preferences: Preferences;
  readonly locale: Locale;
  readonly t: (id: MessageId, values?: MessageValues) => string;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (value === null) {
    throw new Error('useApp outside AppProvider');
  }
  return value;
}

/** The translator of the current language. */
export function useT(): AppContextValue['t'] {
  return useApp().t;
}

export function AppProvider({
  initial,
  children,
}: {
  readonly initial: AppState;
  readonly children: ReactNode;
}) {
  const [state, setState] = useState({ preferences: initial.preferences, locale: initial.locale });
  useEffect(() => {
    setWindowFocused(initial.focused);
    return window.piarc.onAppEvent((event: AppEvent) => {
      if (event.type === 'preferences') {
        setState({ preferences: event.preferences, locale: event.locale });
      } else if (event.type === 'focus') {
        setWindowFocused(event.focused);
      } else if (event.type === 'visibility') {
        setWindowVisible(event.visible);
      }
    });
  }, [initial.focused]);
  useEffect(
    () => applyAppearance(document.documentElement, initial.platform, state.preferences),
    [initial.platform, state.preferences],
  );
  useEffect(() => {
    document.documentElement.lang = state.locale;
  }, [state.locale]);
  const value = useMemo<AppContextValue>(() => {
    const translator = new Translator(state.locale);
    return {
      platform: initial.platform,
      keyPlatform: keyPlatformOf(initial.platform),
      notificationsSupported: initial.notificationsSupported,
      preferences: state.preferences,
      locale: state.locale,
      t: (id, values) => translator.t(id, values),
    };
  }, [initial.platform, initial.notificationsSupported, state]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
