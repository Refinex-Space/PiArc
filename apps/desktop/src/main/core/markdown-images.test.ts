import type { WebContents, IpcMainInvokeEvent } from 'electron';
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { IpcHandler } from '../ipc/register.js';
import { IPC_CHANNELS } from '../../shared/ipc.js';
import { Translator } from '../../shared/i18n/index.js';
import { registerMarkdownImageHandlers, markdownImageResponse } from './markdown-images.js';
const choose = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({
  dialog: { showOpenDialog: choose },
  BrowserWindow: { fromWebContents: () => null, getFocusedWindow: () => null },
}));
function handlers() {
  const command = new Map<string, IpcHandler>();
  const frame = {},
    sender = Object.assign(new EventEmitter(), {
      mainFrame: frame,
      isDestroyed: () => false,
    }) as unknown as WebContents;
  const core = {
    markdownImageSettings: vi.fn((q: string) => Promise.resolve(q)),
    projectFiles: vi.fn(() =>
      Promise.resolve(JSON.stringify({ mime: 'image/png', extension: 'png', base64: 'AQID' })),
    ),
  };
  const recent = vi.fn();
  registerMarkdownImageHandlers(
    (k, h) => {
      command.set(k, h);
    },
    core,
    { requireInput: recent, page: () => 1 },
    () => new Translator('en'),
  );
  const event = { sender, senderFrame: frame } as IpcMainInvokeEvent;
  const invoke = (channel: string, ...args: unknown[]) =>
    Promise.resolve(command.get(channel)?.(event, args));
  return { invoke, core, sender, recent };
}
it('a native folder choice is the only renderer action that can create an image directory capability', async () => {
  const { invoke, core, recent } = handlers();
  await expect(
    invoke(IPC_CHANNELS.markdownImageSettings, { op: 'grant', path: '/tmp/arbitrary' }),
  ).rejects.toThrow();
  expect(core.markdownImageSettings).not.toHaveBeenCalled();
  choose.mockResolvedValueOnce({ canceled: false, filePaths: ['/chosen/pictures'] });
  await invoke(IPC_CHANNELS.markdownImageSettings, { op: 'choose', path: '/not/selected' });
  expect(core.markdownImageSettings).toHaveBeenCalledWith(
    JSON.stringify({ op: 'grant', path: '/chosen/pictures' }),
  );
  expect(recent).toHaveBeenCalled();
});
it('releases the local picture on owner navigation and never serves it as an executable document', async () => {
  const { invoke, sender } = handlers();
  const url = await invoke(IPC_CHANNELS.markdownImage, 'session-one', 'docs/d.md', {
    op: 'preview',
    reference: './assets/sample.png',
  });
  if (typeof url !== 'string') throw new Error('missing image ticket');
  const reading = markdownImageResponse(new Request(url));
  if (!reading) throw new Error('missing image response');
  expect(reading.headers.get('Content-Type')).toBe('image/png');
  expect(reading.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  expect([...new Uint8Array(await reading.arrayBuffer())]).toEqual([1, 2, 3]);
  sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  expect(markdownImageResponse(new Request(url))?.status).toBe(404);
});

it('forgetting an external image directory invalidates its displayed resource and pending reads', async () => {
  const { invoke, core } = handlers();
  const result = JSON.stringify({
    mime: 'image/png',
    extension: 'png',
    external: true,
    base64: 'AQID',
  });
  core.projectFiles.mockResolvedValueOnce(result);
  const url = await invoke(IPC_CHANNELS.markdownImage, 'session-one', 'guide.md', {
    op: 'preview',
    reference: '../pictures/a.png',
  });
  if (typeof url !== 'string') throw new Error('missing resource URL');
  const next = Promise.withResolvers<string>();
  core.projectFiles.mockReturnValueOnce(next.promise);
  const pending = invoke(IPC_CHANNELS.markdownImage, 'session-one', 'guide.md', {
    op: 'preview',
    reference: '../pictures/b.png',
  });
  await invoke(IPC_CHANNELS.markdownImageSettings, { op: 'forget' });
  next.resolve(result);
  await expect(pending).rejects.toThrow();
  expect(markdownImageResponse(new Request(url))?.status).toBe(404);
});
