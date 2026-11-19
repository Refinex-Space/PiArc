// A snapshot can contain several 4 MiB files. Core keeps its bytes fixed across pages.
import { randomUUID } from 'node:crypto';

import { AhpError } from '../protocol/errors.js';
import type { CoreBridge } from '../runtime/core-bridge.js';
import { isObject } from '../runtime/items.js';
import type { FsMemoryParams, MemoryFile, MemorySnapshot } from '@piarc/protocol';

export type ReadMemory = (
  directories: string[],
  includeGit: boolean,
  signal?: AbortSignal,
) => Promise<MemorySnapshot>;

function parseFiles(value: unknown): MemoryFile[] {
  if (!Array.isArray(value))
    throw new AhpError('invalidRequest', 'fs/memory returned an invalid file list');
  return value.map((file: unknown) => {
    if (!isObject(file) || typeof file.path !== 'string' || typeof file.content !== 'string') {
      throw new AhpError('invalidRequest', 'fs/memory returned an invalid file');
    }
    return { path: file.path, content: file.content };
  });
}

function parseSnapshot(raw: string): MemorySnapshot {
  const value: unknown = JSON.parse(raw);
  if (!isObject(value) || (value.gitStatus != null && typeof value.gitStatus !== 'string')) {
    throw new AhpError('invalidRequest', 'fs/memory returned an invalid snapshot');
  }
  return {
    files: parseFiles(value.files),
    ...(value.currentFiles == null ? {} : { currentFiles: parseFiles(value.currentFiles) }),
    ...(value.gitStatus == null ? {} : { gitStatus: value.gitStatus }),
  };
}

export function memoryReader(bridge: CoreBridge, sessionId: string): ReadMemory {
  return async (directories, includeGit, signal) => {
    const toolCallId = `memory-${randomUUID()}`;
    const id = { sessionId, toolCallId };
    const options = { approval: id, ...(signal === undefined ? {} : { signal }) };
    const chunks: string[] = [];
    let offset = 0;
    for (;;) {
      const params: FsMemoryParams =
        offset === 0 ? { ...id, directories, includeGit } : { ...id, offset };
      const page = await bridge.requestTyped(
        'fs/memory',
        params,
        (value) => {
          if (!isObject(value) || typeof value.chunk !== 'string') return;
          const next = value.nextOffset;
          if (
            next != null &&
            (typeof next !== 'number' ||
              !Number.isSafeInteger(next) ||
              next <= offset ||
              next !== offset + Buffer.byteLength(value.chunk))
          )
            return;
          return { chunk: value.chunk, next: next ?? undefined };
        },
        options,
      );
      chunks.push(page.chunk);
      if (page.next === undefined) return parseSnapshot(chunks.join(''));
      offset = page.next;
    }
  };
}
