// The script host's partition (ADR-0089 rule 3, design addendum B2.2.1): it serves the host
// page on its own scheme and nothing else. Every other request is cancelled (fetch, images,
// WebSockets, imports from elsewhere), WebRTC has no UDP and no proxy to tunnel through, and
// every permission, download and device request is refused. The page's CSP allows scripts
// from the host scheme only, with `unsafe-eval` for compiling the model's script, and no
// connections.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Session } from 'electron';

import { contentTypeFor } from '../asset-path.js';
import { securityHeaders } from '../security/csp.js';
import { HOST_SCHEME } from './script-host.js';

export const HOST_ORIGIN = `${HOST_SCHEME}://host`;
export const HOST_PAGE = `${HOST_ORIGIN}/index.html`;

export const HOST_CSP = [
  "default-src 'none'",
  `script-src ${HOST_SCHEME}: 'unsafe-eval'`,
  "connect-src 'none'",
  "img-src 'none'",
  "style-src 'none'",
  "font-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** The file under `root` that a host URL names, or null. */
export function hostFile(root: string, url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${HOST_SCHEME}:` || parsed.host !== 'host') return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  const base = path.resolve(root);
  const file = path.join(base, pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
  const relative = path.relative(base, file);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return file;
}

/**
 * Sets up the host partition. `root` is the built host page's folder; `devOrigin` the dev
 * server's origin when PiArc runs from `electron-forge start` (then the page comes from it).
 */
export function setUpHostSession(
  session: Session,
  root: string,
  devOrigin: string | undefined,
): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
  session.on('will-download', (event) => {
    event.preventDefault();
  });
  if (devOrigin === undefined) {
    // No route out even for traffic the request filter does not see.
    void session.setProxy({ proxyRules: 'http://127.0.0.1:9', proxyBypassRules: '' });
  }
  session.webRequest.onBeforeRequest((details, callback) => {
    const allowed =
      details.url.startsWith(`${HOST_ORIGIN}/`) ||
      (devOrigin !== undefined && details.url.startsWith(`${devOrigin}/`)) ||
      details.url.startsWith('devtools://');
    callback({ cancel: !allowed });
  });
  session.protocol.handle(HOST_SCHEME, async (request) => {
    const headers = securityHeaders(HOST_CSP);
    if (request.method !== 'GET') return new Response(null, { status: 405, headers });
    const file = hostFile(root, request.url);
    if (file === null) return new Response(null, { status: 404, headers });
    try {
      const bytes = await readFile(file);
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { ...headers, 'Content-Type': contentTypeFor(file) },
      });
    } catch {
      return new Response(null, { status: 404, headers });
    }
  });
}
