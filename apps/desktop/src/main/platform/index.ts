// Platform differences of the main process live here (coding standards 1.5).
import { app } from 'electron';

import { APP_IDENTIFIER } from '../app-identity.js';

/**
 * Whether the app quits when its last window closes. On macOS the app stays active and the
 * Dock icon reopens a window; the menu-bar and tray behaviour of architecture section 3.3
 * arrives with T18 and T35.
 */
export const quitsWhenAllWindowsClosed = process.platform !== 'darwin';

/**
 * Process-wide identity settings, before any window or notification exists. Windows: the
 * AppUserModelID groups taskbar entries and is the sender of toast notifications; it must match
 * the Start-menu shortcut the installer creates (checked on Windows in W0).
 */
export function applyAppIdentity(): void {
  if (process.platform === 'win32') {
    app.setAppUserModelId(APP_IDENTIFIER);
  }
}
