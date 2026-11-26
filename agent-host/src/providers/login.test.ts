import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CoreBridge } from '../runtime/core-bridge.js';
import { openWorkspace } from '../runtime/workspace.js';
import { connectionFailure, installationId, Logins } from './login.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'piarc login 登录-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('installationId', () => {
  it('makes a UUID once and answers it again', async () => {
    const file = path.join(dir, 'agent-host', 'installation-id');
    const first = installationId(file);
    expect(first).toMatch(UUID);
    expect(installationId(file)).toBe(first);
    expect((await readFile(file, 'utf8')).trim()).toBe(first);
  });

  it('replaces a file that holds no UUID', async () => {
    const file = path.join(dir, 'installation-id');
    await writeFile(file, 'not an id');
    const made = installationId(file);
    expect(made).toMatch(UUID);
    expect(installationId(file)).toBe(made);
  });
});

describe('Logins', () => {
  it('gives the sign-in flow the installation ID (Sign in with ChatGPT needs one)', async () => {
    const workspace = await openWorkspace(dir, dir, new InMemoryCredentialStore());
    const asked: unknown[] = [];
    const bridge = {
      // The flow's first question: cancel it, so nothing reaches the network.
      requestTyped: (_method: string, params: unknown) => {
        asked.push(params);
        return Promise.resolve({});
      },
    } as unknown as CoreBridge;
    let calls = 0;
    const logins = new Logins(workspace.modelRuntime, bridge, () => undefined, {
      deviceId: () => {
        calls += 1;
        return '00000000-0000-4000-8000-000000000000';
      },
      credentials: new InMemoryCredentialStore(),
    });
    await expect(logins.start('login-1', 'openai')).rejects.toMatchObject({
      message: 'The sign-in was cancelled',
    });
    expect(calls).toBeGreaterThan(0);
    const authUrl = JSON.stringify(asked);
    expect(authUrl).toContain(
      'ext_agent_host_id=urn%3Auuid%3A00000000-0000-4000-8000-000000000000',
    );
  });
});

describe('connectionFailure', () => {
  it('names the code of a server out of reach', () => {
    const timeout = new TypeError('fetch failed', {
      cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
    });
    expect(connectionFailure(timeout)).toBe('UND_ERR_CONNECT_TIMEOUT');
    expect(connectionFailure(new Error('xAI device code failed: fetch failed'))).toBe('');
  });

  it('leaves other failures alone', () => {
    expect(connectionFailure(new Error('The authorization server refused (access_denied)'))).toBe(
      undefined,
    );
    expect(connectionFailure('fetch failed')).toBe(undefined);
  });
});
