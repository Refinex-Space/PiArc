// PiArc's stdio transport for MCP servers (MCP 2025-11-25, "Transports: stdio"): the server
// reads JSON-RPC messages from stdin and writes them to stdout, one per line, UTF-8, with no
// newline inside a message; stderr is for logs. Written for PiArc instead of pi-mcp's
// `StdioTransport` because that one starts every server in a process group of its own
// (`detached`), which Core's cleanup of the Agent Host's process group would not reach when
// the Agent Host is killed (architecture section 5.6, T36). Here the server stays in the Agent
// Host's process group (macOS) and Job Object (Windows), so it ends with the Agent Host.
//
// Closing follows the specification's shutdown: close the server's stdin, wait for it to exit,
// then SIGTERM, then SIGKILL. On macOS the server's descendants (an `npx` wrapper's node, for
// example) are collected first so the signals reach them too; on Windows `taskkill /T` ends the
// tree.
import { execFile, type ChildProcess } from 'node:child_process';

import crossSpawn from 'cross-spawn';
import {
  McpConnectionClosedError,
  parseJsonRpcMessage,
  type JsonRpcMessage,
  type McpTransport,
  type McpTransportCloseListener,
  type McpTransportErrorListener,
  type McpTransportMessageListener,
} from '@earendil-works/pi-mcp';

/** One message line at most (the specification sets no limit; pi-mcp uses the same). */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
/** Characters of stderr kept for error reports. */
const STDERR_TAIL_CHARS = 4_000;

export interface StdioServerOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The whole environment of the server (nothing is inherited from the Agent Host). */
  readonly env: Readonly<Record<string, string>>;
  /** After stdin closes, how long the server gets to exit on its own. */
  readonly stdinGraceMs?: number;
  /** After SIGTERM, how long before SIGKILL. */
  readonly termGraceMs?: number;
}

/** Splits stdout into lines and parses each as a JSON-RPC message. */
class LineFramer {
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  #skipping = false;

  constructor(
    readonly onMessage: (message: JsonRpcMessage) => void,
    readonly onError: (error: Error) => void,
  ) {}

  push(chunk: Buffer): void {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline < 0) {
        this.#keep(chunk.subarray(start));
        return;
      }
      const tail = chunk.subarray(start, newline);
      start = newline + 1;
      if (this.#skipping) {
        // The rest of a line that was too long.
        this.#skipping = false;
        continue;
      }
      const line =
        this.#pending.length === 0
          ? tail
          : Buffer.concat([...this.#pending, tail], this.#pendingBytes + tail.length);
      this.#pending = [];
      this.#pendingBytes = 0;
      this.#line(line);
    }
  }

  /** Whether an incomplete line is left when stdout ends. */
  get incomplete(): boolean {
    return this.#pendingBytes > 0 && Buffer.concat(this.#pending).toString('utf8').trim() !== '';
  }

  #keep(bytes: Buffer): void {
    if (bytes.length === 0 || this.#skipping) return;
    this.#pending.push(Buffer.from(bytes));
    this.#pendingBytes += bytes.length;
    if (this.#pendingBytes > MAX_MESSAGE_BYTES) {
      this.#pending = [];
      this.#pendingBytes = 0;
      this.#skipping = true;
      this.onError(new Error(`an MCP message is longer than ${String(MAX_MESSAGE_BYTES)} bytes`));
    }
  }

  #line(line: Buffer): void {
    if (line.length > MAX_MESSAGE_BYTES) {
      this.onError(new Error(`an MCP message is longer than ${String(MAX_MESSAGE_BYTES)} bytes`));
      return;
    }
    // A server on Windows may end lines with CRLF.
    const text = line.toString('utf8').replace(/\r$/, '');
    if (text.trim() === '') return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      this.onError(new Error(`the server wrote a line that is not JSON: ${text.slice(0, 200)}`));
      return;
    }
    try {
      this.onMessage(parseJsonRpcMessage(value));
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/** The process ids below `root` (macOS and Linux), from `ps`; empty when `ps` fails. */
async function descendants(root: number): Promise<number[]> {
  const table = await new Promise<string>((resolve) => {
    execFile('/bin/ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { timeout: 2_000 }, (error, out) => {
      resolve(error === null ? out : '');
    });
  });
  const children = new Map<number, number[]>();
  for (const line of table.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined || !Number.isInteger(pid)) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found: number[] = [];
  const queue = [root];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of children.get(next) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

function signal(pids: readonly number[], name: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, name);
    } catch {
      // Already gone.
    }
  }
}

