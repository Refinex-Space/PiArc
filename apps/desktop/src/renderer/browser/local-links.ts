// Local links in the conversation (design addendum B5.5): with "Open local links in the
// preview" on, a link to this machine (`localhost`, `127.x`, `[::1]`, `*.localhost` and the
// user's local development names) opens in the session's preview instead of the system
// browser. Other links keep the main process's confirmation (`openExternal`).
import type { BrowserSettings } from '../../shared/preferences.js';
import { showPanel } from '../shell/registry.js';

/** Whether `name` matches one of the local development names (`*.test`, `dev.local`). */
function localName(name: string, names: readonly string[]): boolean {
  return names.some((pattern) =>
    pattern.startsWith('*.') ? name.endsWith(pattern.slice(1)) : name === pattern,
  );
}

/** Whether `href` is an http(s) address of this machine. */
export function isLocalLink(href: string, names: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  const host = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host === '::1' ||
    localName(host, names)
  );
}

/**
 * Opens a local `href` in session `sessionId`'s preview when the setting is on; answers
 * whether it did (the caller opens other links as before).
 */
export function openLocalLink(
  sessionId: string,
  href: string,
  settings: Pick<BrowserSettings, 'openLocalLinks' | 'localHostnames'>,
): boolean {
  if (!settings.openLocalLinks || !isLocalLink(href, settings.localHostnames)) return false;
  showPanel('preview');
  window.piarc
    .browser(sessionId, { op: 'navigate', input: href, newTab: true })
    .catch((error: unknown) => {
      console.warn('[browser] could not open the local link', error);
    });
  return true;
}
