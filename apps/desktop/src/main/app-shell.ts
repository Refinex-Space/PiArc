// The app around the windows (T18): the main and settings windows, the preferences and the
// language, the application menu, theme following, notifications and the attention count.
// Platform integration only: what a session is and when it needs the user is decided in the
// renderer from Core's snapshots (ADR-0013).
import { BrowserWindow, Menu, nativeTheme } from 'electron';

import {
  APP_EVENT_CHANNEL,
  IPC_CHANNELS,
  isSessionId,
  type AppCommand,
  type AppEvent,
  type AppState,
  type AttentionNotice,
} from '../shared/ipc.js';
import { Translator } from '../shared/i18n/index.js';
import { effectiveBindings } from '../shared/keybindings.js';
import type { RegisterHandler } from './ipc/register.js';
import { buildMenuTemplate } from './menu.js';
import { Attention } from './platform/attention.js';
import { followTheme, mainWindowChrome, settingsWindowChrome } from './platform/window-chrome.js';
import type { PreferenceStore } from './preferences.js';
import { createMainWindow, createSettingsWindow } from './window.js';

/** Hash route of the settings window's page (src/renderer/main.tsx). */
export const SETTINGS_HASH = '#/settings';

/** Settings pages a caller may ask for; anything else opens the first page. */
const SETTINGS_PAGE = /^[a-z][a-zA-Z0-9.-]{0,63}$/;

export interface AppShellOptions {
  readonly preloadPath: string;
  /** The URL the windows load (the app scheme, or the dev server). */
  readonly entryUrl: string;
  readonly preferences: PreferenceStore;
  /** Development build: developer menu entries. */
  readonly developer: boolean;
}

export class AppShell {
  private main: BrowserWindow | null = null;
  private settings: BrowserWindow | null = null;
  private translator: Translator;
  readonly attention: Attention;

  constructor(private readonly options: AppShellOptions) {
    this.translator = new Translator(options.preferences.locale());
    this.attention = new Attention(process.platform, (sessionId) => {
      const window = this.focusMain();
      this.send(window, { type: 'openSession', sessionId });
    });
    options.preferences.onChange(() => {
      this.applyPreferences();
    });
  }

  /** The current translator (the language can change at any time). */
  t(): Translator {
    return this.translator;
  }

  /** Applies the preferences that live in the main process and builds the menu. */
  start(): void {
    this.applyPreferences();
  }

  /** Invalidate the main window's model directory after a settings change. */
  providersChanged(): void {
    if (this.main !== null) this.send(this.main, { type: 'providersChanged' });
  }

  mainWindow(): BrowserWindow | null {
    return this.main;
  }

  /** Opens the main window (or focuses it) and returns it. */
  focusMain(): BrowserWindow {
    const window = this.main === null || this.main.isDestroyed() ? this.openMain() : this.main;
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
    return window;
  }

  openMain(): BrowserWindow {
    const window = createMainWindow(this.options.preloadPath, mainWindowChrome(process.platform));
    followTheme(window, process.platform);
    this.reportFocus(window);
    void window.loadURL(this.options.entryUrl);
    this.main = window;
    window.on('closed', () => {
      if (this.main === window) {
        this.main = null;
      }
    });
    return window;
  }

  /** Opens the settings window on `page` (or focuses it). */
  openSettings(page?: string): BrowserWindow {
    const hash =
      page !== undefined && SETTINGS_PAGE.test(page) ? `${SETTINGS_HASH}/${page}` : SETTINGS_HASH;
    if (this.settings !== null && !this.settings.isDestroyed()) {
      if (page !== undefined) {
        void this.settings.loadURL(`${this.options.entryUrl}${hash}`);
      }
      this.settings.show();
      this.settings.focus();
      return this.settings;
    }
    const window = createSettingsWindow(
      this.options.preloadPath,
      this.translator.t('settings.title'),
      settingsWindowChrome(),
    );
    this.reportFocus(window);
    void window.loadURL(`${this.options.entryUrl}${hash}`);
    this.settings = window;
    window.on('closed', () => {
      if (this.settings === window) {
        this.settings = null;
      }
    });
    return window;
  }

  /** Runs a command from the menu (or a shortcut the menu handled). */
  run(command: AppCommand): void {
    if (command === 'app.settings') {
      this.openSettings();
      return;
    }
    const window = this.focusMain();
    this.send(window, { type: 'command', command });
  }

  /** Registers the app-level commands of `window.piarc`. */
  registerHandlers(registerHandler: RegisterHandler): void {
    registerHandler(IPC_CHANNELS.appState, (event): AppState => ({
      platform: process.platform,
      preferences: this.options.preferences.get(),
      locale: this.options.preferences.locale(),
      focused: BrowserWindow.fromWebContents(event.sender)?.isFocused() ?? false,
    }));
    registerHandler(IPC_CHANNELS.preferencesSet, (_event, [change]) =>
      this.options.preferences.set(change),
    );
    registerHandler(IPC_CHANNELS.settingsOpen, (_event, [page]) => {
      this.openSettings(typeof page === 'string' ? page : undefined);
    });
    registerHandler(IPC_CHANNELS.attentionNotify, (event, [notice]) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window === null || window !== this.main || !isAttentionNotice(notice)) {
        return;
      }
      this.attention.notify(
        window,
        notice,
        this.translator,
        this.options.preferences.get().notifications.enabled,
      );
    });
    registerHandler(IPC_CHANNELS.attentionCount, (event, [count]) => {
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 9999) {
        throw new TypeError('count must be a non-negative integer');
      }
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window !== this.main) {
        return;
      }
      this.attention.setCount(window ?? undefined, count, this.translator);
    });
  }

  private applyPreferences(): void {
    const preferences = this.options.preferences.get();
    this.translator = new Translator(this.options.preferences.locale());
    // Follows the user's theme choice in the renderer's `prefers-color-scheme`, the vibrancy
    // material, native dialogs and menus.
    nativeTheme.themeSource = preferences.appearance.theme;
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildMenuTemplate({
          platform: process.platform,
          translator: this.translator,
          bindings: effectiveBindings(preferences.keybindings),
          developer: this.options.developer,
          run: (command) => {
            this.run(command);
          },
        }),
      ),
    );
    this.settings?.setTitle(this.translator.t('settings.title'));
    const event: AppEvent = {
      type: 'preferences',
      preferences,
      locale: this.translator.locale,
    };
    for (const window of BrowserWindow.getAllWindows()) {
      this.send(window, event);
    }
  }

  /** Tells the window's page when it comes to the front or leaves it, and when it is minimized. */
  private reportFocus(window: BrowserWindow): void {
    window.on('focus', () => {
      this.send(window, { type: 'focus', focused: true });
    });
    window.on('blur', () => {
      this.send(window, { type: 'focus', focused: false });
    });
    // Minimized pages may keep running animation frames: views that pull per frame stop.
    const visibility = (visible: boolean) => () => {
      this.send(window, { type: 'visibility', visible });
    };
    window.on('minimize', visibility(false));
    window.on('hide', visibility(false));
    window.on('restore', visibility(true));
    window.on('show', visibility(true));
  }

  private send(window: BrowserWindow, event: AppEvent): void {
    if (!window.isDestroyed()) {
      window.webContents.send(APP_EVENT_CHANNEL, event);
    }
  }
}

function isAttentionNotice(value: unknown): value is AttentionNotice {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value.kind === 'completed' || value.kind === 'awaiting' || value.kind === 'failed') &&
    'sessionId' in value &&
    isSessionId(value.sessionId) &&
    'title' in value &&
    typeof value.title === 'string' &&
    value.title.length <= 400
  );
}
