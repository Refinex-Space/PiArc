// The app around the windows (T18): the main and settings windows, the preferences and the
// language, the application menu, theme following, notifications and the attention count.
// Platform integration only: what a session is and when it needs the user is decided in the
// renderer from Core's snapshots (ADR-0013).
//
// T35: any number of main windows share the one Core (each subscribes to the same snapshots,
// so they show the same approvals and the first answer wins in Core's ledger). The most
// recently focused one is "the" main window for the menu, notifications and the attention
// count. Main windows take their position and size from the window state file. Links, dropped
// folders and second starts become launch targets: a window that has not taken its queue yet
// gets them when its page asks (`takeLaunchTargets`), a running page as an app event.
import { BrowserWindow, Menu, nativeTheme, screen } from 'electron';

import {
  APP_EVENT_CHANNEL,
  IPC_CHANNELS,
  isSessionId,
  type AppCommand,
  type AppEvent,
  type AppState,
  type AttentionNotice,
  type LaunchTarget,
  type NotificationApproval,
} from '../shared/ipc.js';
import { Translator } from '../shared/i18n/index.js';
import { effectiveBindings } from '../shared/keybindings.js';
import type { RegisterHandler } from './ipc/register.js';
import { buildMenuTemplate, type MainCommand } from './menu.js';
import { Attention } from './platform/attention.js';
import { followTheme, mainWindowChrome, settingsWindowChrome } from './platform/window-chrome.js';
import type { PreferenceStore } from './preferences.js';
import { CASCADE, placeWindow, type WindowStateFile } from './platform/window-state.js';
import { MAIN_WINDOW_MIN, createMainWindow, createSettingsWindow } from './window.js';

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
  /** Where main windows' position and size are kept. */
  readonly windowState: WindowStateFile;
  /** Quits after asking when work is running (T35). */
  readonly quit: () => void;
}

/** How long moving or resizing waits before the window state is written. */
const SAVE_DELAY_MS = 500;

export class AppShell {
  /** The most recently focused main window. */
  private main: BrowserWindow | null = null;
  private readonly mains = new Set<BrowserWindow>();
  /** Launch targets waiting for a window's page, by `webContents.id`. */
  private readonly pending = new Map<number, LaunchTarget[]>();
  /** Pages that took their queue: they hear launch targets as app events. */
  private readonly listening = new Set<number>();
  private settings: BrowserWindow | null = null;
  private readonly languageListeners = new Set<() => void>();
  private translator: Translator;
  readonly attention: Attention;

