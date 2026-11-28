// Platform differences of the main process live here (coding standards 1.5).
import { app } from 'electron';

import { APP_IDENTIFIER } from '../app-identity.js';

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
