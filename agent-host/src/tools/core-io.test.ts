import path from 'node:path';

import { createLsToolDefinition, type ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';

import { AhpError } from '../protocol/errors.js';
import { CoreBridge } from '../runtime/core-bridge.js';
import { asFileError, CoreIo, ExecOutputRouter, FileError } from './core-io.js';
import { lsOperations } from './ls.js';

interface Sent {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

/** A CoreIo whose requests `answer` responds to synchronously. */
function io(answer: (sent: Sent) => { result: unknown } | { error: AhpError }): {
  io: CoreIo;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const bridge: CoreBridge = new CoreBridge((message) => {
    const request = message as Sent;
    sent.push(request);
    queueMicrotask(() => {
      const reply = answer(request);
      bridge.handleResponse(
        'result' in reply
          ? { jsonrpc: '2.0', id: request.id, result: reply.result }
          : { jsonrpc: '2.0', id: request.id, error: reply.error.toErrorObject() },
      );
    });
  });
  return {
    sent,
    io: new CoreIo({
      bridge,
      sessionId: 'sess-1',
      execOutput: new ExecOutputRouter(),
      readBlob: () => Promise.reject(new Error('no blobs here')),
    }),
  };
}

const origin = { tool: 'Read', toolCallId: 'call-1' } as const;

describe('CoreIo', () => {
  it('reads a file range by range with the session and origin on every request', async () => {
    const pieces = ['第一', 'line\n'];
    const { io: core, sent } = io((request) => {
      const index = sent.indexOf(request);
      const text = pieces[index] ?? '';
      return {
        result: {
          path: '/w/a',
          size: 10,
          offset: 0,
          bytesRead: Buffer.byteLength(text),
          eof: index === 1,
          text,
        },
      };
    });
    const text = await core.readText('/w/a', origin);
    expect(text.toString('utf8')).toBe('第一line\n');
    expect(sent.map((s) => [s.method, s.params.offset])).toEqual([
      ['fs/read', 0],
      ['fs/read', 6],
    ]);
    expect(sent[0]?.params).toMatchObject({ sessionId: 'sess-1', path: '/w/a', origin });
  });

  it('splits large writes without cutting a surrogate pair', async () => {
    const { io: core, sent } = io(() => ({ result: { path: '/w/a', bytesWritten: 1 } }));
    const content = `${'x'.repeat(256 * 1024 - 1)}🙂tail`;
    await core.write('/w/a', content, origin);
    const chunks = sent.map((s) => s.params.content as string);
    expect(chunks.join('')).toBe(content);
    expect(chunks[0]?.length).toBe(256 * 1024 - 1);
    expect(sent.map((s) => s.params.append)).toEqual([undefined, true]);
  });

  it('rejects malformed results', async () => {
    const { io: core } = io(() => ({
      result: { path: '/w', kind: 'socket', size: 0, readonly: false },
    }));
    await expect(core.stat('/w', origin)).rejects.toMatchObject({ kind: 'invalidRequest' });
  });
});

describe('file errors', () => {
  it('turn Core errors into Node-shaped errors for the path the tool used', () => {
    const missing = new AhpError('notFound', 'x', {
      details: { code: 'ENOENT', path: '/private/w/a' },
    });
    const error = asFileError(missing, 'access', '/w/a');
    expect(error).toBeInstanceOf(FileError);
    expect(error).toMatchObject({
      message: "ENOENT: no such file or directory, access '/w/a'",
      code: 'ENOENT',
      syscall: 'access',
      path: '/w/a',
    });
    const directory = new AhpError('ioError', 'x', { details: { code: 'EISDIR', path: '/w' } });
    expect((asFileError(directory, 'read', '/w') as Error).message).toBe(
      "EISDIR: illegal operation on a directory, read '/w'",
    );
    const outside = new AhpError('outsideWorkspace', 'resolves outside the workspace root');
    expect(asFileError(outside, 'access', '/etc/hosts')).toBe(outside);
  });
});

describe('ExecOutputRouter', () => {
  it('delivers output to the listening command only', () => {
    const router = new ExecOutputRouter();
    const seen: string[] = [];
    const stop = router.listen('r1', (stream, data) => seen.push(`${stream}:${data}`));
    expect(router.deliver({ requestId: 'r1', stream: 'stdout', seq: 1, data: 'a' })).toBe(true);
    expect(router.deliver({ requestId: 'r2', stream: 'stdout', seq: 1, data: 'b' })).toBe(false);
    expect(router.deliver({ requestId: 'r1', stream: 'stdin', seq: 2, data: 'c' })).toBe(false);
    stop();
    expect(router.deliver({ requestId: 'r1', stream: 'stderr', seq: 3, data: 'd' })).toBe(false);
    expect(seen).toEqual(['stdout:a']);
  });
});

describe('lsOperations', () => {
  it('lets Pi list a directory through Core', async () => {
    // A root of one letter would not do: on Windows Pi reads `/w` as Git Bash's spelling of the
    // drive `W:\`. `path.resolve` gives an absolute path on either platform.
    const root = path.resolve('/workspace');
    const { io: core, sent } = io((request) => {
      if (request.method === 'fs/list') {
        return {
          result: {
            path: root,
            entries: [
              { name: 'b.txt', kind: 'file' },
              { name: 'A', kind: 'directory' },
            ],
            truncated: false,
          },
        };
      }
      const path = request.params.path as string;
      if (path.endsWith('missing')) {
        return {
          error: new AhpError('notFound', 'missing', { details: { code: 'ENOENT', path } }),
        };
      }
      const kind = path === root || path.endsWith('A') ? 'directory' : 'file';
      return { result: { path, kind, size: 0, readonly: false } };
    });
    const ls = createLsToolDefinition(root, {
      operations: lsOperations(core, { tool: 'Read', toolCallId: 'c' }),
    });
    const ctx = { cwd: root } as ExtensionToolContext;
    const result = await ls.execute('c', {}, undefined, undefined, ctx);
    expect(result.content).toEqual([{ type: 'text', text: 'A/\nb.txt' }]);
    expect(new Set(sent.map((s) => s.method))).toEqual(new Set(['fs/stat', 'fs/list']));
    await expect(ls.execute('c', { path: 'missing' }, undefined, undefined, ctx)).rejects.toThrow(
      /Path not found/,
    );
  });
});
