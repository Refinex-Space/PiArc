// Development-server mode (`electron-forge start`): the renderer comes from the Vite dev
// server instead of the app scheme. Every relaxation that mode needs is defined in this file
// and listed in docs/spikes/S10-electron-security.md. main.ts only calls into it behind
// `import.meta.env.DEV`, so packaged builds do not contain it, and the L4 security tests
// always run against the production renderer bundle.
import type { Session } from 'electron';

/** The dev server the renderer is loaded from. */
export interface DevServer {
  readonly url: string;
  readonly origin: string;
}

/** Parses Forge's dev-server URL define; `undefined` outside `electron-forge start`. */
export function resolveDevServer(url: string | undefined): DevServer | undefined {
  if (url === undefined || url === '') {
    return undefined;
  }
  return { url, origin: new URL(url).origin };
}

/**
 * The CSP for dev-server pages. Relaxations compared with `PRODUCTION_CSP`:
 * - `script-src 'unsafe-inline'`: the React Refresh preamble is an inline script;
 * - `style-src 'unsafe-inline'`: Vite injects CSS as `<style>` elements;
 * - `connect-src ws://<dev host>`: the HMR WebSocket.
 */
export function devServerCsp(server: DevServer): string {
  const { host } = new URL(server.origin);
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ws://${host}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Sends `devServerCsp` with every dev-server response. The dev server origin is also trusted
 * by the navigation guard and the IPC sender check (see `trustedOrigins` in main.ts).
 */
export function applyDevServerCsp(session: Session, server: DevServer): void {
  const csp = devServerCsp(server);
  session.webRequest.onHeadersReceived({ urls: [`${server.origin}/*`] }, (details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
  });
}
