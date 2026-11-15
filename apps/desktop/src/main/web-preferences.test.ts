import { describe, expect, it } from 'vitest';

import { secureWebPreferences } from './web-preferences.js';

describe('secureWebPreferences', () => {
  it('fixes the security-relevant preferences', () => {
    expect(secureWebPreferences('/preload.cjs')).toEqual({
      preload: '/preload.cjs',
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
    });
  });

  it('never sets enableBlinkFeatures', () => {
    expect(secureWebPreferences('/preload.cjs')).not.toHaveProperty('enableBlinkFeatures');
  });
});
