// Request rules every browser guest gets, before the agent's gate (B1.7.3, B2.6.1): the schemes
// a page may load, the link-local literals that would bypass the proxy, and PiArc's own
// loopback ports. Pure, so the table is tested without Electron.

/** Schemes a guest may request at all; `piarc-browse` is the workspace file scheme. */
const SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:', 'data:', 'blob:', 'about:']);

/** The workspace file scheme (B1.6). */
export const WORKSPACE_SCHEME = 'piarc-browse';

/**
 * Whether a response is the browser proxy's `502` for a target that refused the connection
 * (Core's `x-piarc-proxy-error: connection-refused`): a local server that is not up yet, which
 * the tab waits for as Chromium's `ERR_CONNECTION_REFUSED` without a proxy (B1.3.1).
 */
export function proxyRefused(
  statusCode: number,
  headers: Record<string, string[]> | undefined,
): boolean {
  if (statusCode !== 502 || headers === undefined) return false;
  return Object.entries(headers).some(
    ([name, values]) =>
      name.toLowerCase() === 'x-piarc-proxy-error' && values.includes('connection-refused'),
  );
}

/** Cloud metadata literals outside link-local: they go through the proxy, which refuses them. */
const LINK_LOCAL_V4 = /^169\.254\.\d{1,3}\.\d{1,3}$/;

export type RequestVerdict =
  | { readonly allow: true }
  | {
      readonly allow: false;
      readonly reason: 'scheme' | 'linkLocal' | 'piarcPort' | 'invalid';
    };

/** Whether a guest may make the request to `url`; `deniedPorts` are PiArc's loopback ports. */
export function requestVerdict(url: string, deniedPorts: ReadonlySet<number>): RequestVerdict {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allow: false, reason: 'invalid' };
  }
  const scheme = parsed.protocol;
  if (scheme === `${WORKSPACE_SCHEME}:`) return { allow: true };
  if (!SCHEMES.has(scheme)) return { allow: false, reason: 'scheme' };
  if (scheme === 'data:' || scheme === 'blob:' || scheme === 'about:') return { allow: true };
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  // Chromium sends link-local literals directly, past any proxy (its implicit bypass rules).
  if (LINK_LOCAL_V4.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) {
    return { allow: false, reason: 'linkLocal' };
  }
  if (loopbackHost(host) && deniedPorts.has(portOf(parsed))) {
    return { allow: false, reason: 'piarcPort' };
  }
  return { allow: true };
}

/** Whether `host` (without brackets) is this machine by name or literal. */
export function loopbackHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    name === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name) ||
    name.startsWith('::ffff:127.')
  );
}

/** The port of `url`, the scheme's default when it has none. */
export function portOf(url: URL): number {
  if (url.port !== '') return Number(url.port);
  return url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80;
}

/** Schemes a guest's main frame may navigate to (the rest is refused in `will-navigate`). */
export function navigable(url: string): boolean {
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    return false;
  }
  return (
    scheme === 'http:' ||
    scheme === 'https:' ||
    scheme === 'blob:' ||
    scheme === 'about:' ||
    scheme === `${WORKSPACE_SCHEME}:`
  );
}
