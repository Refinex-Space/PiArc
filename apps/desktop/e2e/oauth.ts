// A provider that signs in through the mock authorization server (piarc-mock-auth, T29): the
// `--test-oauth-provider` file every Agent Host of the app reads (set `appEnv` to
// `{ PIARC_TEST_OAUTH_PROVIDER: PROVIDER_FILE }`), the server, and a browser double for
// "Open in browser". Used by the T29 sign-in tests and T43's accessibility journey.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import type { ElectronApplication } from '@playwright/test';

const repoRoot = path.join(import.meta.dirname, '..', '..', '..');

/** The `--test-oauth-provider` file every Agent Host of the app reads when it starts. */
export const PROVIDER_FILE = path.join(os.tmpdir(), `piarc-t29-oauth-${String(process.pid)}.json`);
export const PROVIDER = 'piarc-test-oauth';

export interface AuthServer {
  readonly base: string;
  stop(): void;
  decide(behavior: 'approve' | 'deny' | 'expire'): void;
}

export async function startAuth(): Promise<AuthServer> {
  const child = spawn(
    'cargo',
    [
      'run',
      '-q',
      '--locked',
      '-p',
      'piarc-testkit',
      '--bin',
      'piarc-mock-auth',
      '--',
      '--port',
      '0',
      // About three seconds of polling: long enough to see (and capture) the device code.
      '--pending-polls',
      '30',
    ],
    { cwd: repoRoot, stdio: ['pipe', 'pipe', 'inherit'] },
  );
  const lines = createInterface({ input: child.stdout });
  const port = await new Promise<string>((resolve, reject) => {
    lines.once('line', resolve);
    child.once('exit', (code) => {
      reject(new Error(`piarc-mock-auth exited with ${String(code)}`));
    });
  });
  lines.close();
  return {
    base: `http://127.0.0.1:${port.trim()}`,
    stop: () => child.stdin.end(),
    decide: (behavior) => {
      child.stdin.write(`${behavior}\n`);
    },
  };
}

export async function writeProvider(
  auth: AuthServer,
  mockBase: string,
  flow: string,
): Promise<void> {
  await writeFile(
    PROVIDER_FILE,
    JSON.stringify({
      id: PROVIDER,
      baseUrl: `${mockBase}/v1`,
      tokenUrl: `${auth.base}/token`,
      authorizeUrl: `${auth.base}/authorize`,
      deviceUrl: `${auth.base}/device`,
      flow,
      models: [{ id: 'oauth-model', contextWindow: 32_000, maxTokens: 1024 }],
    }),
  );
}

/** Confirmations answer "open"; opening a URL fetches it like a browser and records it. */
export async function browserDouble(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog, shell }) => {
    const opened: string[] = [];
    (globalThis as { __t29Opened?: string[] }).__t29Opened = opened;
    dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
    shell.openExternal = async (url: string) => {
      opened.push(url);
      await fetch(url);
    };
  });
}