/** A local MCP server process speaking MCP on stdin and stdout. */
export class StdioServerTransport implements McpTransport {
  readonly #options: StdioServerOptions;
  readonly #messages = new Set<McpTransportMessageListener>();
  readonly #errors = new Set<McpTransportErrorListener>();
  readonly #closes = new Set<McpTransportCloseListener>();
  #child: ChildProcess | undefined;
  #exited: Promise<void> = Promise.resolve();
  #closing = false;
  #closeEmitted = false;
  #stderr = '';

  constructor(options: StdioServerOptions) {
    this.#options = options;
  }

  /** The server's process id once started. */
  get pid(): number | undefined {
    return this.#child?.pid;
  }

  /** The end of what the server wrote to stderr. */
  get stderr(): string {
    return this.#stderr;
  }

  async start(): Promise<void> {
    if (this.#child !== undefined) throw new Error('the MCP server was already started');
    if (this.#closing) throw new McpConnectionClosedError();
    const o = this.#options;
    // cross-spawn runs `.cmd` shims such as `npx.cmd` through cmd.exe with safe quoting on
    // Windows and is `spawn` elsewhere. Not detached: the server stays in the Agent Host's
    // process group (macOS) and Job Object (Windows).
    const child = crossSpawn(o.command, [...o.args], {
      cwd: o.cwd,
      env: { ...o.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#child = child;
    this.#exited = new Promise((resolve) =>
      child.once('close', () => {
        resolve();
      }),
    );
    const framer = new LineFramer(
      (message) => {
        for (const listener of this.#messages) listener(message);
      },
      (error) => {
        this.#emitError(error);
      },
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      framer.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
    });
    for (const stream of [child.stdout, child.stderr, child.stdin]) {
      stream?.on('error', (error: Error) => {
        if (!this.#closing) this.#emitError(error);
      });
    }
    child.once('close', () => {
      if (framer.incomplete) {
        this.#emitError(new Error('the MCP server exited in the middle of a message'));
      }
      this.#emitClose();
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => {
        resolve();
      });
      child.once('error', reject);
    });
    child.on('error', (error) => {
      if (!this.#closing) this.#emitError(error);
    });
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const stdin = this.#child?.stdin;
    if (this.#closing || !stdin?.writable) throw new McpConnectionClosedError();
    // JSON.stringify escapes newlines inside strings: one message, one line.
    const line = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      stdin.write(line, (error) => {
        if (error == null) resolve();
        else reject(error);
      });
    });
  }

  async close(): Promise<void> {
    if (this.#closing) return this.#exited;
    this.#closing = true;
    const child = this.#child;
    if (child === undefined) {
      this.#emitClose();
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      this.#emitClose();
      return;
    }
    const exited = this.#exited;
    const within = (ms: number): Promise<boolean> =>
      Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => {
            resolve(false);
          }, ms).unref(),
        ),
      ]);
    child.stdin?.end();
    if (await within(this.#options.stdinGraceMs ?? 1_000)) return;
    const pid = child.pid;
    if (pid === undefined) return;
    if (process.platform === 'win32') {
      // No signals: end the tree (cmd.exe of a `.cmd` shim, and what it started).
      execFile(
        'taskkill',
        ['/pid', String(pid), '/T', '/F'],
        { windowsHide: true },
        () => undefined,
      );
      await within(this.#options.termGraceMs ?? 2_000);
      return;
    }
    const tree = [pid, ...(await descendants(pid))];
    signal(tree, 'SIGTERM');
    if (await within(this.#options.termGraceMs ?? 2_000)) {
      // The wrapper exited; whatever it left behind gets the kill too.
      signal(tree.slice(1), 'SIGKILL');
      return;
    }
    signal(tree, 'SIGKILL');
    await exited;
  }

  onMessage(listener: McpTransportMessageListener): () => void {
    this.#messages.add(listener);
    return () => this.#messages.delete(listener);
  }

  onError(listener: McpTransportErrorListener): () => void {
    this.#errors.add(listener);
    return () => this.#errors.delete(listener);
  }

  onClose(listener: McpTransportCloseListener): () => void {
    this.#closes.add(listener);
    return () => this.#closes.delete(listener);
  }

  #emitError(error: Error): void {
    for (const listener of this.#errors) listener(error);
  }

  #emitClose(): void {
    if (this.#closeEmitted) return;
    this.#closeEmitted = true;
    for (const listener of this.#closes) listener();
  }
}
