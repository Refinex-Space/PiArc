// The tools' only way to the workspace: typed `fs/*` and `exec/*` requests to Core for one
// session (ADR-0004, architecture section 6.1.3). Nothing under `src/tools/` may import `fs` or
// `child_process` (ESLint); results are validated here, at the AHP boundary.
//
// Core's file errors are turned back into errors shaped like Node's (`ENOENT: no such file or
// directory, access '<path>'`, with `code`, `syscall` and `path`), naming the path the tool
// asked for: Pi's tool code formats them into its results, and the model then sees what it would
// see with Pi's local file operations.
import { randomUUID } from 'node:crypto';

import type {
  BlobRef,
  DirEntry,
  FileKind,
  FileStat,
  FsGrepResult,
  GrepLine,
} from '@piarc/protocol';

import { AhpError } from '../protocol/errors.js';
import { wellFormedJson } from '../protocol/well-formed.js';
import type { CoreBridge } from '../runtime/core-bridge.js';
import type { CanonicalTool } from './profile.js';

/** The tool call a request serves; sent as `origin`. */
export interface Origin {
  readonly tool: CanonicalTool;
  readonly toolCallId: string;
}

/** Largest UTF-16 string sent in one `fs/write`; well below the 8 MiB frame limit even when
 * every code unit needs a `\uXXXX` escape. */
const WRITE_CHUNK = 256 * 1024;

/** Descriptions Node gives the error codes Core reports. */
const DESCRIPTIONS: Record<string, string> = {
  ENOENT: 'no such file or directory',
  EACCES: 'permission denied',
  EEXIST: 'file already exists',
  EISDIR: 'illegal operation on a directory',
  ENOTDIR: 'not a directory',
  ENOTEMPTY: 'directory not empty',
  EROFS: 'read-only file system',
  ELOOP: 'too many symbolic links encountered',
  ENOSPC: 'no space left on device',
  EFBIG: 'file too large',
  ENAMETOOLONG: 'name too long',
  EBUSY: 'resource busy or locked',
  EINVAL: 'invalid argument',
  EIO: 'i/o error',
};

/** An error shaped like the one Node's `fs` throws. */
export class FileError extends Error {
  readonly code: string;
  readonly syscall: string;
  readonly path: string;

  constructor(code: string, syscall: string, path: string) {
    super(`${code}: ${DESCRIPTIONS[code] ?? 'unknown error'}, ${syscall} '${path}'`);
    this.name = 'FileError';
    this.code = code;
    this.syscall = syscall;
    this.path = path;
  }
}

/** Whether `signal` has fired; a function so checks after an `await` are not narrowed away. */
export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** The POSIX-style code of a Core file error (`ENOENT` for `notFound`), if it has one. */
export function errorCode(error: unknown): string | undefined {
  if (!(error instanceof AhpError)) {
    return undefined;
  }
  if (error.kind === 'notFound') {
    return 'ENOENT';
  }
  if (
    error.kind === 'ioError' &&
    isRecord(error.details) &&
    typeof error.details.code === 'string'
  ) {
    return error.details.code;
  }
  return undefined;
}

/** `error` as Node would report it for `syscall` on `path`; other errors are returned as they
 * are (for example `outsideWorkspace`, which has no Node counterpart). */
export function asFileError(error: unknown, syscall: string, path: string): unknown {
  const code = errorCode(error);
  return code === undefined ? error : new FileError(code, syscall, path);
}

/** Routes `exec/output` notifications to the command that produced them. */
export class ExecOutputRouter {
  readonly #listeners = new Map<string, (stream: 'stdout' | 'stderr', data: string) => void>();

  listen(
    requestId: string,
    listener: (stream: 'stdout' | 'stderr', data: string) => void,
  ): () => void {
    this.#listeners.set(requestId, listener);
    return () => {
      this.#listeners.delete(requestId);
    };
  }

  /** Delivers one notification; returns false when it is malformed or nobody listens. */
  deliver(params: unknown): boolean {
    if (
      !isRecord(params) ||
      typeof params.requestId !== 'string' ||
      (params.stream !== 'stdout' && params.stream !== 'stderr') ||
      typeof params.data !== 'string'
    ) {
      return false;
    }
    const listener = this.#listeners.get(params.requestId);
    listener?.(params.stream, params.data);
    return listener !== undefined;
  }
}

/** How a command ended. */
export interface CommandOutcome {
  readonly exitCode: number | undefined;
  readonly signal: number | undefined;
  readonly killed: boolean;
}

