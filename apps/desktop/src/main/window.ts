// The window factory: the only place allowed to call `new BrowserWindow` (enforced by
// ESLint), so every window gets `secureWebPreferences`.
import { BrowserWindow } from 'electron';

import { secureWebPreferences } from './web-preferences.js';

/** Creates the main window. It is shown once the first frame is ready. */
export function createMainWindow(preloadPath: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'PiArc',
    show: false,
    webPreferences: secureWebPreferences(preloadPath),
  });
  window.once('ready-to-show', () => {
    window.show();
  });
  return window;
}
