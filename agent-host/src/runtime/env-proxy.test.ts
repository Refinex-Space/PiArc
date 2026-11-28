// ADR-0082: with the proxy variables Core sets, the Agent Host's `fetch` goes through the proxy
// even after Pi is loaded (whose npm undici replaces Node's proxy-aware dispatcher on some Node
// versions). The child process loads the modules in the entry's order: env-proxy, then Pi.
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { isObject } from './items.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const envProxy = pathToFileURL(path.join(here, 'env-proxy.ts')).href;

/** The child: loads env-proxy, then Pi, restores, fetches `url` and prints the outcome. */
const CHILD = `
import { restoreEnvProxy } from ${JSON.stringify(envProxy)};
await import('@earendil-works/pi-coding-agent');
const restored = restoreEnvProxy();
let outcome;
try {
  const response = await fetch(process.argv[1], { signal: AbortSignal.timeout(10_000) });
  outcome = { status: response.status, body: await response.text() };
} catch (error) {
  outcome = { error: String(error?.cause?.code ?? error) };
}
console.log(JSON.stringify({ restored, ...outcome }));
`;

function runChild(url: string, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, url], {
      cwd: path.join(here, '..', '..'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.on('error', reject);
    child.on('close', () => {
      const line = out.trim().split('\n').at(-1) ?? '';
      try {
        const parsed: unknown = JSON.parse(line);
        if (isObject(parsed)) {
          resolve(parsed);
          return;
        }
      } catch {
        // Reported below.
      }
      reject(new Error(`no outcome: ${out}\n${err}`));
    });
  });
}

/** The child's environment as Core starts an Agent Host: no inherited proxy variables. */
function hostEnv(proxy?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(https?|all|no)_proxy$/iu.test(name) || name === 'NODE_USE_ENV_PROXY') {
      env[name] = undefined;
    }
  }
  if (proxy === undefined) return env;
  return {
    ...env,
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    NO_PROXY: 'localhost,127.0.0.1,::1',
    NODE_USE_ENV_PROXY: '1',
  };
}

let proxy: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (proxy === undefined) resolve();
    else
      proxy.close(() => {
        resolve();
      });
  });
  proxy = undefined;
});

/** A proxy that records the tunnels asked for and refuses each (no network needed). */
async function startProxy(seen: string[]): Promise<string> {
  proxy = createServer((_request, response) => {
    response.end();
  });
  proxy.on('connect', (request: { url?: string }, socket: Duplex) => {
    seen.push(request.url ?? '');
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  await new Promise<void>((resolve) => proxy?.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  if (address === null || typeof address === 'string') throw new Error('no proxy port');
  return `http://127.0.0.1:${String(address.port)}`;
}

describe('the Agent Host proxy', () => {
  // A host that does not resolve: only through the proxy does the request get anywhere.
  const target = 'https://piarc-proxy-check.invalid/probe';

  it('sends fetch through the proxy after Pi is loaded', async () => {
    const seen: string[] = [];
    const url = await startProxy(seen);
    const outcome = await runChild(target, hostEnv(url));
    expect(seen).toEqual(['piarc-proxy-check.invalid:443']);
    expect(outcome.status).toBeUndefined();
  }, 30_000);

  it('leaves fetch alone without a proxy', async () => {
    const outcome = await runChild(target, hostEnv());
    expect(outcome).toEqual({ restored: false, error: 'ENOTFOUND' });
  }, 30_000);
});
