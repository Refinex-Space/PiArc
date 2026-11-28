// A single HTML file from outside the workspace (design addendum B1.6.2). The user picks it in
// the native open dialog ("Open HTML file…"); the tab it opens in may load that file's
// directory, and nothing else, under its own `piarc-browse://<token>/` host until the tab
// closes. `file://` never loads in a guest. Requests are checked the way workspace files are
// (no `..`, no segment starting with a dot) and, once links are resolved, must stay inside the
// granted directory.

import { randomBytes } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { WORKSPACE_SCHEME } from './request-rules.js';
import { contentType, MAX_FILE_BYTES, relativePath } from './workspace-files.js';

interface Grant {
  readonly token: string;
  /** The real path of the granted directory. */
  readonly root: string;
}

/** Whether `file` (a real path) is `root` itself or inside it. */
export function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * The real path of `relative` under `root` (a real path), or undefined when it leaves `root`
 * once links are resolved, or does not exist.
 */
export async function containedFile(root: string, relative: string): Promise<string | undefined> {
  const joined = path.join(root, ...relative.split('/'));
  let real: string;
  try {
    real = await realpath(joined);
  } catch {
    return undefined;
  }
  return within(root, real) ? real : undefined;
}

export class FileGrants {
  /** By tab id. */
  readonly #byTab = new Map<string, Grant>();
  readonly #byToken = new Map<string, Grant>();

  /** Lets tab `tab` load `file`'s directory; answers the file's address. */
  async grant(tab: string, file: string): Promise<string> {
    const real = await realpath(file);
    const root = path.dirname(real);
    this.revoke(tab);
    const grant = { token: randomBytes(16).toString('hex'), root };
    this.#byTab.set(tab, grant);
    this.#byToken.set(grant.token, grant);
    return `${WORKSPACE_SCHEME}://${grant.token}/${encodeURIComponent(path.basename(real))}`;
  }

  /** Tab `tab` closed: its directory is no longer served. */
  revoke(tab: string): void {
    const grant = this.#byTab.get(tab);
    if (grant === undefined) return;
    this.#byTab.delete(tab);
    this.#byToken.delete(grant.token);
  }

  /** Whether `host` is a granted directory's. */
  owns(host: string): boolean {
    return this.#byToken.has(host);
  }

  /** Answers a request of a granted host, or undefined when `host` is not one. */
  async serve(host: string, urlPath: string, method: string): Promise<Response | undefined> {
    const grant = this.#byToken.get(host);
    if (grant === undefined) return undefined;
    const relative = relativePath(urlPath);
    if (relative === undefined)
      return new Response('Not available in the browser', { status: 403 });
    const file = await containedFile(grant.root, relative);
    if (file === undefined) return new Response('Not found', { status: 404 });
    try {
      const info = await stat(file);
      if (!info.isFile()) return new Response('Not found', { status: 404 });
      if (info.size > MAX_FILE_BYTES) return new Response('File too large', { status: 413 });
      const body = method === 'HEAD' ? null : await readFile(file);
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': contentType(relative),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  }
}
