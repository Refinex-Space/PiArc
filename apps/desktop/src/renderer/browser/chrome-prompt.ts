// The preview's offer to bring Chrome's sign-ins into a workspace (design addendum B5.1): once per
// workspace, on a site of the web, when Chrome has profiles and the workspace has no imported
// sign-ins yet. Which workspaces were asked is a convenience of this machine's window (its local
// storage): losing it only means one more offer.
import { isLocalLink } from './local-links.js';

/** Workspaces remembered at most (the oldest go first). */
export const PROMPTED_LIMIT = 200;
const KEY = 'piarc.browser.chromePrompted';

/** The host the offer is about: a site of the web, not this machine, the LAN or an address. */
export function promptHost(url: string, localNames: readonly string[]): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  if (isLocalLink(url, localNames)) return undefined;
  const host = parsed.hostname.replace(/\.$/u, '').toLowerCase();
  // IP literals: an address is not a site one signs in to by name.
  if (host.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) return undefined;
  if (!host.includes('.')) return undefined;
  return host;
}

/** `list` with `workspace` as its newest entry, at most `PROMPTED_LIMIT` long. */
export function remembered(list: readonly string[], workspace: string): string[] {
  return [...list.filter((each) => each !== workspace), workspace].slice(-PROMPTED_LIMIT);
}

function read(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((each) => typeof each === 'string') : [];
  } catch {
    return [];
  }
}

/** Whether `workspace` was offered the import already. */
export function wasPrompted(workspace: string): boolean {
  return read().includes(workspace);
}

/** Records that `workspace` was offered the import. */
export function markPrompted(workspace: string): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(remembered(read(), workspace)));
  } catch {
    // No storage (a private window): the offer may come once more.
  }
}
