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
  BrowserImage,
  BrowserRunResult,
  BrowserScriptError,
  MemoryApplyParams,
  MemoryApplyResult,
  MemoryStatusResult,
  WebFetchResult,
  WebSearchBackendResult,
  WebSearchResult,
  WebSearchSource,
  BlobRef,
  TaskKind,
  TaskStarted,
  TaskStatus,
  CommandOutcome,
  CommandOutput,
  CwdReset,
  DirEntry,
  ExecShell,
  FileDiff,
  FileKind,
  FileStat,
  FsGrepResult,
  FsPdfResult,
  GrepLine,
  LineEndings,
  ReadRange,
  SandboxReport,
} from '@piarc/protocol';

import { parseMemoryFile } from '../harness/memory-io.js';
import { AhpError } from '../protocol/errors.js';
import { wellFormedJson } from '../protocol/well-formed.js';
import type { CoreBridge } from '../runtime/core-bridge.js';
import type { CanonicalTool } from './profile.js';
import { parseSandboxReport } from './sandbox-report.js';

/** The tool call a request serves; sent as `origin`. */
export interface Origin {
  readonly tool: CanonicalTool;
  readonly toolCallId: string;
}

/** Largest UTF-16 string sent in one `fs/write` or `fs/spill`; well below the 8 MiB frame
 * limit even when every code unit needs a `\uXXXX` escape. Longer texts go as one upload in
 * pieces of this size, which Core writes once the last one arrives. */
export const WRITE_CHUNK = 256 * 1024;

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

/** One `exec/output` chunk: its stream, its text and the bytes of the stream Core left out
 * before it (the live view skips output when the Agent Host reads slower than the command
 * writes; the result's output is complete). */
export type OutputListener = (stream: 'stdout' | 'stderr', data: string, skipped: number) => void;

/** Routes `exec/output` notifications to the command that produced them. */
export class ExecOutputRouter {
  readonly #listeners = new Map<string, OutputListener>();

  listen(requestId: string, listener: OutputListener): () => void {
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
    const skipped =
      typeof params.skipped === 'number' && Number.isSafeInteger(params.skipped)
        ? params.skipped
        : 0;
    const listener = this.#listeners.get(params.requestId);
    listener?.(params.stream, params.data, skipped);
    return listener !== undefined;
  }
}

/** How a command ended, as Core reports it (`exec/run`'s result, validated). */
export interface CommandResult {
  readonly exitCode: number | undefined;
  readonly signal: number | undefined;
  /** `exec/kill`, an interruption or the connection's end stopped it. */
  readonly killed: boolean;
  readonly timedOut: boolean;
  /** The timeout applied, and the longer one asked for when Core cut it. */
  readonly timeoutMs: number | undefined;
  readonly requestedTimeoutMs: number | undefined;
  readonly durationMs: number | undefined;
  /** Success judged by what the exit code means; undefined from a Core without T17. */
  readonly outcome: CommandOutcome | undefined;
  readonly meaning: string | undefined;
  readonly cwd: string | undefined;
  readonly cwdReset: CwdReset | undefined;
  readonly output: CommandOutput | undefined;
  /** The background task it became (T32): asked for, or moved there by its timeout. */
  readonly task: TaskStarted | undefined;
  /** Present when it ran in the sandbox (T39): what the sandbox refused. */
  readonly sandbox: SandboxReport | undefined;
}

/** A Monitor started in Core (`exec/monitor`, T32). */
export interface MonitorStarted {
  readonly taskId: string;
  readonly outputPath: string;
  readonly timeoutMs: number;
  readonly requestedTimeoutMs: number | undefined;
}

/** A task KillShell stopped (`exec/background/kill`, T32). */
export interface TaskStopped {
  readonly taskId: string;
  readonly kind: TaskKind;
  readonly status: TaskStatus;
  readonly title: string;
  readonly outputPath: string | undefined;
  /** Whether this request stopped it; false when it had already ended. */
  readonly stopped: boolean;
  readonly tail: string;
}

/** A command for `exec/run`. */
export interface CommandRequest {
  readonly command: string;
  /** `bash` when absent. */
  readonly shell?: ExecShell;
  /** Core's default when absent; Core cuts it to its maximum. */
  readonly timeoutMs?: number;
  /** Runs there and does not move the session's shell directory; the session's when absent. */
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  /** Runs as a background task and answers at once (T32). */
  readonly background?: boolean;
  /** Runs in a PiArc terminal whose screen the model reads (T33, ADR-0050); with `background`. */
  readonly terminal?: boolean;
}

