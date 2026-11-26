// The fixed `webPreferences` of every window (architecture section 10.3, Electron security
// checklist items 2-4, 6 and 8-11). Only the preload path varies.
import type { WebPreferences } from 'electron';

/** Secure web preferences of a window that loads nothing and has no preload. */
export function blankWebPreferences(): WebPreferences {
  return {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    navigateOnDragDrop: false,
  };
}

/** Secure web preferences with `preload` as the only variable. */
export function secureWebPreferences(preload: string): WebPreferences {
  return { preload, ...blankWebPreferences() };
}
