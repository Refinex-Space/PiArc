// Content Security Policy sent by the main process as a response header on every page and
// asset of the app scheme (architecture section 10.3).

/**
 * The production policy. `'self'` is the app-scheme origin, so scripts, styles, fonts and
 * network requests can only come from the app bundle. ADR-0076 grants passive media and
 * framed documents a separate short-lived project origin.
 * There is no `'unsafe-inline'` or `'unsafe-eval'`. Do not relax this policy: the only
 * permitted relaxation is the development-server policy in `src/main/dev-server.ts`.
 */
export const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: piarc-document:",
  'media-src piarc-document:',
  'frame-src piarc-document:',
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Headers added to every app-scheme response. */
export function securityHeaders(csp: string): Record<string, string> {
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
  };
}
