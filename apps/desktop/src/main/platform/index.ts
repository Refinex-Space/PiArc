// Platform differences of the main process live here (coding standards 1.5).

/**
 * Whether the app quits when its last window closes. On macOS the app stays active and the
 * Dock icon reopens a window; the menu-bar and tray behaviour of architecture section 3.3
 * arrives with T18 and T35.
 */
export const quitsWhenAllWindowsClosed = process.platform !== 'darwin';
