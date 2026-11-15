// Maps app-scheme request URLs to files in the renderer bundle. Pure functions so the
// path-traversal rules can be unit tested without Electron.
import path from 'node:path';

import { APP_HOST, APP_SCHEME } from './app-scheme.js';

/**
 * Resolves `requestUrl` to a file inside `rootDir`, or returns `null` when the URL does not
 * belong to the app scheme and host, cannot be decoded, or points outside `rootDir`.
 * `/` maps to `index.html`.
 */
export function resolveAssetPath(rootDir: string, requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) {
    return null;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) {
    return null;
  }
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const root = path.resolve(rootDir);
  const resolved = path.join(root, relativePath);
  const fromRoot = path.relative(root, resolved);
  if (fromRoot === '' || fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) {
    return null;
  }
  return resolved;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** Content type sent for a bundle file; unknown extensions are served as opaque bytes. */
export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}
