#!/usr/bin/env node
// A stdio MCP server for the S6 tests (T12). The Agent Host of a packaged app starts it with
// the bundled `npx` (`npx -y <this directory>`), so it runs on whatever `node` comes first on
// the Agent Host's PATH and under the Agent Host's Seatbelt profile. Its one tool, `probe`,
// reports what that environment allows: which node runs it, worker_threads, git, writing
// inside and outside the writable directories, and loading a native module.
// Newline-delimited JSON-RPC on stdin/stdout, as MCP's stdio transport.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Worker } from 'node:worker_threads';

/**
 * @param {unknown} id
 * @param {unknown} result
 */
function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Runs `fn` and reports `ok` or the error's code (or message).
 * @param {() => unknown} fn
 */
function attempt(fn) {
  try {
    const value = fn();
    return { ok: true, value: typeof value === 'string' ? value.trim() : value };
  } catch (error) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
    return { ok: false, error: code ?? (error instanceof Error ? error.message : String(error)) };
  }
}

/**
 * Round trip through a worker thread.
 * @returns {Promise<{ ok: boolean, value?: unknown, error?: string }>}
 */
function workerRoundTrip() {
  return new Promise((resolve) => {
    const worker = new Worker(
      'const { parentPort } = require("node:worker_threads"); parentPort.on("message", (n) => parentPort.postMessage(n * 2));',
      { eval: true },
    );
    worker.once('message', (/** @type {unknown} */ value) => {
      void worker.terminate();
      resolve({ ok: value === 42, value });
    });
    worker.once('error', (/** @type {Error} */ error) => {
      resolve({ ok: false, error: error.message });
    });
    worker.postMessage(21);
  });
}

/**
 * @param {Record<string, unknown>} args
 */
async function probe(args) {
  const text = (/** @type {string} */ key) => (typeof args[key] === 'string' ? args[key] : '');
  const workspace = text('workspace');
  return {
    execPath: process.execPath,
    nodeVersion: process.version,
    pid: process.pid,
    ppid: process.ppid,
    env: {
      tmpdir: process.env.TMPDIR ?? null,
      npmCache: process.env.npm_config_cache ?? null,
      piPackageDir: process.env.PI_PACKAGE_DIR ?? null,
    },
    worker: await workerRoundTrip(),
    gitVersion: attempt(() => execFileSync('git', ['--version'], { encoding: 'utf8' })),
    gitStatus: attempt(() =>
      execFileSync('git', ['-C', workspace, 'status', '--porcelain'], { encoding: 'utf8' }),
    ),
    writeInside: attempt(() => {
      writeFileSync(text('inside'), 'written by the MCP probe\n');
    }),
    writeOutside: attempt(() => {
      writeFileSync(text('outside'), 'must not be written\n');
    }),
    nativeModule: attempt(() => {
      /** @type {{ exports: unknown }} */
      const module = { exports: {} };
      process.dlopen(module, text('native'));
      return isRecord(module.exports) ? Object.keys(module.exports).length : 0;
    }),
  };
}

for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() === '') {
    continue;
  }
  /** @type {unknown} */
  const message = JSON.parse(line);
  if (!isRecord(message) || typeof message.method !== 'string' || !('id' in message)) {
    continue;
  }
  const params = isRecord(message.params) ? message.params : {};
  switch (message.method) {
    case 'initialize':
      reply(message.id, {
        protocolVersion:
          typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'probe', version: '0.0.0' },
      });
      break;
    case 'ping':
      reply(message.id, {});
      break;
    case 'tools/list':
      reply(message.id, {
        tools: [
          {
            name: 'probe',
            description:
              'Reports how this server runs: node, workers, git, writes, native modules.',
            inputSchema: {
              type: 'object',
              properties: {
                workspace: { type: 'string' },
                inside: { type: 'string' },
                outside: { type: 'string' },
                native: { type: 'string' },
              },
              required: ['workspace', 'inside', 'outside', 'native'],
            },
          },
        ],
      });
      break;
    case 'tools/call': {
      const args = isRecord(params.arguments) ? params.arguments : {};
      reply(message.id, {
        content: [{ type: 'text', text: JSON.stringify(await probe(args)) }],
      });
      break;
    }
    default:
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } })}\n`,
      );
  }
}
