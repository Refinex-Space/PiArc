// Marks a finished download as coming from the internet (design addendum B1.3.6): macOS's
// `com.apple.quarantine` attribute (Gatekeeper checks the file before it first opens) and
// Windows's `Zone.Identifier` stream (zone 3, the internet). Chromium may already have written
// one; then it stays as it is. Files the agent saved into the workspace through Core get the
// same mark, so a download cannot lose it by being copied there.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stat, writeFile } from 'node:fs/promises';

/** What marking needs from the system (replaced in tests). */
export interface QuarantinePorts {
  readonly platform: string;
  /** Runs a program with arguments (no shell) and answers its exit code. */
  run(file: string, args: readonly string[]): Promise<number>;
  exists(file: string): Promise<boolean>;
  write(file: string, text: string): Promise<void>;
  now(): number;
  uuid(): string;
}

const XATTR = '/usr/bin/xattr';
const ATTRIBUTE = 'com.apple.quarantine';

/** Marks `file`, downloaded from `url`; failures are logged, never thrown. */
export async function quarantine(
  file: string,
  url: string,
  ports: QuarantinePorts = SYSTEM,
): Promise<void> {
  try {
    if (ports.platform === 'darwin') await mac(file, ports);
    else if (ports.platform === 'win32') await windows(file, url, ports);
  } catch (error) {
    console.warn('[browser] cannot mark the download as from the internet', error);
  }
}

async function mac(file: string, ports: QuarantinePorts): Promise<void> {
  if ((await ports.run(XATTR, ['-p', ATTRIBUTE, file])) === 0) return;
  // Flags 0081: downloaded, not yet approved; then the time (hex seconds), agent, event id.
  const seconds = Math.floor(ports.now() / 1000).toString(16);
  const value = `0081;${seconds};PiArc;${ports.uuid()}`;
  const code = await ports.run(XATTR, ['-w', ATTRIBUTE, value, file]);
  if (code !== 0) throw new Error(`xattr exited with ${String(code)}`);
}

async function windows(file: string, url: string, ports: QuarantinePorts): Promise<void> {
  const stream = `${file}:Zone.Identifier`;
  if (await ports.exists(stream)) return;
  const host = hostUrl(url);
  const lines = ['[ZoneTransfer]', 'ZoneId=3', ...(host === undefined ? [] : [`HostUrl=${host}`])];
  await ports.write(stream, `${lines.join('\r\n')}\r\n`);
}

/** The download's address without user name, password or line breaks. */
function hostUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url.replace(/[\r\n]/gu, ''));
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  parsed.username = '';
  parsed.password = '';
  return parsed.href;
}

const SYSTEM: QuarantinePorts = {
  platform: process.platform,
  run: (file, args) =>
    new Promise((resolve) => {
      execFile(file, [...args], { timeout: 10_000 }, (error) => {
        resolve(error === null ? 0 : typeof error.code === 'number' ? error.code : 1);
      });
    }),
  exists: async (file) => {
    try {
      await stat(file);
      return true;
    } catch {
      return false;
    }
  },
  write: (file, text) => writeFile(file, text),
  now: () => Date.now(),
  uuid: () => randomUUID().toUpperCase(),
};
