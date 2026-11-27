// Screenshots of tool results in the transcript (ADR-0093): Core keeps each image a tool
// returned (the `Browser` tool's) in the session's blobs, named by its SHA-256; a workbench
// page asks for a short-lived URL of one and shows it like any other preview image. Grants
// belong to the asking page and end with it; only PNG and JPEG bytes are served, recognised by
// their content, under the same sandboxed headers as the Markdown image previews.
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';

import type { WebContents } from 'electron';

import { IPC_CHANNELS, isSessionId } from '../../shared/ipc.js';
import type { RegisterHandler } from '../ipc/register.js';

const HOST = 'session-images';
/** The largest screenshot served (Core keeps none larger than 5 MiB of base64). */
const IMAGE_BYTES = 8 * 1024 * 1024;
/** What one page may hold at once. */
const POOL_BYTES = 64 * 1024 * 1024;
const POOL_COUNT = 128;

interface Shot {
  readonly owner: WebContents;
  readonly mime: 'image/png' | 'image/jpeg';
  readonly bytes: Buffer;
}

const shots = new Map<string, Shot>();
const watched = new WeakSet<WebContents>();

/** The image type of `bytes` by its signature, or undefined. */
export function imageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | undefined {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= png.length && png.every((b, i) => bytes[i] === b)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  return undefined;
}

/** Whether `blob` is a blob name: a lowercase SHA-256. */
export function isBlobName(blob: unknown): blob is string {
  return typeof blob === 'string' && /^[0-9a-f]{64}$/.test(blob);
}

function clear(owner: WebContents): void {
  for (const [url, shot] of shots) if (shot.owner === owner) shots.delete(url);
}

function watch(owner: WebContents): void {
  if (watched.has(owner)) return;
  watched.add(owner);
  const reset = () => {
    clear(owner);
  };
  owner.once('destroyed', reset);
  owner.on('render-process-gone', reset);
  owner.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) reset();
  });
}

async function readBlob(file: string): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 1 || size > IMAGE_BYTES) throw new Error('Invalid image size');
    const bytes = Buffer.alloc(size);
    await handle.read(bytes, 0, size, 0);
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Serves a granted screenshot; undefined for requests of other previews. */
export function sessionImageResponse(req: Request): Response | undefined {
  if (new URL(req.url).hostname !== HOST) return undefined;
  const shot = shots.get(req.url);
  if (shot === undefined || !['GET', 'HEAD'].includes(req.method)) {
    return new Response(null, { status: 404 });
  }
  return new Response(req.method === 'HEAD' ? null : new Uint8Array(shot.bytes), {
    headers: {
      'Content-Type': shot.mime,
      'Content-Security-Policy':
        "sandbox; default-src 'none'; frame-ancestors 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

/**
 * `sessionImage(sessionId, blob)` answers a URL of the session's blob for the asking page;
 * `sessionImage(sessionId, blob, url)` releases that URL. `dataDir` is Core's data directory.
 */
export function registerSessionImageHandlers(register: RegisterHandler, dataDir: string): void {
  register(IPC_CHANNELS.sessionImage, async ({ sender, senderFrame }, [id, blob, release]) => {
    if (senderFrame !== sender.mainFrame || !isSessionId(id) || !isBlobName(blob)) {
      throw new TypeError('Invalid session image');
    }
    if (release !== undefined) {
      if (typeof release !== 'string') throw new TypeError('Invalid session image');
      if (shots.get(release)?.owner === sender) shots.delete(release);
      return '';
    }
    const bytes = await readBlob(path.join(dataDir, 'sessions', id, 'blobs', blob));
    const mime = imageType(bytes);
    if (mime === undefined) throw new Error('Not an image');
    watch(sender);
    let held = bytes.byteLength;
    let count = 0;
    for (const shot of shots.values()) {
      if (shot.owner !== sender) continue;
      held += shot.bytes.byteLength;
      count += 1;
    }
    if (held > POOL_BYTES || count >= POOL_COUNT) throw new Error('Too many active image previews');
    const url = `piarc-document://${HOST}/${randomUUID()}`;
    shots.set(url, { owner: sender, mime, bytes });
    return url;
  });
}
