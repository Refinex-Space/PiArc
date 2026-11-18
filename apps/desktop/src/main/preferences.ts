// The client's preferences in the main process: read once from the user's settings file
// through Core at start, changed one key at a time through Core (which writes the file), and
// sent to every window after each change (src/shared/preferences.ts).
import type { CoreRuntime } from './core/native/piarc-core.js';
import { resolveLocale, type Locale } from '../shared/i18n/index.js';
import {
  DEFAULT_PREFERENCES,
  pointerOf,
  preferencesFrom,
  type Preferences,
} from '../shared/preferences.js';

/** The part of Core the store uses. */
export type SettingsCore = Pick<CoreRuntime, 'userSettings' | 'writeClientSetting'>;

export class PreferenceStore {
  private current: Preferences = DEFAULT_PREFERENCES;
  private readonly listeners = new Set<(preferences: Preferences) => void>();
  private readonly core: SettingsCore;
  private readonly systemLanguages: () => readonly string[];

  constructor(core: SettingsCore, systemLanguages: () => readonly string[]) {
    this.core = core;
    this.systemLanguages = systemLanguages;
  }

  /** Reads the settings file; a missing, unreadable or invalid file gives the defaults. */
  async load(): Promise<Preferences> {
    try {
      this.current = preferencesFrom(JSON.parse(await this.core.userSettings()));
    } catch (error) {
      console.warn('[preferences] using the defaults; the settings file could not be read', error);
      this.current = DEFAULT_PREFERENCES;
    }
    return this.current;
  }

  get(): Preferences {
    return this.current;
  }

  /** The locale the language preference resolves to now. */
  locale(): Locale {
    return resolveLocale(this.current.language, this.systemLanguages());
  }

  /**
   * Applies one change received from a window (validated here), writes it through Core and
   * tells the listeners. Throws `TypeError` for an invalid change.
   */
  async set(change: unknown): Promise<Preferences> {
    const target = pointerOf(change);
    if (target === undefined) {
      throw new TypeError('not a valid preference change');
    }
    const value = target.value === null ? null : JSON.stringify(target.value);
    const file = await this.core.writeClientSetting(target.pointer, value);
    this.current = preferencesFrom(JSON.parse(file));
    for (const listener of this.listeners) {
      listener(this.current);
    }
    return this.current;
  }

  onChange(listener: (preferences: Preferences) => void): void {
    this.listeners.add(listener);
  }
}
