// The OS picker owns access to each external source. Core checks the content, directory
// identities and project permissions, and publishes complete local images atomically.
import path from 'node:path';
import { allowPickedInsertion } from './markdown-image-save.js';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { BrowserWindow, dialog, type WebContents } from 'electron';
import { IPC_CHANNELS, isSessionId } from '../../shared/ipc.js';
import { isProjectPath, projectRecord } from '../../shared/project-files.js';
import {
  IMAGE_LIMIT,
  imageRef,
  type ImagePlacement,
  IMAGE_BATCH_LIMIT,
  IMAGE_COUNT_LIMIT,
  locations,
  validImageFolder,
} from '../../shared/markdown-images.js';
import type { CoreRuntime } from './native/piarc-core.js';
import type { RegisterHandler } from '../ipc/register.js';
import type { TerminalOwners } from './terminal-ipc.js';
import type { Translator } from '../../shared/i18n/index.js';

function validPlacement(value: unknown): value is ImagePlacement {
  return (
    projectRecord(value) &&
    typeof value.text === 'string' &&
    value.text.length <= 1024 * 1024 &&
    typeof value.from === 'number' &&
    Number.isInteger(value.from) &&
    typeof value.to === 'number' &&
    Number.isInteger(value.to) &&
    value.from >= 0 &&
    value.from <= value.to &&
    value.to <= value.text.length &&
    (value.eol === '\n' || value.eol === '\r' || value.eol === '\r\n')
  );
}
interface Asset {
  id: string;
  owner: WebContents;
  document: string;
  mime: string;
  external: boolean;
  bytes: Buffer;
}
const images = new Map<string, Asset>();
const owners = new WeakSet<WebContents>();
let directoryGeneration = 0;
const poolLimit = 64 * 1024 * 1024;
function clear(owner: WebContents) {
  for (const [token, item] of images) if (item.owner === owner) images.delete(token);
}
function retain(owner: WebContents, id: string, document: string, raw: unknown) {
  if (
    !projectRecord(raw) ||
    typeof raw.base64 !== 'string' ||
    typeof raw.mime !== 'string' ||
    !/^image\/(?:png|jpeg|svg\+xml|webp|gif|bmp)$/u.test(raw.mime) ||
    raw.base64.length > Math.ceil(IMAGE_LIMIT / 3) * 4
  )
    throw new Error('Invalid image response');
  const data = Buffer.from(raw.base64, 'base64');
  if (data.byteLength < 1 || data.byteLength > IMAGE_LIMIT) throw new Error('Invalid image size');
  if (!owners.has(owner)) {
    owners.add(owner);
    const reset = () => {
      clear(owner);
    };
    owner.once('destroyed', reset);
    owner.on('render-process-gone', reset);
    owner.on('did-start-navigation', (e) => {
      if (e.isMainFrame && !e.isSameDocument) reset();
    });
  }
  let size = data.byteLength;
  for (const item of images.values()) if (item.owner === owner) size += item.bytes.byteLength;
  if (size > poolLimit || images.size >= 256) throw new Error('Too many active image previews');
  const url = 'piarc-document://markdown-images/' + randomUUID();
  images.set(url, {
    owner,
    id,
    document,
    mime: raw.mime,
    external: raw.external === true,
    bytes: data,
  });
  return url;
}
/** Only granted images are served. This host is never a workbench or iframe origin. */
export function markdownImageResponse(req: Request): Response | undefined {
  if (new URL(req.url).hostname !== 'markdown-images') return undefined;
  const entry = images.get(req.url);
  if (!entry || !['GET', 'HEAD'].includes(req.method)) return new Response(null, { status: 404 });
  return new Response(req.method === 'HEAD' ? null : new Uint8Array(entry.bytes), {
    headers: {
      'Content-Type': entry.mime,
      'Content-Security-Policy':
        "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
export function registerMarkdownImageHandlers(
  register: RegisterHandler,
  core: Pick<CoreRuntime, 'projectFiles' | 'markdownImageSettings'>,
  input: Pick<TerminalOwners, 'requireInput' | 'page'>,
  translate: () => Translator,
) {
  const changeDirectory = async (request: string) => {
    const settings = await core.markdownImageSettings(request);
    directoryGeneration++;
    for (const [url, asset] of images) if (asset.external) images.delete(url);
    return settings;
  };
  register(IPC_CHANNELS.markdownImageSettings, async ({ sender, senderFrame }, [req]) => {
    if (sender.mainFrame !== senderFrame || !projectRecord(req))
      throw new TypeError('Invalid image settings');
    if (req.op === 'read') return core.markdownImageSettings('{"op":"read"}');
    input.requireInput(sender);
    if (req.op === 'forget') return changeDirectory('{"op":"forget"}');
    if (req.op === 'choose') {
      const opts: Electron.OpenDialogOptions = {
        properties: ['openDirectory', 'createDirectory'],
        title: translate().t('files.images.chooseFolder'),
      };
      const win = BrowserWindow.fromWebContents(sender);
      const result = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
      const folder = result.filePaths[0];
      return result.canceled || !folder
        ? core.markdownImageSettings('{"op":"read"}')
        : changeDirectory(JSON.stringify({ op: 'grant', path: folder }));
    }
    if (
      req.op !== 'set' ||
      !locations.some((v) => v === req.mode) ||
      typeof req.folder !== 'string' ||
      req.folder.length > 240 ||
      ((req.mode === 'relative' || req.folder !== '') && !validImageFolder(req.folder)) ||
      !['relativeDot', 'relative', 'absolute'].some((v) => v === req.link)
    )
      throw new TypeError('Invalid image settings');
    return core.markdownImageSettings(
      JSON.stringify({ op: 'set', mode: req.mode, folder: req.folder, link: req.link }),
    );
  });
  register(IPC_CHANNELS.markdownImage, async ({ sender, senderFrame }, [id, document, req]) => {
    if (
      sender.mainFrame !== senderFrame ||
      !isSessionId(id) ||
      !isProjectPath(document) ||
      !projectRecord(req)
    )
      throw new TypeError('Invalid image request');
    if (req.op === 'release') {
      const value = typeof req.url === 'string' ? images.get(req.url) : undefined;
      if (value?.owner === sender && value.id === id && value.document === document)
        images.delete(String(req.url));
      return '';
    }
    if (req.op === 'preview') {
      if (typeof req.reference !== 'string' || req.reference.length > 8192)
        throw new TypeError('Invalid image reference');
      const generation = directoryGeneration;
      const raw: unknown = JSON.parse(
        await core.projectFiles(
          id,
          JSON.stringify({ op: 'imagePreview', path: document, reference: req.reference }),
        ),
      );
      if (
        sender.isDestroyed() ||
        senderFrame !== sender.mainFrame ||
        (generation !== directoryGeneration && projectRecord(raw) && raw.external === true)
      )
        throw new Error('Image owner changed');
      return retain(sender, id, document, raw);
    }
    input.requireInput(sender, id, 'files');
    const publish = async (
      files: readonly { name: string; bytes: Uint8Array; source?: string | undefined }[],
    ) => {
      const imported: unknown[] = [];
      for (const file of files) {
        if (sender.isDestroyed() || senderFrame !== sender.mainFrame)
          throw new Error('Image owner changed');
        try {
          const result: unknown = JSON.parse(
            await core.projectFiles(
              id,
              JSON.stringify({
                op: 'imageImport',
                path: document,
                name: file.name,
                bytes: Buffer.from(file.bytes).toString('base64'),
                source: file.source,
              }),
            ),
          );
          imported.push(result);
        } catch (e) {
          imported.push({ name: file.name, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return JSON.stringify(imported);
    };
    if (req.op === 'import') {
      if (!Array.isArray(req.files) || !req.files.length || req.files.length > IMAGE_COUNT_LIMIT)
        throw new TypeError('Invalid image count');
      let total = 0;
      const files = req.files.map((entry: unknown) => {
        if (
          !projectRecord(entry) ||
          typeof entry.name !== 'string' ||
          entry.name.length > 512 ||
          !(entry.bytes instanceof Uint8Array) ||
          !entry.bytes.byteLength ||
          entry.bytes.byteLength > IMAGE_LIMIT ||
          (entry.source !== undefined &&
            (typeof entry.source !== 'string' ||
              !path.isAbsolute(entry.source) ||
              entry.source.length > 4096))
        )
          throw new TypeError('Invalid image import');
        total += entry.bytes.byteLength;
        return { name: entry.name, bytes: entry.bytes, source: entry.source };
      });
      if (total > IMAGE_BATCH_LIMIT) throw new TypeError('Image batch exceeds import limit');
      return publish(files);
    }
    if (req.op !== 'pick') throw new TypeError('Invalid image import');
    const placement = req.placement;
    if (!validPlacement(placement)) throw new TypeError('Invalid image insertion range');
    const originalPage = input.page(sender);
    const snapshot = async () => {
      const value: unknown = JSON.parse(
        await core.projectFiles(id, JSON.stringify({ op: 'read', path: document })),
      );
      return projectRecord(value) &&
        value.kind === 'text' &&
        value.editable === true &&
        typeof value.revision === 'string' &&
        typeof value.text === 'string'
        ? { revision: value.revision, text: value.text }
        : undefined;
    };
    const opts: Electron.OpenDialogOptions = {
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: translate().t('files.images.label'),
          extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'],
        },
      ],
    };
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.fromWebContents(sender);
    const picked = await (parent
      ? dialog.showOpenDialog(parent, opts)
      : dialog.showOpenDialog(opts));
    if (picked.canceled) return '[]';
    if (sender.isDestroyed() || originalPage !== input.page(sender))
      throw new Error('Image owner changed');
    if (picked.filePaths.length > IMAGE_COUNT_LIMIT) throw new Error('Too many images');
    const files: { file: string; bytes: Buffer }[] = [];
    let size = 0;
    for (const file of picked.filePaths) {
      const handle = await open(
        file,
        process.platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NONBLOCK,
      );
      try {
        const stat = await handle.stat();
        size += stat.size;
        if (!stat.isFile() || stat.size < 1 || stat.size > IMAGE_LIMIT || size > IMAGE_BATCH_LIMIT)
          throw new Error('Invalid image size');
        const bytes = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) throw new Error('Image changed during import');
          offset += bytesRead;
        }
        if ((await handle.stat()).size !== bytes.length)
          throw new Error('Image changed during import');
        files.push({ file, bytes });
      } finally {
        await handle.close();
      }
    }
    const results = await publish(
      files.map(({ file, bytes }) => ({ name: path.basename(file), source: file, bytes })),
    );
    const completed: unknown = JSON.parse(results);
    const markdown = Array.isArray(completed)
      ? completed
          .flatMap((raw: unknown) =>
            projectRecord(raw) && typeof raw.alt === 'string' && typeof raw.href === 'string'
              ? [imageRef(raw.alt, raw.href)]
              : [],
          )
          .join('\n')
      : '';
    if (markdown && !sender.isDestroyed() && originalPage === input.page(sender)) {
      const current = await snapshot();
      if (
        current?.text === placement.text &&
        !sender.isDestroyed() &&
        originalPage === input.page(sender)
      )
        allowPickedInsertion(
          sender,
          originalPage,
          id,
          document,
          current.revision,
          placement,
          markdown,
        );
    }
    return results;
  });
}