export interface CoreIoOptions {
  readonly bridge: CoreBridge;
  readonly sessionId: string;
  readonly execOutput: ExecOutputRouter;
  /** Reads a blob Core made (`fs/read` in blob mode). */
  readonly readBlob: (blob: BlobRef) => Promise<Buffer>;
}

/** Typed `fs/*` and `exec/*` requests for one session. */
export class CoreIo {
  readonly #options: CoreIoOptions;

  constructor(options: CoreIoOptions) {
    this.#options = options;
  }

  get sessionId(): string {
    return this.#options.sessionId;
  }

  async stat(path: string, origin: Origin, detectImage = false): Promise<FileStat> {
    return this.#request(
      'fs/stat',
      { path, origin, ...(detectImage ? { detectImage } : {}) },
      parseStat,
    );
  }

  /** Reads the file range by range, each piece whole UTF-8; stops early when `signal` aborts. */
  async *readChunks(path: string, origin: Origin, signal?: AbortSignal): AsyncGenerator<Buffer> {
    let offset = 0;
    for (;;) {
      signal?.throwIfAborted();
      const chunk = await this.#request('fs/read', { path, origin, offset }, parseRead, signal);
      if (chunk.text !== undefined && chunk.text.length > 0) {
        yield Buffer.from(chunk.text, 'utf8');
      }
      offset += chunk.bytesRead;
      if (chunk.eof || chunk.bytesRead === 0) {
        return;
      }
    }
  }

  /** The whole file as text bytes (UTF-8, invalid sequences replaced). */
  async readText(path: string, origin: Origin, signal?: AbortSignal): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const part of this.readChunks(path, origin, signal)) {
      parts.push(part);
    }
    return Buffer.concat(parts);
  }

  /** The file's exact bytes, through a blob Core copies (ADR-0009 rule 8). */
  async readBytes(path: string, origin: Origin): Promise<Buffer> {
    const result = await this.#request('fs/read', { path, origin, mode: 'blob' }, parseRead);
    if (result.blob === undefined) {
      throw new AhpError('invalidRequest', 'fs/read in blob mode returned no blob');
    }
    return this.#options.readBlob(result.blob);
  }

  /** Writes `content` as the file's text, in pieces when it is large. */
  async write(path: string, content: string, origin: Origin): Promise<void> {
    let start = 0;
    do {
      let end = Math.min(start + WRITE_CHUNK, content.length);
      // Never split a surrogate pair between two requests.
      if (end < content.length && isHighSurrogate(content.charCodeAt(end - 1))) {
        end -= 1;
      }
      await this.#request(
        'fs/write',
        {
          path,
          origin,
          content: content.slice(start, end),
          ...(start > 0 ? { append: true } : {}),
        },
        parseObject,
      );
      start = end;
    } while (start < content.length);
  }

  async mkdir(path: string, origin: Origin): Promise<void> {
    await this.#request('fs/mkdir', { path, origin }, parseObject);
  }

  async list(path: string, origin: Origin): Promise<DirEntry[]> {
    return this.#request('fs/list', { path, origin }, parseList);
  }

  async glob(
    path: string,
    pattern: string,
    options: { exclude: readonly string[]; limit: number },
    origin: Origin,
  ): Promise<string[]> {
    return this.#request(
      'fs/glob',
      { path, pattern, exclude: options.exclude, limit: options.limit, origin },
      parseGlob,
    );
  }

  async grep(
    query: {
      path: string;
      pattern: string;
      glob?: string | undefined;
      ignoreCase?: boolean | undefined;
      literal?: boolean | undefined;
      context: number;
      limit: number;
    },
    origin: Origin,
    signal?: AbortSignal,
  ): Promise<FsGrepResult> {
    const params: Record<string, unknown> = {
      path: query.path,
      pattern: query.pattern,
      context: query.context,
      limit: query.limit,
      origin,
    };
    if (query.glob !== undefined) params.glob = query.glob;
    if (query.ignoreCase === true) params.ignoreCase = true;
    if (query.literal === true) params.literal = true;
    return this.#request('fs/grep', params, parseGrep, signal);
  }

  /**
   * Starts `command` in Core and streams its output to `onData`. `outcome` settles once the
   * command has ended; `kill` terminates it (the caller's abort or timeout).
   */
  run(
    command: { command: string; cwd: string; env: Record<string, string> },
    onData: (data: Buffer) => void,
    origin: Origin,
  ): { outcome: Promise<CommandOutcome>; kill: () => Promise<void> } {
    const requestId = `exec-${randomUUID()}`;
    const stopListening = this.#options.execOutput.listen(requestId, (_stream, data) => {
      onData(Buffer.from(data, 'utf8'));
    });
    const outcome = this.#request(
      'exec/run',
      { requestId, command: command.command, cwd: command.cwd, env: command.env, origin },
      parseOutcome,
      undefined,
      // Commands run as long as they run; the caller kills them on abort or timeout.
      null,
    ).finally(stopListening);
    const kill = async (): Promise<void> => {
      await this.#request('exec/kill', { requestId }, parseObject);
    };
    return { outcome, kill };
  }

  async #request<T>(
    method: string,
    params: Record<string, unknown>,
    parse: (result: unknown) => T | undefined,
    signal?: AbortSignal,
    timeoutMs?: number | null,
  ): Promise<T> {
    return this.#options.bridge.requestTyped(
      method,
      // Paths, patterns, commands and contents come from the model.
      wellFormedJson({ sessionId: this.#options.sessionId, ...params }),
      parse,
      {
        ...(signal === undefined ? {} : { signal }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      },
    );
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isKind(value: unknown): value is FileKind {
  return value === 'file' || value === 'directory' || value === 'other';
}

function parseObject(result: unknown): Record<string, unknown> | undefined {
  return isRecord(result) ? result : undefined;
}

function parseStat(result: unknown): FileStat | undefined {
  if (
    !isRecord(result) ||
    typeof result.path !== 'string' ||
    !isKind(result.kind) ||
    !isCount(result.size) ||
    typeof result.readonly !== 'boolean'
  ) {
    return undefined;
  }
  const stat: FileStat = {
    path: result.path,
    kind: result.kind,
    size: result.size,
    readonly: result.readonly,
  };
  if (typeof result.imageMimeType === 'string') stat.imageMimeType = result.imageMimeType;
  if (isCount(result.modifiedMs)) stat.modifiedMs = result.modifiedMs;
  return stat;
}

interface ReadPiece {
  readonly bytesRead: number;
  readonly eof: boolean;
  readonly text: string | undefined;
  readonly blob: BlobRef | undefined;
}

function parseRead(result: unknown): ReadPiece | undefined {
  if (!isRecord(result) || !isCount(result.bytesRead) || typeof result.eof !== 'boolean') {
    return undefined;
  }
  const text = typeof result.text === 'string' ? result.text : undefined;
  const blob = result.blob;
  const parsedBlob =
    isRecord(blob) &&
    typeof blob.path === 'string' &&
    typeof blob.sha256 === 'string' &&
    isCount(blob.size)
      ? { path: blob.path, sha256: blob.sha256, size: blob.size }
      : undefined;
  return { bytesRead: result.bytesRead, eof: result.eof, text, blob: parsedBlob };
}

function parseList(result: unknown): DirEntry[] | undefined {
  if (!isRecord(result) || !Array.isArray(result.entries)) {
    return undefined;
  }
  const entries: DirEntry[] = [];
  for (const entry of result.entries) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !isKind(entry.kind)) {
      return undefined;
    }
    entries.push({ name: entry.name, kind: entry.kind });
  }
  return entries;
}

function parseGlob(result: unknown): string[] | undefined {
  if (!isRecord(result) || !Array.isArray(result.matches)) {
    return undefined;
  }
  const matches = result.matches.filter((m): m is string => typeof m === 'string');
  return matches.length === result.matches.length ? matches : undefined;
}

function parseGrep(result: unknown): FsGrepResult | undefined {
  if (
    !isRecord(result) ||
    typeof result.path !== 'string' ||
    typeof result.isDirectory !== 'boolean' ||
    !Array.isArray(result.lines) ||
    !isCount(result.matchCount) ||
    typeof result.limitReached !== 'boolean'
  ) {
    return undefined;
  }
  const lines: GrepLine[] = [];
  for (const line of result.lines) {
    if (
      !isRecord(line) ||
      typeof line.path !== 'string' ||
      !isCount(line.lineNumber) ||
      typeof line.text !== 'string' ||
      typeof line.isMatch !== 'boolean'
    ) {
      return undefined;
    }
    lines.push({
      path: line.path,
      lineNumber: line.lineNumber,
      text: line.text,
      isMatch: line.isMatch,
    });
  }
  return {
    path: result.path,
    isDirectory: result.isDirectory,
    lines,
    matchCount: result.matchCount,
    limitReached: result.limitReached,
  };
}

function parseOutcome(result: unknown): CommandOutcome | undefined {
  if (!isRecord(result) || typeof result.killed !== 'boolean') {
    return undefined;
  }
  const integer = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
  return {
    exitCode: integer(result.exitCode),
    signal: integer(result.signal),
    killed: result.killed,
  };
}
