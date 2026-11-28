// A preview URL grants access only to a short-lived document owned by a workbench. This
// scheme is never a trusted IPC origin and is never accepted for top-level navigation.
import { Readable } from 'node:stream';
import { projectChunk, readProjectRange } from './project-file-stream.js';
import { DIAGRAM_PAGE } from './markdown-diagram.js';
import { markdownImageResponse } from './markdown-images.js';
import { sessionImageResponse } from './session-images.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { protocol, type WebContents, type CustomScheme } from 'electron';
import { APP_EVENT_CHANNEL, IPC_CHANNELS, isSessionId, type AppEvent } from '../../shared/ipc.js';
import { isProjectPath, projectRecord } from '../../shared/project-files.js';
import type { RegisterHandler } from '../ipc/register.js';
import type { CoreRuntime } from './native/piarc-core.js';
import type { TerminalOwners } from './terminal-ipc.js';

const scheme = 'piarc-document';
export const DOCUMENT_SCHEME: CustomScheme = {
  scheme,
  privileges: { standard: true, secure: true, stream: true },
};
const types: Readonly<Record<string, string>> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.pdf': 'application/pdf',
};
interface Grant {
  owner: WebContents;
  id: string;
  file: string;
  mode: 'interactive' | 'static' | 'media';
  token: string;
  revision?: string;
}
const mime = (file: string) => types[path.posix.extname(file).toLowerCase()];
export class ProjectPreviews {
  private grants = new Map<string, Grant>();
  private watched = new WeakSet<WebContents>();
  constructor(
    private readonly core: Pick<
      CoreRuntime,
      'projectFiles' | 'projectTrust' | 'sessionDeletionTarget'
    >,
    private readonly diagram?: (req: Request) => Promise<Response>,
  ) {}
  private entry(url: string) {
    try {
      const u = new URL(url);
      if (u.protocol !== scheme + ':' || u.username || u.password || u.port) return undefined;
      const file = decodeURIComponent(u.pathname.slice(1));
      const grant = this.grants.get(u.hostname);
      return grant && isProjectPath(file) ? { file, grant } : undefined;
    } catch {
      return undefined;
    }
  }
  allowsFrame(owner: WebContents, url: string, parent?: string, initiator?: string) {
    if (url === DIAGRAM_PAGE) return true;
    // Chromium's built-in PDF viewer creates a child for its own PDF stream. Electron
    // reports both initiator and parent as the built-in viewer, not the workbench.
    const viewer = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/';
    if (
      parent === viewer + 'index.html' &&
      initiator === parent &&
      url.startsWith(viewer) &&
      /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(url.slice(viewer.length))
    ) {
      return [...this.grants.values()].some(
        (g) => g.owner === owner && g.mode === 'media' && mime(g.file) === 'application/pdf',
      );
    }
    const entry = this.entry(url);
    return !!entry && entry.file === entry.grant.file && entry.grant.owner === owner;
  }
  followLink(
    sender: WebContents,
    owner: WebContents,
    initiator: string | undefined,
    target: string,
  ) {
    const source = initiator ? this.entry(initiator) : undefined;
    if (
      !source ||
      source.grant.mode === 'media' ||
      source.file !== source.grant.file ||
      source.grant.owner !== owner ||
      !this.input?.hasRecentInput(sender.id)
    )
      return;
    const local = this.entry(target);
    let event: AppEvent;
    if (local?.grant === source.grant)
      event = { type: 'projectFileLink', sessionId: source.grant.id, path: local.file };
    else if (/^https?:\/\//iu.test(target))
      event = { type: 'projectWebLink', sessionId: source.grant.id, url: target };
    else return;
    if (!owner.isDestroyed()) owner.send(APP_EVENT_CHANNEL, event);
  }
  private input?: Pick<TerminalOwners, 'hasRecentInput'>;
  register(
    register: RegisterHandler,
    input: Pick<TerminalOwners, 'requireInput' | 'hasRecentInput'>,
  ) {
    this.input = input;
    register(
      IPC_CHANNELS.projectFilePreview,
      async ({ sender, senderFrame }, [id, file, mode, token]) => {
        if (senderFrame !== sender.mainFrame || !isSessionId(id) || !isProjectPath(file))
          throw new TypeError('Invalid project preview');
        if (mode === 'release') {
          const g = typeof token === 'string' ? this.entry(token)?.grant : undefined;
          if (g?.owner === sender && g.id === id && g.file === file) this.grants.delete(g.token);
          return '';
        }
        if (mode !== 'interactive' && mode !== 'static' && mode !== 'media')
          throw new TypeError('Invalid preview mode');
        const kind = mime(file);
        if (
          !kind ||
          (mode === 'media'
            ? !/^(?:image\/|audio\/|video\/|application\/pdf$)/u.test(kind)
            : kind !== 'text/html')
        )
          throw new TypeError('Not a previewable document');
        if (mode === 'interactive') {
          input.requireInput(sender, id, 'files');
          const meta: unknown = JSON.parse(await this.core.sessionDeletionTarget(id));
          const trust: unknown =
            projectRecord(meta) && typeof meta.workspace === 'string'
              ? JSON.parse(await this.core.projectTrust(meta.workspace))
              : null;
          if (!projectRecord(trust) || trust.trusted !== true)
            throw new Error('Interactive preview requires a trusted project');
        }
        if (sender.isDestroyed() || sender.mainFrame !== senderFrame)
          throw new Error('Preview owner changed');
        if (!this.watched.has(sender)) {
          this.watched.add(sender);
          const clear = () => {
            for (const [key, g] of this.grants) if (g.owner === sender) this.grants.delete(key);
          };
          sender.once('destroyed', clear);
          sender.on('render-process-gone', clear);
          sender.on('did-start-navigation', (e) => {
            if (e.isMainFrame && !e.isSameDocument) clear();
          });
        }
        if ([...this.grants.values()].filter((g) => g.owner === sender).length >= 32)
          throw new Error('Too many active project previews');
        const key = randomUUID();
        this.grants.set(key, { id, file, mode, owner: sender, token: key });
        return scheme + '://' + key + '/' + file.split('/').map(encodeURIComponent).join('/');
      },
    );
    protocol.handle(scheme, (req) => this.serve(req));
  }
  async serve(req: Request): Promise<Response> {
    if (new URL(req.url).host === 'markdown-diagram' && this.diagram) return this.diagram(req);
    const picture = markdownImageResponse(req) ?? sessionImageResponse(req);
    if (picture) return picture;
    const entry = this.entry(req.url);
    if (!entry || !['HEAD', 'GET'].includes(req.method)) return new Response(null, { status: 404 });
    const { file, grant } = entry;
    const type = mime(file);
    // Documents and scripts from siblings cannot become nested browsing contexts. Static
    // previews need only styles and passive assets. Files always pass through Core's scope.
    if (
      !type ||
      (file !== grant.file &&
        (grant.mode === 'media' ||
          type === 'text/html' ||
          type === 'application/pdf' ||
          (type === 'application/javascript' && grant.mode !== 'interactive')))
    )
      return new Response(null, { status: 404 });
    const origin = scheme + '://' + grant.token;
    const scripts = grant.mode === 'interactive' ? "'unsafe-inline' " + origin : "'none'";
    const csp = [
      "default-src 'none'",
      'script-src ' + scripts,
      "style-src 'unsafe-inline' " + origin,
      'img-src ' + origin + ' data:',
      'media-src ' + origin,
      'font-src ' + origin + ' data:',
      "connect-src 'none'",
      "worker-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-src 'none'",
      "form-action 'none'",
      "webrtc 'block'",
      ...(type === 'text/html' || type === 'image/svg+xml'
        ? [
            'sandbox' +
              (grant.mode === 'interactive' && type === 'text/html' ? ' allow-scripts' : ''),
          ]
        : []),
    ].join('; ');
    const headers = new Headers({
      'Content-Type': type,
      'Content-Security-Policy': csp,
      'Referrer-Policy': 'no-referrer',
      'X-DNS-Prefetch-Control': 'off',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(type === 'application/javascript' || type.startsWith('font/')
        ? { 'Access-Control-Allow-Origin': 'null' }
        : {}),
      'Permissions-Policy':
        'camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=()',
    });
    try {
      const meta = await projectChunk(
        this.core,
        grant.id,
        file,
        0,
        0,
        grant.mode === 'media' ? grant.revision : undefined,
      );
      if (
        this.grants.get(grant.token) !== grant ||
        (grant.mode !== 'media' && meta.size > 32 * 1024 * 1024)
      )
        return new Response(null, { status: 404, headers });
      if (grant.mode === 'media') grant.revision = meta.revision;
      const n = meta.size;
      let start = 0,
        end = n - 1,
        status = 200;
      const range = req.headers.get('Range');
      if (range && grant.mode === 'media') {
        const m = /^bytes=(\d*)-(\d*)$/u.exec(range);
        if (!m || (!m[1] && !m[2])) return new Response(null, { status: 416 });
        if (m[1]) {
          start = Number(m[1]);
          if (m[2]) end = Math.min(end, Number(m[2]));
        } else start = Math.max(0, n - Number(m[2]));
        if (start > end || start >= n)
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': 'bytes */' + String(n) },
          });
        status = 206;
        headers.set(
          'Content-Range',
          'bytes ' + String(start) + '-' + String(end) + '/' + String(n),
        );
      }
      headers.set('Content-Length', String(Math.max(0, end - start + 1)));
      headers.set('Accept-Ranges', 'bytes');
      if (req.method === 'HEAD') return new Response(null, { status, headers });
      const readable = Readable.from(
        readProjectRange(
          this.core,
          grant.id,
          file,
          meta.revision,
          start,
          end,
          () => !req.signal.aborted && this.grants.get(grant.token) === grant,
        ),
      );
      return new Response(Readable.toWeb(readable) as ReadableStream<Uint8Array>, {
        status,
        headers,
      });
    } catch {
      return new Response(null, { status: 404, headers });
    }
  }
}
