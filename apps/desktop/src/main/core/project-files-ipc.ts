// Core resolves every project-relative name before any OS integration. Editors are fixed
// native applications. No project executable, shell command or renderer-supplied program runs.
import path from 'node:path';
import { markdownPaste } from './markdown-paste.js';
import { takePickedInsertion } from './markdown-image-save.js';
import { installedEditors, openInFileEditor } from '../platform/file-editors.js';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { projectChunk, readProjectRange } from './project-file-stream.js';
import { open, rename, rm } from 'node:fs/promises';
import {
  BrowserWindow,
  Menu,
  ClipboardItem,
  clipboard,
  nativeImage,
  dialog,
  shell,
} from 'electron';
import { IPC_CHANNELS, isSessionId } from '../../shared/ipc.js';
import {
  canOpenSystemDocument,
  isProjectPath,
  isProjectRequest,
  projectRecord,
} from '../../shared/project-files.js';
import type { RegisterHandler } from '../ipc/register.js';
import type { CoreRuntime } from './native/piarc-core.js';
import type { TerminalOwners } from './terminal-ipc.js';

export function registerProjectFileHandlers(
  register: RegisterHandler,
  core: Pick<CoreRuntime, 'projectFiles'>,
  input: Pick<TerminalOwners, 'requireInput' | 'page'>,
  fileOwner: (child: Electron.WebContents) => Electron.WebContents | undefined,
) {
  register(IPC_CHANNELS.projectFiles, ({ sender, senderFrame }, [id, request]) => {
    if (senderFrame !== sender.mainFrame || !isSessionId(id) || !isProjectRequest(request))
      throw new TypeError('Invalid project file request');
    if (
      request.op === 'save' &&
      !takePickedInsertion(
        sender,
        input.page(sender),
        id,
        request.path,
        request.revision,
        request.text,
      )
    )
      input.requireInput(sender, id, 'files');
    return core.projectFiles(id, JSON.stringify(request));
  });
  register(IPC_CHANNELS.projectFileAction, async ({ sender, senderFrame }, [id, file, action]) => {
    if (
      senderFrame !== sender.mainFrame ||
      !isSessionId(id) ||
      typeof action !== 'string' ||
      !isProjectPath(file, action === 'editors')
    )
      throw new TypeError('Invalid project file action');
    if (action === 'editors')
      return JSON.stringify((await installedEditors()).map(({ id, name }) => ({ id, name })));
    if (action !== 'observeMarkdownPaste') input.requireInput(sender, id, 'files');
    if (action === 'observeMarkdownPaste' || action === 'pasteMarkdown')
      return markdownPaste(
        action,
        id,
        file,
        sender,
        () => BrowserWindow.getFocusedWindow()?.webContents,
        fileOwner,
      );
    if (action === 'editorMenu') {
      const focus = BrowserWindow.getFocusedWindow();
      if (!focus || (focus.webContents !== sender && fileOwner(focus.webContents) !== sender))
        throw new Error('File editor is not focused');
      Menu.buildFromTemplate([
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' },
      ]).popup({ window: focus });
      return '{}';
    }
    const resolved: unknown = JSON.parse(
      await core.projectFiles(id, JSON.stringify({ op: 'resolve', path: file })),
    );
    if (
      !projectRecord(resolved) ||
      typeof resolved.path !== 'string' ||
      !path.isAbsolute(resolved.path)
    )
      throw new TypeError('Invalid project file target');
    if (action === 'reveal') shell.showItemInFolder(resolved.path);
    else if (action === 'copyImage') {
      const raw: unknown = JSON.parse(
        await core.projectFiles(id, JSON.stringify({ op: 'export', path: file })),
      );
      if (!projectRecord(raw) || typeof raw.base64 !== 'string')
        throw new TypeError('Invalid image');
      const image = nativeImage.createFromBuffer(Buffer.from(raw.base64, 'base64'));
      if (image.isEmpty()) throw new Error('Unsupported image format');
      await clipboard.write([
        new ClipboardItem({
          'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }),
        }),
      ]);
    } else if (action === 'download') {
      const parent = BrowserWindow.fromWebContents(sender);
      const options = { defaultPath: path.basename(resolved.path) };
      const target = await (parent
        ? dialog.showSaveDialog(parent, options)
        : dialog.showSaveDialog(options));
      if (!target.canceled && target.filePath) {
        const { size, revision } = await projectChunk(core, id, file, 0, 0);
        const destination = target.filePath;
        const staging = path.join(path.dirname(destination), '.piarc-export-' + randomUUID());
        const handle = await open(staging, 'wx', 0o600);
        try {
          await pipeline(
            readProjectRange(core, id, file, revision, 0, size - 1, () => !sender.isDestroyed()),
            handle.createWriteStream(),
          );
          await rename(staging, destination);
        } finally {
          await handle.close();
          await rm(staging, { force: true });
        }
      }
    } else if (action === 'open') {
      if (resolved.kind !== 'file' || !canOpenSystemDocument(resolved.path))
        throw new TypeError('Unsupported system document');
      const failure = await shell.openPath(resolved.path);
      if (failure) throw new Error(failure);
    } else {
      await openInFileEditor(action, resolved.path, resolved.kind === 'directory');
    }
    return '{}';
  });
}
