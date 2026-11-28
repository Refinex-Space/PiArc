// Serves the renderer bundle on the app origin. Both transports use the same path checks,
// method policy, content types and CSP (architecture section 10.3, ADR-0072).
import { readFile } from 'node:fs/promises';

import { protocol, type CustomScheme } from 'electron';

import { APP_SCHEME } from './app-scheme.js';
import { contentTypeFor, resolveAssetPath } from './asset-path.js';
import { securityHeaders } from './security/csp.js';

/** Registration passed to Electron before ready. No CSP bypass or service workers. */
export const APP_SCHEME_REGISTRATION: CustomScheme = {
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true },
};

interface Asset {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer | null;
}

/** Reads only files the renderer is allowed to request. Errors keep the security headers. */
async function readAsset(root: string, csp: string, method: string, url: string): Promise<Asset> {
  const headers = securityHeaders(csp);
  if (method !== 'GET' && method !== 'HEAD') return { status: 405, headers, body: null };
  const file = resolveAssetPath(root, url);
  if (file === null) return { status: 404, headers, body: null };
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    return { status: 404, headers, body: null };
  }
  return {
    status: 200,
    headers: { ...headers, 'Content-Type': contentTypeFor(file) },
    body: method === 'HEAD' ? null : bytes,
  };
}

/** Serves files under `rootDir` for the app scheme on the default session. */
export function registerAppProtocol(rootDir: string, csp: string): void {
  if (process.platform === 'darwin') {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- ADR-0072: Electron 45's native buffer transport avoids the Fetch adapter's resident cost on macOS. Review on Electron upgrades.
    const registered = protocol.registerBufferProtocol(APP_SCHEME, (request, reply) => {
      void readAsset(rootDir, csp, request.method, request.url).then(
        ({ status, headers, body }) => {
          reply({ statusCode: status, headers, data: body ?? Buffer.alloc(0) });
        },
        (error: unknown) => {
          console.error('[app] could not serve an app resource', error);
          reply({ statusCode: 500, headers: securityHeaders(csp), data: Buffer.alloc(0) });
        },
      );
    });
    if (!registered) throw new Error('Could not register the app asset protocol');
    return;
  }
  protocol.handle(APP_SCHEME, async (request) => {
    const { status, headers, body } = await readAsset(rootDir, csp, request.method, request.url);
    return new Response(body === null ? null : new Uint8Array(body), { status, headers });
  });
}
