// Window appearance per platform (architecture section 8.6): macOS gets a hidden title bar that
// keeps the traffic lights and a sidebar vibrancy material; Windows 11 gets Mica behind the
// window and the window controls overlay at the top right. The page paints the content areas
// opaque; only the sidebar lets the material through.
import { nativeTheme, type BrowserWindow, type BrowserWindowConstructorOptions } from 'electron';

import { COLORS } from '../../shared/design-tokens.js';

/** Height of the title bar area the page reserves (matches `--piarc-size-titlebar-height`). */
export const TITLEBAR_HEIGHT = 44;

/** Appearance options of the main window. */
export function mainWindowChrome(platform: string): BrowserWindowConstructorOptions {
  const dark = nativeTheme.shouldUseDarkColors;
  switch (platform) {
    case 'darwin':
      return {
        titleBarStyle: 'hidden',
        trafficLightPosition: { x: 16, y: 15 },
        vibrancy: 'sidebar',
        visualEffectState: 'followWindow',
        // Transparent so the vibrancy material shows where the page is transparent.
        backgroundColor: '#00000000',
      };
    case 'win32':
      return {
        titleBarStyle: 'hidden',
        titleBarOverlay: overlayColors(dark),
        backgroundMaterial: 'mica',
        backgroundColor: '#00000000',
      };
    default:
      return { backgroundColor: COLORS[dark ? 'dark' : 'light']['surface.app'] };
  }
}

function overlayColors(dark: boolean) {
  return {
    color: '#00000000',
    symbolColor: COLORS[dark ? 'dark' : 'light']['text.primary'],
    height: TITLEBAR_HEIGHT,
  };
}

/** Keeps the Windows window controls readable when the theme changes. */
export function followTheme(window: BrowserWindow, platform: string): void {
  if (platform !== 'win32') {
    return;
  }
  const update = () => {
    if (!window.isDestroyed()) {
      window.setTitleBarOverlay(overlayColors(nativeTheme.shouldUseDarkColors));
    }
  };
  nativeTheme.on('updated', update);
  window.once('closed', () => {
    nativeTheme.off('updated', update);
  });
}