  constructor(private readonly options: AppShellOptions) {
    this.translator = new Translator(options.preferences.locale());
    this.attention = new Attention(
      process.platform,
      (sessionId) => {
        const window = this.focusMain();
        this.send(window, { type: 'openSession', sessionId });
      },
      {
        tell: (event) => {
          if (this.main !== null && !this.main.isDestroyed()) this.send(this.main, event);
        },
      },
    );
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

  /** Invalidate the main windows' model directory after a settings change. */
  providersChanged(): void {
    for (const window of this.mains) this.send(window, { type: 'providersChanged' });
  }

  mainWindow(): BrowserWindow | null {
    return this.main;
  }

  /** The open main windows. */
  mainWindows(): BrowserWindow[] {
    return [...this.mains].filter((w) => !w.isDestroyed());
  }

  /** Runs `listener` after the language changed (the tray rebuilds its texts). */
  onLanguage(listener: () => void): void {
    this.languageListeners.add(listener);
  }

  /** Opens a main window (or focuses the most recent one) and returns it. */
  focusMain(): BrowserWindow {
    const window = this.main === null || this.main.isDestroyed() ? this.openMain() : this.main;
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
    return window;
  }

  /** Opens another main window; `targets` wait for its page. */
  openMain(targets: readonly LaunchTarget[] = []): BrowserWindow {
    const areas = screen.getAllDisplays().map((display) => display.workArea);
    const primary = screen.getPrimaryDisplay().workArea;
    const ordered = [primary, ...areas.filter((a) => a !== primary)];
    const bounds = placeWindow(
      this.options.windowState.load(),
      ordered,
      MAIN_WINDOW_MIN,
      CASCADE * this.mainWindows().length,
    );
    const window = createMainWindow(this.options.preloadPath, {
      ...mainWindowChrome(process.platform),
      ...(bounds === undefined
        ? {}
        : { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }),
    });
    if (bounds?.maximized === true) {
      window.once('ready-to-show', () => {
        window.maximize();
      });
    }
    const id = window.webContents.id;
    this.pending.set(id, [...targets]);
    followTheme(window, process.platform);
    this.reportFocus(window);
    this.keepState(window);
    void window.loadURL(this.options.entryUrl);
    this.main = window;
    this.mains.add(window);
    window.on('focus', () => {
      this.main = window;
    });
    window.on('closed', () => {
      this.mains.delete(window);
      this.pending.delete(id);
      this.listening.delete(id);
      if (this.main === window) {
        this.main = this.mainWindows().at(-1) ?? null;
      }
    });
    return window;
  }

  /** Opens session `id` in a new main window (T35). */
  openSessionWindow(id: string): BrowserWindow {
    return this.openMain([{ kind: 'session', sessionId: id }]);
  }

  /**
   * Opens what a link, a dropped folder or a second start names: in the most recent main
   * window, opening one when none is open.
   */
  launch(target: LaunchTarget): void {
    if (this.main === null || this.main.isDestroyed()) {
      this.openMain([target]);
      return;
    }
    const window = this.focusMain();
    const id = window.webContents.id;
    if (this.listening.has(id)) {
      this.send(window, { type: 'launch', target });
    } else {
      this.pending.set(id, [...(this.pending.get(id) ?? []), target]);
    }
  }

  /** Writes the window's position and size when it moves, resizes or closes. */
  private keepState(window: BrowserWindow): void {
    let timer: NodeJS.Timeout | undefined;
    const save = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (window.isDestroyed()) return;
      const normal = window.getNormalBounds();
      this.options.windowState.save({ ...normal, maximized: window.isMaximized() });
    };
    const later = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(save, SAVE_DELAY_MS);
    };
    window.on('resize', later);
    window.on('move', later);
    window.on('close', save);
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
  run(command: AppCommand | MainCommand): void {
    if (command === 'app.settings') {
      this.openSettings();
      return;
    }
    if (command === 'app.quit') {
      this.options.quit();
      return;
    }
    if (command === 'window.new') {
      this.openMain();
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
      notificationsSupported: this.attention.notificationsSupported(),
    }));
    registerHandler(IPC_CHANNELS.launchTargets, (event): LaunchTarget[] => {
      const id = event.sender.id;
      this.listening.add(id);
      const targets = this.pending.get(id) ?? [];
      this.pending.set(id, []);
      return targets;
    });
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
    for (const listener of this.languageListeners) listener();
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
    value.title.length <= 400 &&
    (!('approval' in value) ||
      value.approval === undefined ||
      isNotificationApproval(value.approval))
  );
}

/**
 * The approval of a waiting session's notification (T42). Only its shape is checked here: Core
 * checks the identity (request, revision, connection) and whether a notification may allow it
 * when the answer arrives, so a wrong `allow` cannot get past it.
 */
export function isNotificationApproval(value: unknown): value is NotificationApproval {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  const count = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  return (
    typeof a.requestId === 'string' &&
    /^[A-Za-z0-9._:-]{1,128}$/u.test(a.requestId) &&
    isSessionId(a.sessionId) &&
    count(a.revision) &&
    count(a.connectionEpoch) &&
    typeof a.tool === 'string' &&
    a.tool.length > 0 &&
    a.tool.length <= 256 &&
    typeof a.summary === 'string' &&
    a.summary.length <= 4096 &&
    typeof a.allow === 'boolean'
  );
}
