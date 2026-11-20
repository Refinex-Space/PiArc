import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { assert, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionRegistry } from '../runtime/session-registry.js';
import { supportedEfforts } from './catalog.js';
import { openWorkspace } from '../runtime/workspace.js';
import { credentialStatus, saveCredential } from './settings.js';
import { loginProviders, Logins } from './login.js';
import type { CoreBridge } from '../runtime/core-bridge.js';
import { listModels } from '../runtime/session-models.js';

let dir: string;
const baseUrl = 'https://relay.example.test';
const endpoint = { baseUrl, api: 'anthropic-messages', models: [{ id: 'chat' }] };
const key = 'fixture-test-only-secret';
const bound = {
  type: 'api_key',
  key,
  env: {
    PIARC_BOUND_BASE_URL: baseUrl,
    PIARC_BOUND_API: 'anthropic-messages',
    PIARC_CHANGE_ID: 'revision',
  },
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'piarc-provider-'));
  await writeFile(
    path.join(dir, 'models.json'),
    JSON.stringify({ providers: { relay: endpoint } }),
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

describe('the workspace model runtime', () => {
  it('removes Anthropic OAuth and rejects direct login before prompting, including after a reload', async () => {
    const workspace = await openWorkspace(dir, dir, new InMemoryCredentialStore());
    await workspace.reload(false);
    const runtime = workspace.modelRuntime;
    expect(runtime.getProviders().find((p) => p.id === 'anthropic')?.auth.oauth).toBeUndefined();
    expect(runtime.getProvider('anthropic')?.auth.apiKey).toBeDefined();
    const prompt = vi.fn();
    await expect(
      runtime.login('anthropic', 'oauth', { prompt, notify: () => undefined }),
    ).rejects.toMatchObject({ kind: 'permissionDenied' });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('lists sign-in providers for the settings window without Anthropic subscription OAuth (T29)', async () => {
    const workspace = await openWorkspace(dir, dir, new InMemoryCredentialStore());
    await workspace.reload(false);
    const offered = await loginProviders(workspace.modelRuntime);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.map((p) => p.id)).not.toContain('anthropic');
    expect(offered.every((p) => !p.signedIn)).toBe(true);
    // The settings Host's sign-in path refuses it too, before any interaction.
    const logins = new Logins(
      workspace.modelRuntime,
      { requestTyped: vi.fn() } as unknown as CoreBridge,
      () => undefined,
    );
    await expect(logins.start('login-1', 'anthropic')).rejects.toMatchObject({
      kind: 'invalidParams',
    });
    const listed = await listModels(workspace, undefined);
    expect(listed.loginProviders?.map((p) => p.id)).not.toContain('anthropic');
  });

  it('persists literal keys through ModelRuntime, checks the actual destination, and deletes the credential', async () => {
    const store = new InMemoryCredentialStore();
    const workspace = await openWorkspace(dir, dir, store);
    const runtime = workspace.modelRuntime;
    await saveCredential(runtime, store, 'relay', bound, false);
    expect(await credentialStatus(store, 'relay')).toEqual({
      hasCredential: true,
      changeId: 'revision',
    });
    const model = runtime.getModel('relay', 'chat');
    assert.isDefined(model);
    expect((await runtime.getAuth(model))?.auth.apiKey).toBe(key);
    expect((await runtime.getAuth(model))?.env).not.toHaveProperty('PIARC_BOUND_BASE_URL');
    await expect(
      runtime.getAuth({ ...model, baseUrl: 'https://other.example.test' }),
    ).rejects.toMatchObject({ kind: 'permissionDenied' });
    await expect(
      saveCredential(
        runtime,
        store,
        'relay',
        { ...bound, key: 'before-sk-ant-oat-fixture' },
        false,
      ),
    ).rejects.toMatchObject({ kind: 'permissionDenied' });
    // A credential arriving independently from the vault must also fail at request time.
    await store.modify('relay', () =>
      Promise.resolve({ type: 'api_key', key: 'before-sk-ant-oat-fixture' }),
    );
    await expect(runtime.getAuth(model)).rejects.toMatchObject({ kind: 'permissionDenied' });
    await saveCredential(runtime, store, 'relay', undefined, false);
    expect(await credentialStatus(store, 'relay')).toEqual({ hasCredential: false });
  });

  it('redacts the provider key echoed by an HTTP error before the Pi session can persist it', async () => {
    const store = new InMemoryCredentialStore();
    await store.modify('relay', () => Promise.resolve({ type: 'api_key', key }));
    const { modelRuntime } = await openWorkspace(dir, dir, store);
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        Response.json(
          {
            type: 'error',
            error: { type: 'authentication_error', message: `invalid key: ${key}` },
          },
          { status: 401 },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const model = modelRuntime.getModel('relay', 'chat');
    assert.isDefined(model);
    const message = await modelRuntime.completeSimple(
      model,
      { messages: [{ role: 'user', content: 'Hello', timestamp: 0 }] },
      { maxRetries: 0 },
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(message.errorMessage).toContain('401');
    expect(message.errorMessage).toContain('[REDACTED]');
    expect(JSON.stringify(message)).not.toContain(key);
  });

  it('resolves cloud authentication with request-scoped settings', async () => {
    const store = new InMemoryCredentialStore();
    const { modelRuntime } = await openWorkspace(dir, dir, store);
    await saveCredential(
      modelRuntime,
      store,
      'amazon-bedrock',
      { type: 'api_key', key, env: { AWS_REGION: 'us-west-2' } },
      false,
    );
    await expect(modelRuntime.getAuth('amazon-bedrock')).resolves.toMatchObject({
      auth: { apiKey: key },
      env: { AWS_REGION: 'us-west-2' },
    });
    await saveCredential(
      modelRuntime,
      store,
      'amazon-bedrock',
      { type: 'api_key', env: { AWS_PROFILE: 'test-profile', AWS_REGION: 'us-west-2' } },
      false,
    );
    await expect(modelRuntime.getAuth('amazon-bedrock')).resolves.toMatchObject({
      auth: {},
      env: { AWS_PROFILE: 'test-profile' },
    });
    await saveCredential(modelRuntime, store, 'google-vertex', { type: 'api_key', key }, false);
    await expect(modelRuntime.getAuth('google-vertex')).resolves.toMatchObject({
      auth: { apiKey: key },
    });
    const file = path.join(dir, 'test-gcloud.json');
    await writeFile(file, '{}');
    await saveCredential(
      modelRuntime,
      store,
      'google-vertex',
      {
        type: 'api_key',
        env: {
          GOOGLE_APPLICATION_CREDENTIALS: file,
          GOOGLE_CLOUD_LOCATION: 'us-central1',
          GOOGLE_CLOUD_PROJECT: 'piarc-test',
        },
      },
      false,
    );
    await expect(modelRuntime.getAuth('google-vertex')).resolves.toMatchObject({
      auth: {},
      env: { GOOGLE_APPLICATION_CREDENTIALS: file, GOOGLE_CLOUD_PROJECT: 'piarc-test' },
    });
    expect(process.env.GOOGLE_APPLICATION_CREDENTIALS).not.toBe(file);
  });

  it.each(['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'])(
    'rejects ambient %s at request time',
    async (name) => {
      vi.stubEnv(name, 'test-environment-token');
      const { modelRuntime } = await openWorkspace(dir, dir, new InMemoryCredentialStore());
      await expect(modelRuntime.getAuth('anthropic')).rejects.toMatchObject({
        kind: 'permissionDenied',
      });
    },
  );

  it('restores offline, contacts the configured catalog on enabling, and keeps a remote cached model offline', async () => {
    vi.stubEnv('PI_OFFLINE', undefined);
    const store = new InMemoryCredentialStore();
    await store.modify('anthropic', () => Promise.resolve({ type: 'api_key', key }));
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    const workspace = await openWorkspace(dir, dir, store, false, 'https://catalog.example.test');
    const model = workspace.modelRuntime.getModels('anthropic')[0];
    assert.isDefined(model);
    fetch.mockImplementation(() =>
      Promise.resolve(
        Response.json(
          { models: [{ ...model, id: 'cached-chat' }] },
          {
            headers: { 'last-modified': new Date(2100, 0, 1).toUTCString(), etag: '"test"' },
          },
        ),
      ),
    );
    expect(fetch).not.toHaveBeenCalled();
    await workspace.reload(true);
    expect(
      fetch.mock.calls.map(([url]) => (url instanceof Request ? url.url : url.toString())),
    ).toContainEqual(expect.stringContaining('/api/models/providers/anthropic'));
    expect(workspace.modelRuntime.getModel('anthropic', 'cached-chat')).toBeDefined();
    fetch.mockClear();
    const restarted = await openWorkspace(dir, dir, store, false, 'https://catalog.example.test');
    expect(restarted.modelRuntime.getModel('anthropic', 'cached-chat')).toBeDefined();
    vi.stubEnv('PI_CODING_AGENT_DIR', dir);
    const registry = new SessionRegistry({
      workspace: restarted,
      tools: { kind: 'pi-native' },
      isTrusted: () => Promise.resolve(false),
      log: () => undefined,
      sinkFor: () => ({
        event: () => undefined,
        delta: () => undefined,
        replaceable: () => undefined,
      }),
    });
    try {
      const original = { provider: model.provider, id: model.id };
      const selection = { provider: model.provider, id: 'cached-chat' };
      await registry.create(dir, original, 'offline-switch');
      await registry.setModel('offline-switch', selection, supportedEfforts(model)[0]);
      await expect(registry.models('offline-switch')).resolves.toMatchObject({ model: selection });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await registry.closeAll();
    }
  });
});
