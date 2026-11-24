import { EventEmitter } from 'node:events';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../shared/ipc.js';
import type { IpcHandler } from '../ipc/register.js';
import { ProjectPreviews } from './project-preview.js';

vi.mock('electron', () => ({ protocol: { handle: vi.fn() } }));
it('binds passive document ranges to one file, session and workbench page and releases the grant', async () => {
  const bytes = Buffer.from('0123456789');
  const core = {
    projectTrust: () => Promise.resolve('{"trusted":false}'),
    sessionDeletionTarget: () => Promise.resolve('{"workspace":"/project"}'),
    projectFiles: vi.fn((_id: string, data: string) => {
      const op = JSON.parse(data) as { length: number; offset: number };
      return Promise.resolve(
        JSON.stringify({
          size: bytes.length,
          revision: 'v1',
          base64: bytes.subarray(op.offset, op.offset + op.length).toString('base64'),
        }),
      );
    }),
  };
  const preview = new ProjectPreviews(core);
  const sender = Object.assign(new EventEmitter(), {
    mainFrame: {},
    isDestroyed: () => false,
  }) as unknown as WebContents;
  const event = { sender, senderFrame: sender.mainFrame } as IpcMainInvokeEvent;
  const handlers = new Map<string, IpcHandler>();
  preview.register(
    (c, h) => {
      handlers.set(c, h);
    },
    { requireInput: vi.fn() },
  );
  const call = (...args: unknown[]) =>
    Promise.resolve(handlers.get(IPC_CHANNELS.projectFilePreview)?.(event, args));
  await expect(call('test-session', 'index.html', 'interactive')).rejects.toThrow('trusted');
  const url = (await call('test-session', 'clip.mp4', 'media')) as string;
  expect(preview.allowsFrame(sender, url)).toBe(true);
  expect(preview.allowsFrame({} as WebContents, url)).toBe(false);
  expect((await preview.serve(new Request(new URL('other.mp4', url)))).status).toBe(404);
  const result = await preview.serve(new Request(url, { headers: { Range: 'bytes=2-5' } }));
  expect(result.status).toBe(206);
  expect(result.headers.get('content-range')).toBe('bytes 2-5/10');
  expect(await result.text()).toBe('2345');
  await call('test-session', 'clip.mp4', 'release', url);
  expect((await preview.serve(new Request(url))).status).toBe(404);
});
