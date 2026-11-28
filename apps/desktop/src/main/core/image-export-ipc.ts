// Saving an image the window drew (a Mermaid diagram from the transcript, ADR-0080): the page
// hands over the bytes; the main process checks they are an SVG or a PNG of bounded size and
// writes them only where the user chose in the native save dialog, so the page can neither write
// without the user nor choose where.
import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { app, BrowserWindow, dialog, type WebContents } from 'electron';

import { IPC_CHANNELS } from '../../shared/ipc.js';
import type { Translator } from '../../shared/i18n/index.js';
import type { RegisterHandler } from '../ipc/register.js';

/** The largest image a page may save. */
export const IMAGE_EXPORT_LIMIT = 16 * 1024 * 1024;

export type ImageKind = 'svg' | 'png';

export interface ImageExport {
  readonly kind: ImageKind;
  /** The suggested file name, without a directory; the extension follows the kind. */
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** Where the save dialog asks the user for a path; replaced in tests. */
export interface ImageSavePort {
  /** The path the user chose for the window of `sender`, or null when cancelled. */
  choosePath(
    sender: WebContents,
    title: string,
    name: string,
    kind: ImageKind,
  ): Promise<string | null>;
}

/** The Electron save dialog, starting in the Downloads folder. */
export const electronImageSavePort: ImageSavePort = {
  async choosePath(sender, title, name, kind) {
    const window = BrowserWindow.fromWebContents(sender);
    const options = {
      title,
      defaultPath: path.join(app.getPath('downloads'), name),
      filters: [{ name: kind.toUpperCase(), extensions: [kind] }],
    };
    const result =
      window === null
        ? await dialog.showSaveDialog(options)
        : await dialog.showSaveDialog(window, options);
    return result.canceled || result.filePath === '' ? null : result.filePath;
  },
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Whether `bytes` start the way an SVG document does (an XML declaration or comment first). */
function looksLikeSvg(bytes: Uint8Array): boolean {
  // The decoder drops a byte order mark.
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, 1024))
    .trimStart();
  return /^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s/>]/u.test(head);
}

/** A file name the dialog can suggest: one component, no control characters, with its extension. */
export function exportName(value: unknown, kind: ImageKind): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 120) {
    throw new TypeError('name must be 1 to 120 characters');
  }
  const base = value.replace(/[\p{Cc}\p{Cf}<>:"/\\|?*]/gu, '-').replace(/^[.\s]+|[.\s]+$/gu, '');
  const stem = (base === '' ? 'image' : base).replace(/\.(?:svg|png)$/iu, '');
  return `${stem}.${kind}`;
}

/** Checks a save request from a page. */
export function imageExport(value: unknown): ImageExport {
  if (typeof value !== 'object' || value === null) throw new TypeError('request must be an object');
  const kind: unknown = Reflect.get(value, 'kind');
  const name: unknown = Reflect.get(value, 'name');
  const bytes: unknown = Reflect.get(value, 'bytes');
  if (kind !== 'svg' && kind !== 'png') throw new TypeError('kind must be svg or png');
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new TypeError('bytes must be a non-empty Uint8Array');
  }
  if (bytes.byteLength > IMAGE_EXPORT_LIMIT) throw new TypeError('image exceeds 16 MiB');
  const valid =
    kind === 'png' ? PNG_SIGNATURE.every((byte, at) => bytes[at] === byte) : looksLikeSvg(bytes);
  if (!valid) throw new TypeError(`bytes are not a ${kind.toUpperCase()} image`);
  return { kind, name: exportName(name, kind), bytes };
}

/** Writes `bytes` to `destination` through a temporary file next to it. */
async function writeAtomically(destination: string, bytes: Uint8Array): Promise<void> {
  const staging = path.join(path.dirname(destination), `.piarc-export-${randomUUID()}`);
  const handle = await open(staging, 'wx', 0o644);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  try {
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { force: true });
    throw error;
  }
}

/** Registers `saveImage`: true once written, false when the user cancelled. */
export function registerImageExportHandlers(
  registerHandler: RegisterHandler,
  translator: () => Translator,
  port: ImageSavePort = electronImageSavePort,
): void {
  registerHandler(IPC_CHANNELS.imageSave, async ({ sender }, [raw]) => {
    const request = imageExport(raw);
    const target = await port.choosePath(
      sender,
      translator().t('image.saveTitle'),
      request.name,
      request.kind,
    );
    if (target === null) return false;
    await writeAtomically(target, request.bytes);
    return true;
  });
}
