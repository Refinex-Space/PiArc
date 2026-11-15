// Navigation, redirect and new-window rules applied to every webContents
// (architecture section 10.3, Electron security checklist items 13 and 14).
import type { WebContents } from 'electron';

import { originOf } from './origin.js';

/**
 * True when `url` parses and its origin is one of `trustedOrigins`. Compares parsed origins,
 * never string prefixes, so `app://piarc.evil` does not pass for `app://piarc`.
 */
export function isTrustedUrl(url: string, trustedOrigins: readonly string[]): boolean {
  const origin = originOf(url);
  return origin !== 'null' && trustedOrigins.includes(origin);
}

/** Origin of `url` for log lines; never logs paths or query strings, which may hold secrets. */
export function originForLog(url: string): string {
  const origin = originOf(url);
  if (origin !== 'null') {
    return origin;
  }
  try {
    return new URL(url).protocol;
  } catch {
    return '<invalid url>';
  }
}

/**
 * Blocks navigation and redirects away from `trustedOrigins`, denies every new window and
 * every `<webview>`. Installed on all webContents from `app.on('web-contents-created')`, so
 * no window or embedded contents can miss it.
 */
export function guardWebContents(contents: WebContents, trustedOrigins: readonly string[]): void {
  contents.on('will-navigate', (event) => {
    if (!isTrustedUrl(event.url, trustedOrigins)) {
      event.preventDefault();
      console.warn(`[security] blocked navigation to ${originForLog(event.url)}`);
    }
  });
  contents.on('will-redirect', (event) => {
    if (!isTrustedUrl(event.url, trustedOrigins)) {
      event.preventDefault();
      console.warn(`[security] blocked redirect to ${originForLog(event.url)}`);
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    console.warn(`[security] denied new window for ${originForLog(url)}`);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
    console.warn('[security] denied <webview>');
  });
}