/** Which shells the session's command tools can use. */
export interface Shells {
  readonly bash: boolean;
  readonly powershell: boolean;
}

export interface CoreIoOptions {
  readonly bridge: CoreBridge;
  readonly sessionId: string;
  readonly execOutput: ExecOutputRouter;
  /** Reads a blob Core made (`fs/read` in blob mode). */
  readonly readBlob: (blob: BlobRef) => Promise<Buffer>;
  /** The session's running turn: its checkpoint keeps what a write replaces (T28). */
  readonly turn?: () => string | undefined;
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

  /** The content of a blob Core made (an attachment, a file read in blob mode). */
  async readBlob(blob: BlobRef): Promise<Buffer> {
    return this.#options.readBlob(blob);
  }

  /**
   * Inspects a path. With `read`, the `Read` tool reads the file now with that range: Core
   * stages it until completeRead; unchanged means the previous successful read still applies.
   */
  async stat(
    path: string,
    origin: Origin,
    detectImage = false,
    read?: ReadRange,
    completeRead = false,
  ): Promise<FileStat> {
    return this.#request(
      'fs/stat',
      {
        path,
        origin,
        ...(detectImage ? { detectImage } : {}),
        ...(read ? { read } : {}),
        ...(completeRead ? { completeRead: true } : {}),
      },
      parseStat,
    );
  }

  /**
   * Reads the file range by range, each piece whole characters (decoded from the file's
   * encoding by Core); stops early when `signal` aborts. With `requireFresh` Core first checks
   * that the session read the file and it has not changed since (`Edit`).
   */
  async *readChunks(
    path: string,
    origin: Origin,
    signal?: AbortSignal,
    requireFresh = false,
  ): AsyncGenerator<Buffer> {
    let offset = 0;
    for (;;) {
      signal?.throwIfAborted();
      const fresh = requireFresh && offset === 0 ? { requireFresh: true } : {};
      const chunk = await this.#request(
        'fs/read',
        { path, origin, offset, ...fresh },
        parseRead,
        signal,
      );
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
  async readText(
    path: string,
    origin: Origin,
    signal?: AbortSignal,
    requireFresh = false,
  ): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const part of this.readChunks(path, origin, signal, requireFresh)) {
      parts.push(part);
    }
    return Buffer.concat(parts);
  }

  /**
   * The whole text of a file the session already read or wrote, without a tool call: what a
   * compaction gives back (T27); undefined once it is longer than `maxChars` UTF-16 code units.
   * Core refuses other files and files that need approval.
   */
  async restoreText(
    path: string,
    maxChars: number,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const parts: string[] = [];
    let length = 0;
    let offset = 0;
    for (;;) {
      signal?.throwIfAborted();
      const chunk = await this.#request(
        'fs/read',
        { path, restore: true, offset },
        parseRead,
        signal,
      );
      if (chunk.text !== undefined) {
        parts.push(chunk.text);
        length += chunk.text.length;
        if (length > maxChars) return undefined;
      }
      offset += chunk.bytesRead;
      if (chunk.eof || chunk.bytesRead === 0) return parts.join('');
    }
  }

  /** The file's exact bytes, through a blob Core copies (ADR-0009 rule 8). */
  async readBytes(path: string, origin: Origin): Promise<Buffer> {
    const result = await this.#request('fs/read', { path, origin, mode: 'blob' }, parseRead);
    if (result.blob === undefined) {
      throw new AhpError('invalidRequest', 'fs/read in blob mode returned no blob');
    }
    return this.#options.readBlob(result.blob);
  }

  /**
   * Writes `content` as the file's new text and returns the change Core made. Core checks that
   * an existing file was read by this session and is unchanged since, keeps its encoding and
   * byte order mark, with `lineEndings: 'matchFile'` its line ending style, and replaces it
   * atomically; a large text goes as one upload in pieces.
   */
  async write(
    path: string,
    content: string,
    origin: Origin,
    lineEndings: LineEndings = 'asWritten',
  ): Promise<FileDiff | undefined> {
    const params: Record<string, unknown> = { path, origin };
    if (lineEndings !== 'asWritten') params.lineEndings = lineEndings;
    const turnId = this.#options.turn?.();
    if (turnId !== undefined) params.turnId = turnId;
    const result = await this.#upload('fs/write', params, content, parseWrite);
    return result.diff;
  }

  /**
   * Keeps a tool result too long for the model's context in the session's temporary directory
   * (`fs/spill`); returns the path to give the model.
   */
  async spill(name: string, content: string, origin?: Origin): Promise<string> {
    const params: Record<string, unknown> = { name, ...(origin ? { origin } : {}) };
    const result = await this.#upload('fs/spill', params, content, parseSpill);
    return result.path;
  }

  /** The text of a PDF's pages (`pages`: `3`, `1-5`, `10-`; all pages of a small document). */
  async pdf(path: string, pages: string | undefined, origin?: Origin): Promise<FsPdfResult> {
    return this.#request(
      'fs/pdf',
      { path, ...(origin ? { origin } : {}), ...(pages === undefined ? {} : { pages }) },
      parsePdf,
    );
  }

  /** Sends `content` with `params` in one request, or as an upload in pieces. */
  async #upload<T>(
    method: string,
    params: Record<string, unknown>,
    content: string,
    parse: (result: unknown) => T | undefined,
  ): Promise<T> {
    if (content.length <= WRITE_CHUNK) {
      return this.#request(method, { ...params, content }, parse);
    }
    const id = `upload-${randomUUID()}`;
    let start = 0;
    for (;;) {
      const end = uploadChunkEnd(content, start);
      const last = end >= content.length;
      const result = await this.#request(
        method,
        { ...params, content: content.slice(start, end), upload: { id, last } },
        parse,
      );
      if (last) {
        return result;
      }
      start = end;
    }
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
   * Fetches `url` for an approved WebFetch call (`web/fetch`, T29). Core's message for a refused
   * or failed fetch is written for the model and comes back without the bridge's prefix.
   */
  async webFetch(url: string, origin: Origin, signal?: AbortSignal): Promise<WebFetchResult> {
    try {
      // Core bounds the fetch (its total timeout); the request waits for it.
      return await this.#send('web/fetch', { url, origin }, parseWebFetch, signal, null);
    } catch (error) {
      const prefix = 'web/fetch failed: ';
      if (error instanceof AhpError && error.message.startsWith(prefix)) {
        throw new AhpError(error.kind, error.message.slice(prefix.length), {
          retryable: error.retryable,
          details: error.details,
        });
      }
      throw error;
    }
  }

  /** Which shells Core found for this session's command tools (`exec/shells`). */
  async shells(): Promise<Shells> {
    return this.#request('exec/shells', {}, parseShells);
  }

  /**
   * Starts `command` in Core and streams its output to `onData`. `outcome` settles once the
   * command has ended (Core applies the timeout); `kill` stops it (the caller's abort).
   */
  run(
    command: CommandRequest,
    onData: OutputListener,
    origin: Origin,
  ): { outcome: Promise<CommandResult>; kill: () => Promise<void> } {
    const requestId = `exec-${randomUUID()}`;
    const stopListening = this.#options.execOutput.listen(requestId, onData);
    const params: Record<string, unknown> = { requestId, command: command.command, origin };
    if (command.shell !== undefined) params.shell = command.shell;
    if (command.timeoutMs !== undefined) params.timeoutMs = command.timeoutMs;
    if (command.cwd !== undefined) params.cwd = command.cwd;
    if (command.env !== undefined) params.env = command.env;
    if (command.background === true) params.background = true;
    if (command.terminal === true) params.terminal = true;
    const outcome = this.#request(
      'exec/run',
      params,
      parseRunResult,
      undefined,
      // Core ends the command (timeout, kill); the request waits as long as it runs.
      null,
    ).finally(stopListening);
    const kill = async (): Promise<void> => {
      await this.#request('exec/kill', { requestId }, parseObject);
    };
    return { outcome, kill };
  }

  /** Starts a Monitor's command in Core (`exec/monitor`); its new lines come as reminders. */
  async monitor(
    command: string,
    description: string,
    timeoutMs: number | undefined,
    origin: Origin,
  ): Promise<MonitorStarted> {
    const params: Record<string, unknown> = {
      requestId: `monitor-${randomUUID()}`,
      command,
      description,
      origin,
    };
    if (timeoutMs !== undefined) params.timeoutMs = timeoutMs;
    return this.#request('exec/monitor', params, parseMonitorStarted);
  }

  /** Stops a background task of this session or its subagents (`exec/background/kill`). */
  async killTask(taskId: string): Promise<TaskStopped> {
    // Stopping waits for the process tree (or the subagent) to end.
    return this.#request('exec/background/kill', { taskId }, parseTaskStopped, undefined, null);
  }

  /**
   * Searches with the user's third-party backend for an approved WebSearch call (`web/search`,
   * T38). Core's message for a refused or failed search is written for the model.
   */
  async webSearch(
    query: string,
    filters: {
      readonly allowedDomains: readonly string[];
      readonly blockedDomains: readonly string[];
    },
    origin: Origin,
    signal?: AbortSignal,
  ): Promise<WebSearchResult> {
    const params = {
      query,
      origin,
      ...(filters.allowedDomains.length > 0 ? { allowedDomains: filters.allowedDomains } : {}),
      ...(filters.blockedDomains.length > 0 ? { blockedDomains: filters.blockedDomains } : {}),
    };
    try {
      // Core bounds the request (WebFetch's total timeout); the call waits for it.
      return await this.#send('web/search', params, parseWebSearch, signal, null);
    } catch (error) {
      const prefix = 'web/search failed: ';
      if (error instanceof AhpError && error.message.startsWith(prefix)) {
        throw new AhpError(error.kind, error.message.slice(prefix.length), {
          retryable: error.retryable,
          details: error.details,
        });
      }
      throw error;
    }
  }

  /**
   * Runs an approved `Browser` call's script in the desktop app's browser (`browser/run`,
   * ADR-0089). Core bounds the run (`timeoutMs`, cancel on interrupt); the request waits for it.
   * Core's message for a refused run is written for the model.
   */
  async browserRun(
    script: string,
    timeoutMs: number | undefined,
    origin: Origin,
    signal?: AbortSignal,
  ): Promise<BrowserRunResult> {
    const params = { script, origin, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
    return this.#request('browser/run', params, parseBrowserRun, signal, null);
  }

  /** What auto memory offers this session (`memory/status`, T47). */
  async memoryStatus(signal?: AbortSignal): Promise<MemoryStatusResult> {
    return this.#request('memory/status', {}, parseMemoryStatus, signal);
  }

  /**
   * Runs one `Memory` call in Core (`memory/apply`, T47): Core consumes the call's permission
   * (none for a `restore` read after a compaction).
   */
  async memoryApply(
    params: Omit<MemoryApplyParams, 'sessionId'>,
    signal?: AbortSignal,
  ): Promise<MemoryApplyResult> {
    return this.#request('memory/apply', { ...params }, parseMemoryApply, signal);
  }

  /** The third-party search backend Core can use now (`web/searchBackend`, T38). */
  async searchBackend(signal?: AbortSignal): Promise<WebSearchBackendResult> {
    return this.#options.bridge.requestTyped('web/searchBackend', {}, parseSearchBackend, {
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async #request<T>(
    method: string,
    params: Record<string, unknown>,
    parse: (result: unknown) => T | undefined,
    signal?: AbortSignal,
    timeoutMs?: number | null,
  ): Promise<T> {
    try {
      return await this.#send(method, params, parse, signal, timeoutMs);
    } catch (error) {
      throw forModel(error, method);
    }
  }

  async #send<T>(
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

/** Core errors whose message is written for the model (what happened, what to do next). */
const FOR_MODEL = new Set<string>([
  'fileNotRead',
  'fileModified',
  'permissionDenied',
  'unencodableText',
  'invalidParams',
]);

/** `error` with the bridge's `<method> failed: ` prefix removed when Core wrote the message for
 * the model; other errors are returned as they are. */
function forModel(error: unknown, method: string): unknown {
  const prefix = `${method} failed: `;
  if (
    !(error instanceof AhpError) ||
    !FOR_MODEL.has(error.kind) ||
    !error.message.startsWith(prefix)
  ) {
    return error;
  }
  return new AhpError(error.kind, error.message.slice(prefix.length), {
    retryable: error.retryable,
    details: error.details,
  });
}

/** Exclusive end of one frame-sized UTF-16 slice, never between a surrogate pair. */
export function uploadChunkEnd(content: string, start: number): number {
  const end = Math.min(start + WRITE_CHUNK, content.length);
  return end < content.length && isHighSurrogate(content.charCodeAt(end - 1)) ? end - 1 : end;
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
  if (typeof result.unchanged === 'boolean') stat.unchanged = result.unchanged;
  return stat;
}

function parseWrite(result: unknown): { diff: FileDiff | undefined } | undefined {
  if (!isRecord(result) || typeof result.path !== 'string' || !isCount(result.bytesWritten)) {
    return undefined;
  }
  if (result.staged === true || result.diff === undefined) {
    return { diff: undefined };
  }
  const diff = parseDiff(result.diff);
  return diff === undefined ? undefined : { diff };
}

/** A `FileDiff` from Core: checked to the depth the projection relies on. */
export function parseDiff(value: unknown): FileDiff | undefined {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    !isCount(value.added) ||
    !isCount(value.removed) ||
    typeof value.unified !== 'string' ||
    !Array.isArray(value.hunks) ||
    !value.hunks.every(isHunk)
  ) {
    return undefined;
  }
  // Checked member by member above; the hunks' lines by `isHunk`.
  return value as unknown as FileDiff;
}

