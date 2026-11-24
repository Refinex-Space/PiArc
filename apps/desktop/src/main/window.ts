// The window factory: the only place allowed to call `new BrowserWindow` (enforced by
// ESLint), so every window gets `secureWebPreferences`.
import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron';

import { secureWebPreferences } from './web-preferences.js';
import { MAIN_WINDOW_DEFAULT } from './platform/window-state.js';

/** The smallest main window. */
export const MAIN_WINDOW_MIN = { width: 960, height: 600 } as const;

/**
 * Creates the main window with the platform's `chrome` (title bar, material) and, when given,
 * its position and size. It is shown once the first frame is ready.
 */
export function createMainWindow(
  preloadPath: string,
  chrome: BrowserWindowConstructorOptions = {},
): BrowserWindow {
  const window = new BrowserWindow({
    ...MAIN_WINDOW_DEFAULT,
    // Placement already fitted the display. A smaller physical work area takes precedence
    // over the usual minimum, otherwise Electron would expand the window past the screen.
    minWidth: Math.min(MAIN_WINDOW_MIN.width, chrome.width ?? MAIN_WINDOW_DEFAULT.width),
    minHeight: Math.min(MAIN_WINDOW_MIN.height, chrome.height ?? MAIN_WINDOW_DEFAULT.height),
    // i18n-exempt: the product name, the same in every language.
    title: 'PiArc',
    show: false,
    ...chrome,
    webPreferences: secureWebPreferences(preloadPath),
  });
  window.once('ready-to-show', () => {
    window.show();
  });
  reloadAfterCrash(window);
  return window;
}

/** A renderer that went away more often than this within a minute is not reloaded again. */
export const CRASH_RELOADS_PER_MINUTE = 3;

/**
 * Reloads `window` when its renderer goes away abnormally (crash, out of memory, killed): the
 * page comes back and reads the session list from Core again (chapter 11: renderer recovery
 * within 2 s, the sessions go on in Core and the Agent Host). A page that crashes as it loads
 * would loop, so reloads stop after `CRASH_RELOADS_PER_MINUTE` within a minute.
 */
export function reloadAfterCrash(window: BrowserWindow): void {
  const recent: number[] = [];
  window.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit' || window.isDestroyed()) return;
    const now = Date.now();
    while (recent.length > 0 && now - (recent[0] ?? now) > 60_000) recent.shift();
    if (recent.length >= CRASH_RELOADS_PER_MINUTE) {
      console.error(`[window] renderer gone (${details.reason}) again; not reloading`);
      return;
    }
    recent.push(now);
    console.error(`[window] renderer gone (${details.reason}); reloading`);
    window.webContents.reload();
  });
}
