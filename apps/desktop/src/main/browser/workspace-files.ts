// Workspace files in the built-in browser (B1.6): `piarc-browse://<token>/<path>`, where the
// token names one session and the path is relative to its files root. Bytes come from Core's
// project files (handle reads, ADR-0036); `file://` never loads in a guest. Paths with `..` or
// a segment starting with a dot (`.env`, `.git`, `.ssh`) are refused: a page, or the agent
// driving one, never reads them through the browser.
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import type { CustomScheme, Session } from 'electron';

import { projectChunk } from '../core/project-file-stream.js';
import type { CoreRuntime } from '../core/native/piarc-core.js';
import { WORKSPACE_SCHEME } from './request-rules.js';

export const BROWSE_SCHEME: CustomScheme = {
  scheme: WORKSPACE_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
};

/** The largest file the scheme serves. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
const CHUNK = 1024 * 1024;

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.xml': 'application/xml',
};

/** The content type a file is served with. */
export function contentType(relative: string): string {
  return TYPES[path.posix.extname(relative).toLowerCase()] ?? 'application/octet-stream';
}

/** The session-relative path of a request path, or `undefined` when it is refused. */
export function relativePath(urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined;
  const segments = decoded.split('/').filter((segment) => segment !== '');
  if (segments.some((segment) => segment === '..' || segment.startsWith('.'))) return undefined;
  const joined = segments.join('/');
  return urlPath.endsWith('/') || joined === '' ? path.posix.join(joined, 'index.html') : joined;
}

/**
 * The path of `typed` (absolute, `~/…`, `./…`) relative to `root`, or `undefined` when it is
 * outside `root`.
 */
export function insideRoot(typed: string, root: string, home: string): string | undefined {
  const expanded =
    typed === '~' ? home : typed.startsWith('~/') ? path.join(home, typed.slice(2)) : typed;
  const absolute = path.resolve(root, expanded);
  const relative = path.relative(root, absolute);
  if (relative === '') return '';
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join('/');
}

/** Serves the hosts of single files opened from outside the workspace (file-grants.ts). */
export interface GrantServer {
  /** The answer for a granted host, or undefined when `host` is not one. */
  serve(host: string, urlPath: string, method: string): Promise<Response | undefined>;
}

/** One token per session: the host of its workspace URLs. */
export class WorkspaceFiles {
  readonly #sessions = new Map<string, string>();
  readonly #tokens = new Map<string, string>();
  /** Single files opened from outside the workspace (B1.6.2, file-grants.ts). */
  #grants: GrantServer | undefined;
  #served: ((sessionId: string, relative: string) => void) | undefined;

  constructor(private readonly core: Pick<CoreRuntime, 'projectFiles'>) {}

  /** The browser URL of `relative` in `sessionId`'s files. */
  url(sessionId: string, relative: string): string {
    let token = this.#sessions.get(sessionId);
    if (token === undefined) {
      token = randomBytes(8).toString('hex');
      this.#sessions.set(sessionId, token);
      this.#tokens.set(token, sessionId);
    }
    const encoded = relative
      .split('/')
      .filter((segment) => segment !== '')
      .map(encodeURIComponent)
      .join('/');
    return `${WORKSPACE_SCHEME}://${token}/${encoded}`;
  }

  /** The session a workspace URL belongs to. */
  sessionOf(url: string): string | undefined {
    try {
      return this.#tokens.get(new URL(url).hostname);
    } catch {
      return undefined;
    }
  }

  /** Serves the hosts of `grants` too (B1.6.2). */
  /** Hears every workspace file served to a page (live reload, B1.6.1). */
  onServed(listener: (sessionId: string, relative: string) => void): void {
    this.#served = listener;
  }

  /** The absolute path of a session-relative file, through Core (for watching only). */
  async resolve(sessionId: string, relative: string): Promise<string | undefined> {
    const item: unknown = JSON.parse(
      await this.core.projectFiles(sessionId, JSON.stringify({ op: 'resolve', path: relative })),
    );
    return typeof item === 'object' &&
      item !== null &&
      'path' in item &&
      typeof item.path === 'string'
      ? item.path
      : undefined;
  }

  setGrants(grants: GrantServer): void {
    this.#grants = grants;
  }

  /** Serves the scheme in a guest partition. */
  register(session: Session): void {
    session.protocol.handle(WORKSPACE_SCHEME, (request) => this.#serve(request));
  }

  async #serve(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405 });
    }
    const url = new URL(request.url);
    const sessionId = this.#tokens.get(url.hostname);
    const relative = relativePath(url.pathname);
    if (sessionId === undefined) {
      const granted = await this.#grants?.serve(url.hostname, url.pathname, request.method);
      if (granted !== undefined) return granted;
    }
    if (sessionId === undefined || relative === undefined) {
      return new Response('Not available in the browser', { status: 403 });
    }
    try {
      const first = await projectChunk(this.core, sessionId, relative, 0, CHUNK);
      if (first.size > MAX_FILE_BYTES) return new Response('File too large', { status: 413 });
      const parts = [first.bytes];
      for (let offset = first.bytes.length; offset < first.size; offset += CHUNK) {
        const next = await projectChunk(
          this.core,
          sessionId,
          relative,
          offset,
          Math.min(CHUNK, first.size - offset),
          first.revision,
        );
        parts.push(next.bytes);
      }
      this.#served?.(sessionId, relative);
      const type = contentType(relative);
      const body = request.method === 'HEAD' ? null : Buffer.concat(parts);
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': type,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  }
}