function isHunk(value: unknown): boolean {
  return (
    isRecord(value) &&
    isCount(value.oldStart) &&
    isCount(value.oldLines) &&
    isCount(value.newStart) &&
    isCount(value.newLines) &&
    Array.isArray(value.lines) &&
    value.lines.every(
      (line) =>
        isRecord(line) &&
        typeof line.text === 'string' &&
        (line.kind === 'context' || line.kind === 'added' || line.kind === 'removed'),
    )
  );
}

function parseSpill(result: unknown): { path: string } | undefined {
  if (!isRecord(result) || typeof result.path !== 'string') {
    return undefined;
  }
  return { path: result.path };
}

function parsePdf(result: unknown): FsPdfResult | undefined {
  if (
    !isRecord(result) ||
    typeof result.path !== 'string' ||
    !isCount(result.pageCount) ||
    !Array.isArray(result.pages)
  ) {
    return undefined;
  }
  const pages: FsPdfResult['pages'] = [];
  for (const page of result.pages) {
    if (!isRecord(page) || !isCount(page.number) || typeof page.text !== 'string') {
      return undefined;
    }
    pages.push({ number: page.number, text: page.text });
  }
  return { path: result.path, pageCount: result.pageCount, pages };
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

function parseShells(result: unknown): Shells | undefined {
  return isRecord(result) &&
    typeof result.bash === 'boolean' &&
    typeof result.powershell === 'boolean'
    ? { bash: result.bash, powershell: result.powershell }
    : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseRunResult(result: unknown): CommandResult | undefined {
  if (!isRecord(result) || typeof result.killed !== 'boolean') {
    return undefined;
  }
  const timeout = isRecord(result.timeout) ? result.timeout : {};
  const outcome = result.outcome;
  return {
    exitCode: integer(result.exitCode),
    signal: integer(result.signal),
    killed: result.killed,
    timedOut: result.timedOut === true,
    timeoutMs: integer(timeout.ms),
    requestedTimeoutMs: integer(timeout.requestedMs),
    durationMs: integer(result.durationMs),
    outcome: outcome === 'success' || outcome === 'failure' ? outcome : undefined,
    meaning: text(result.meaning),
    cwd: text(result.cwd),
    cwdReset: parseCwdReset(result.cwdReset),
    output: parseOutput(result.output),
    task: parseTaskStarted(result.task),
    sandbox: parseSandboxReport(result.sandbox),
  };
}

function parseTaskStarted(value: unknown): TaskStarted | undefined {
  if (
    !isRecord(value) ||
    typeof value.taskId !== 'string' ||
    typeof value.outputPath !== 'string' ||
    (value.reason !== 'requested' && value.reason !== 'timeout')
  ) {
    return undefined;
  }
  return { taskId: value.taskId, outputPath: value.outputPath, reason: value.reason };
}

function parseMonitorStarted(value: unknown): MonitorStarted | undefined {
  if (!isRecord(value) || typeof value.taskId !== 'string' || typeof value.outputPath !== 'string')
    return undefined;
  const timeoutMs = integer(value.timeoutMs);
  if (timeoutMs === undefined) return undefined;
  return {
    taskId: value.taskId,
    outputPath: value.outputPath,
    timeoutMs,
    requestedTimeoutMs: integer(value.requestedTimeoutMs),
  };
}

const TASK_KINDS: readonly TaskKind[] = ['command', 'subagent', 'monitor'];
const TASK_STATUSES: readonly TaskStatus[] = [
  'running',
  'completed',
  'failed',
  'killed',
  'interrupted',
];

function isTaskKind(value: unknown): value is TaskKind {
  return TASK_KINDS.some((kind) => kind === value);
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return TASK_STATUSES.some((status) => status === value);
}

function parseTaskStopped(value: unknown): TaskStopped | undefined {
  if (!isRecord(value) || typeof value.stopped !== 'boolean' || typeof value.tail !== 'string')
    return undefined;
  const task = value.task;
  if (
    !isRecord(task) ||
    typeof task.taskId !== 'string' ||
    typeof task.title !== 'string' ||
    !isTaskKind(task.kind) ||
    !isTaskStatus(task.status)
  ) {
    return undefined;
  }
  return {
    taskId: task.taskId,
    kind: task.kind,
    status: task.status,
    title: task.title,
    outputPath: text(task.outputPath),
    stopped: value.stopped,
    tail: value.tail,
  };
}

function parseCwdReset(value: unknown): CwdReset | undefined {
  if (
    !isRecord(value) ||
    typeof value.endedIn !== 'string' ||
    typeof value.resetTo !== 'string' ||
    (value.reason !== 'outsideWorkspace' && value.reason !== 'missing')
  ) {
    return undefined;
  }
  return { endedIn: value.endedIn, resetTo: value.resetTo, reason: value.reason };
}

function parseOutput(value: unknown): CommandOutput | undefined {
  if (!isRecord(value) || typeof value.head !== 'string') {
    return undefined;
  }
  const totalChars = integer(value.totalChars);
  if (totalChars === undefined) {
    return undefined;
  }
  const tail = text(value.tail);
  const omittedChars = integer(value.omittedChars);
  const fullOutputPath = text(value.fullOutputPath);
  const saveError = text(value.saveError);
  return {
    head: value.head,
    totalChars,
    ...(tail === undefined ? {} : { tail }),
    ...(omittedChars === undefined ? {} : { omittedChars }),
    ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
    ...(saveError === undefined ? {} : { saveError }),
  };
}

function parseSource(v: unknown): WebSearchSource | undefined {
  if (!isRecord(v) || typeof v.title !== 'string' || typeof v.url !== 'string') return undefined;
  if (v.snippet !== undefined && typeof v.snippet !== 'string') return undefined;
  return {
    title: v.title,
    url: v.url,
    ...(typeof v.snippet === 'string' && v.snippet !== '' ? { snippet: v.snippet } : {}),
  };
}

/** A `web/search` result, or undefined when it is malformed. */
export function parseWebSearch(v: unknown): WebSearchResult | undefined {
  if (!isRecord(v) || typeof v.backend !== 'string' || !Array.isArray(v.results)) return undefined;
  const results: WebSearchSource[] = [];
  for (const item of v.results as unknown[]) {
    const source = parseSource(item);
    if (source === undefined) return undefined;
    results.push(source);
  }
  return { backend: v.backend, results };
}

/** A `memory/status` result, or undefined when it is malformed. */
export function parseMemoryStatus(v: unknown): MemoryStatusResult | undefined {
  if (!isRecord(v) || typeof v.enabled !== 'boolean' || typeof v.tool !== 'boolean') {
    return undefined;
  }
  return { enabled: v.enabled, tool: v.tool };
}

/** A `memory/apply` result, or undefined when it is malformed. */
export function parseMemoryApply(v: unknown): MemoryApplyResult | undefined {
  if (!isRecord(v) || typeof v.text !== 'string') return undefined;
  const index = v.index == null ? undefined : parseMemoryFile(v.index);
  if (v.index != null && index === undefined) return undefined;
  return {
    text: v.text,
    ...(index === undefined ? {} : { index }),
    ...(v.changed === true ? { changed: true } : {}),
  } satisfies MemoryApplyResult;
}

/** A `web/searchBackend` result, or undefined when it is malformed. */
export function parseSearchBackend(v: unknown): WebSearchBackendResult | undefined {
  if (!isRecord(v)) return undefined;
  const { backend, unavailable } = v;
  if (
    backend != null &&
    (!isRecord(backend) || typeof backend.id !== 'string' || typeof backend.name !== 'string')
  ) {
    return undefined;
  }
  if (unavailable != null && unavailable !== 'notConfigured' && unavailable !== 'noKey') {
    return undefined;
  }
  return {
    ...(isRecord(backend) && typeof backend.id === 'string' && typeof backend.name === 'string'
      ? { backend: { id: backend.id, name: backend.name } }
      : {}),
    ...(unavailable === 'notConfigured' || unavailable === 'noKey' ? { unavailable } : {}),
  };
}

function parseBrowserImage(v: unknown): BrowserImage | undefined {
  if (
    !isRecord(v) ||
    (v.mediaType !== 'image/png' && v.mediaType !== 'image/jpeg') ||
    typeof v.data !== 'string' ||
    typeof v.width !== 'number' ||
    typeof v.height !== 'number'
  ) {
    return undefined;
  }
  if (v.blob != null && (typeof v.blob !== 'string' || !/^[0-9a-f]{64}$/.test(v.blob))) {
    return undefined;
  }
  return {
    mediaType: v.mediaType,
    data: v.data,
    width: v.width,
    height: v.height,
    ...(typeof v.blob === 'string' ? { blob: v.blob } : {}),
  };
}

function parseScriptError(v: unknown): BrowserScriptError | undefined {
  if (!isRecord(v) || typeof v.name !== 'string' || typeof v.message !== 'string') {
    return undefined;
  }
  if (v.code != null && typeof v.code !== 'string') return undefined;
  return {
    name: v.name,
    message: v.message,
    ...(typeof v.code === 'string' ? { code: v.code } : {}),
  };
}

/** A `browser/run` result, or undefined when it is malformed. */
export function parseBrowserRun(v: unknown): BrowserRunResult | undefined {
  if (!isRecord(v) || typeof v.output !== 'string') return undefined;
  const images: BrowserImage[] = [];
  if (v.images != null) {
    if (!Array.isArray(v.images)) return undefined;
    for (const item of v.images as unknown[]) {
      const image = parseBrowserImage(item);
      if (image === undefined) return undefined;
      images.push(image);
    }
  }
  const error = v.error == null ? undefined : parseScriptError(v.error);
  if (v.error != null && error === undefined) return undefined;
  const hosts: string[] = [];
  if (v.blockedHosts != null) {
    if (!Array.isArray(v.blockedHosts)) return undefined;
    for (const host of v.blockedHosts as unknown[]) {
      if (typeof host !== 'string') return undefined;
      hosts.push(host);
    }
  }
  if (v.spill != null && typeof v.spill !== 'string') return undefined;
  return {
    output: v.output,
    ...(v.truncated === true ? { truncated: true } : {}),
    ...(typeof v.spill === 'string' ? { spill: v.spill } : {}),
    ...(images.length > 0 ? { images } : {}),
    ...(error === undefined ? {} : { error }),
    ...(hosts.length > 0 ? { blockedHosts: hosts } : {}),
  };
}

/** A `web/fetch` result, or undefined when it is malformed. */
export function parseWebFetch(v: unknown): WebFetchResult | undefined {
  if (!isRecord(v)) return undefined;
  const redirect = v.redirect;
  if (
    typeof v.url !== 'string' ||
    typeof v.status !== 'number' ||
    typeof v.content !== 'string' ||
    (v.format !== 'markdown' && v.format !== 'text') ||
    typeof v.bytes !== 'number' ||
    typeof v.bodyTruncated !== 'boolean' ||
    typeof v.totalChars !== 'number' ||
    typeof v.contentTruncated !== 'boolean'
  ) {
    return undefined;
  }
  let target: { url: string; status: number } | undefined;
  if (redirect != null) {
    if (
      !isRecord(redirect) ||
      typeof redirect.url !== 'string' ||
      typeof redirect.status !== 'number'
    )
      return undefined;
    target = { url: redirect.url, status: redirect.status };
  }
  return {
    url: v.url,
    status: v.status,
    content: v.content,
    format: v.format,
    bytes: v.bytes,
    bodyTruncated: v.bodyTruncated,
    totalChars: v.totalChars,
    contentTruncated: v.contentTruncated,
    ...(typeof v.contentType === 'string' ? { contentType: v.contentType } : {}),
    ...(target === undefined ? {} : { redirect: target }),
  };
}
