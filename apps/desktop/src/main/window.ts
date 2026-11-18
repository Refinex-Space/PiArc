// The window factory: the only place allowed to call `new BrowserWindow` (enforced by
// ESLint), so every window gets `secureWebPreferences`.
import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron';

import { secureWebPreferences } from './web-preferences.js';

/**
 * Creates the main window with the platform's `chrome` (title bar, material). It is shown once
 * the first frame is ready.
 */
export function createMainWindow(
  preloadPath: string,
  chrome: BrowserWindowConstructorOptions = {},
): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'PiArc',
    show: false,
    ...chrome,
    webPreferences: secureWebPreferences(preloadPath),
  });
  window.once('ready-to-show', () => {
    window.show();
  });
  return window;
}

/** Creates the settings window (architecture section 8.2: settings are a separate window). */
export function createSettingsWindow(
  preloadPath: string,
  title: string,
  chrome: BrowserWindowConstructorOptions = {},
): BrowserWindow {
  const window = new BrowserWindow({
    width: 760,
    height: 560,
    minWidth: 600,
    minHeight: 420,
    title,
    show: false,
    fullscreenable: false,
    ...chrome,
    webPreferences: secureWebPreferences(preloadPath),
  });
  window.once('ready-to-show', () => {
    window.show();
  });
  return window;
}
