// A snapshot can contain several 4 MiB files. Core keeps its bytes fixed across pages.
import { randomUUID } from 'node:crypto';

import { AhpError } from '../protocol/errors.js';
import type { CoreBridge } from '../runtime/core-bridge.js';
import { isObject } from '../runtime/items.js';
import type { FsMemoryParams, MemoryFile, MemorySnapshot } from '@piarc/protocol';

/** Conditional rules (T24): files just read or written, and the rules already delivered. */
export interface RuleScan {
  files?: string[];
  rules?: string[];
}

export type ReadMemory = (
  directories: string[],
  includeGit: boolean,
  signal?: AbortSignal,
  turnId?: string,
  scan?: RuleScan,
) => Promise<MemorySnapshot>;

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** One memory document from Core, or undefined when it is malformed. */
export function parseMemoryFile(file: unknown): MemoryFile | undefined {
  if (
    !isObject(file) ||
    typeof file.path !== 'string' ||
    typeof file.content !== 'string' ||
    (file.paths != null && !isStrings(file.paths)) ||
    (file.kind != null && file.kind !== 'managed' && file.kind !== 'autoMemory')
  ) {
    return undefined;
  }
  return {
    path: file.path,
    content: file.content,
    ...(file.paths == null ? {} : { paths: file.paths }),
    // A managed CLAUDE.md or the auto memory index (T47).
    ...(file.kind === 'managed' || file.kind === 'autoMemory' ? { kind: file.kind } : {}),
  };
}

function parseFiles(value: unknown): MemoryFile[] {
  if (!Array.isArray(value))
    throw new AhpError('invalidRequest', 'fs/memory returned an invalid file list');
  return value.map((file: unknown) => {
    const parsed = parseMemoryFile(file);
    if (parsed === undefined) {
      throw new AhpError('invalidRequest', 'fs/memory returned an invalid file');
    }
    return parsed;
  });
}

function parseSnapshot(raw: string): MemorySnapshot {
  const value: unknown = JSON.parse(raw);
  if (
    !isObject(value) ||
    (value.gitStatus != null && typeof value.gitStatus !== 'string') ||
    (value.inactiveRules != null && typeof value.inactiveRules !== 'boolean')
  ) {
    throw new AhpError('invalidRequest', 'fs/memory returned an invalid snapshot');
  }
  return {
    files: parseFiles(value.files),
    ...(value.currentFiles == null ? {} : { currentFiles: parseFiles(value.currentFiles) }),
    ...(value.gitStatus == null ? {} : { gitStatus: value.gitStatus }),
    ...(value.inactiveRules === true ? { inactiveRules: true } : {}),
  };
}

export function memoryReader(bridge: CoreBridge, sessionId: string): ReadMemory {
  return async (directories, includeGit, signal, turnId, scan) => {
    const toolCallId = `memory-${randomUUID()}`;
    const id = { sessionId, toolCallId };
    const options = { approval: id, ...(signal === undefined ? {} : { signal }) };
    const chunks: string[] = [];
    let offset = 0;
    for (;;) {
      const params: FsMemoryParams =
        offset === 0
          ? {
              ...id,
              directories,
              includeGit,
              ...(turnId === undefined ? {} : { turnId }),
              ...(scan?.files?.length ? { files: scan.files } : {}),
              ...(scan?.rules?.length ? { rules: scan.rules } : {}),
            }
          : { ...id, offset };
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
