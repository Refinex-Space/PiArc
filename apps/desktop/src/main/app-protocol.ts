// Serves the renderer bundle over the app scheme with `protocol.handle` (Electron security
// checklist item 18): no `file://` pages, and every response carries the CSP header.
import { readFile } from 'node:fs/promises';

import { protocol, type CustomScheme } from 'electron';

import { APP_SCHEME } from './app-scheme.js';
import { contentTypeFor, resolveAssetPath } from './asset-path.js';
import { securityHeaders } from './security/csp.js';

/**
 * Registration passed to `protocol.registerSchemesAsPrivileged` before `ready`. `standard`
 * gives the scheme a real origin, `secure` makes it a secure context, `supportFetchAPI` lets
 * the page `fetch` its own assets. CSP is not bypassed and service workers are not allowed.
 */
export const APP_SCHEME_REGISTRATION: CustomScheme = {
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true },
};

/** Serves files under `rootDir` for the app scheme on the default session. */
export function registerAppProtocol(rootDir: string, csp: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const headers = securityHeaders(csp);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers });
    }
    const filePath = resolveAssetPath(rootDir, request.url);
    if (filePath === null) {
      return new Response(null, { status: 404, headers });
    }
    let body: Buffer;
    try {
      body = await readFile(filePath);
    } catch {
      return new Response(null, { status: 404, headers });
    }
    return new Response(request.method === 'HEAD' ? null : new Uint8Array(body), {
      status: 200,
      headers: { ...headers, 'Content-Type': contentTypeFor(filePath) },
    });
  });
}
