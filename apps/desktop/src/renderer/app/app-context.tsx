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
import { setErrorLocale } from './error-text.js';
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
  /** Numbers and times in the app's language (not the system's). */
  readonly format: {
    number(value: number, options?: Intl.NumberFormatOptions): string;
    dateTime(ms: number): string;
    /** How long ago `ms` was at `now` ("5 minutes ago", "yesterday"); "just now" under a minute. */
    relative(ms: number, now: number): string;
  };
}

/** Seconds in each unit, largest first, for relative times. */
const RELATIVE_UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

/** Intl formatters are costly to make: one of each per language and options, reused. */
const formatters = new Map<
  string,
  Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat
>();

function cached<T extends Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat>(
  key: string,
  make: () => T,
): T {
  const found = formatters.get(key);
  if (found !== undefined) return found as T;
  const made = make();
  formatters.set(key, made);
  return made;
}

function relativeTime(
  locale: string,
  translator: { t: (id: MessageId) => string },
  ms: number,
  now: number,
): string {
  const seconds = Math.round((ms - now) / 1000);
  const unit = RELATIVE_UNITS.find(([, size]) => Math.abs(seconds) >= size);
  if (unit === undefined) return translator.t('time.justNow');
  return cached(
    `relative:${locale}`,
    () => new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }),
  ).format(Math.round(seconds / unit[1]), unit[0]);
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
    // Failed calls describe themselves outside React (`shell/errors.ts`); set before the
    // children render, so even a first render reads errors in the window's language.
    setErrorLocale(state.locale);
    return {
      platform: initial.platform,
      keyPlatform: keyPlatformOf(initial.platform),
      notificationsSupported: initial.notificationsSupported,
      preferences: state.preferences,
      locale: state.locale,
      t: (id, values) => translator.t(id, values),
      format: {
        number: (value, options) =>
          cached(
            `number:${state.locale}:${options === undefined ? '' : JSON.stringify(options)}`,
            () => new Intl.NumberFormat(state.locale, options),
          ).format(value),
        dateTime: (ms) =>
          cached(
            `dateTime:${state.locale}`,
            () =>
              new Intl.DateTimeFormat(state.locale, {
                dateStyle: 'medium',
                timeStyle: 'medium',
              }),
          ).format(ms),
        relative: (ms, now) => relativeTime(state.locale, translator, ms, now),
      },
    };
  }, [initial.platform, initial.notificationsSupported, state]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
