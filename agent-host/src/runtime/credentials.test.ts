// The Core-backed credential store against pi-ai's CredentialStore contract (T08-A07) and
// PiArc's own rules: reads from memory, memory before write-back, write-back and load failures
// surface as errors (A06), changes pushed between Agent Hosts, no double refresh and no lost
// update across Agent Hosts (A08, A09 at the store level).
//
// "Pi contract" cases are adapted from Pi v1.5.2 `packages/ai/test/models-runtime.test.ts`
// (https://github.com/earendil-works/pi, MIT License, Copyright (c) 2025 Mario Zechner) and
// run against both pi-ai's InMemoryCredentialStore and CoreCredentialStore.
import {
  createAssistantMessageEventStream,
  createModels,
  InMemoryCredentialStore,
} from '@earendil-works/pi-ai';
import type {
  ApiKeyAuth,
  AssistantMessageEventStream,
  AssistantMessage,
  Credential,
  CredentialStore,
  Model,
  OAuthAuth,
  Provider,
  ProviderAuth,
} from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';

import { AhpError } from '../protocol/errors.js';
import type { RequestOptions } from './core-bridge.js';
import { CoreCredentialStore, type SecretsRequester } from './credentials.js';

// ---------------------------------------------------------------------------------------------
// A Core with the vault semantics of piarc-core's SecretsService, in memory.

interface Stored {
  revision: number;
  value: Record<string, unknown>;
}

class FakeCore {
  readonly entries = new Map<string, Stored>();
  readonly requests: string[] = [];
  #nextRevision = 1;
  readonly #locks = new Map<string, string>();
  #lockSeq = 0;
  leaseMs = 30_000;
  #waiters: (() => void)[] = [];
  readonly #subscribers: CoreCredentialStore[] = [];
  /** Methods that fail with the given error until cleared. */
  readonly failing = new Map<string, AhpError>();
  /** When set, `secrets/set` waits for it before storing. */
  holdSets: Promise<void> | undefined;

  /** One Agent Host's connection. */
  connect(): SecretsRequester & { attach(store: CoreCredentialStore): void } {
    let subscriber: CoreCredentialStore | undefined;
    return {
      attach: (store) => {
        subscriber = store;
      },
      request: async (method: string, params: object, options?: RequestOptions) => {
        this.requests.push(method);
        const failure = this.failing.get(method);
        if (failure !== undefined) {
          throw failure;
        }
        const p = params as Record<string, unknown>;
        switch (method) {
          case 'secrets/getAll':
            if (subscriber !== undefined && !this.#subscribers.includes(subscriber)) {
              this.#subscribers.push(subscriber);
            }
            return { entries: [...this.entries].map(([key, e]) => ({ key, ...e })) };
          case 'secrets/lock': {
            const keys = p.keys as string[];
            while (keys.some((k) => this.#locks.has(k))) {
              await new Promise<void>((resolve, reject) => {
                this.#waiters.push(resolve);
                options?.signal?.addEventListener('abort', () => {
                  reject(new AhpError('uncertain', 'cancelled'));
                });
              });
            }
            const lockId = `lock-${String(++this.#lockSeq)}`;
            for (const key of keys) {
              this.#locks.set(key, lockId);
            }
            const entries = keys.flatMap((key) => {
              const e = this.entries.get(key);
              return e === undefined ? [] : [{ key, ...e }];
            });
            return { lockId, entries, expiresInMs: this.leaseMs };
          }
          case 'secrets/renew':
            return { expiresInMs: this.leaseMs };
          case 'secrets/unlock': {
            const lockId = p.lockId as string;
            let released = false;
            for (const [key, id] of this.#locks) {
              if (id === lockId) {
                this.#locks.delete(key);
                released = true;
              }
            }
            const waiters = this.#waiters;
            this.#waiters = [];
            waiters.forEach((wake) => {
              wake();
            });
            return { released };
          }
          case 'secrets/set': {
            const key = p.key as string;
            expect(this.#locks.get(key)).toBe(p.lockId);
            await this.holdSets;
            const revision = this.#nextRevision++;
            const value = p.value as Record<string, unknown>;
            this.entries.set(key, { revision, value: structuredClone(value) });
            this.#push({ key, revision, value: structuredClone(value) });
            return { revision };
          }
          case 'secrets/delete': {
            const key = p.key as string;
            expect(this.#locks.get(key)).toBe(p.lockId);
            if (!this.entries.delete(key)) {
              return {};
            }
            const revision = this.#nextRevision++;
            this.#push({ key, revision });
            return { revision };
          }
          default:
            throw new AhpError('methodNotFound', method);
        }
      },
    };
  }

  /** Writes as another client would (the settings UI, another Agent Host). */
  write(key: string, value: Record<string, unknown>): number {
    const revision = this.#nextRevision++;
    this.entries.set(key, { revision, value });
    this.#push({ key, revision, value });
    return revision;
  }

  #push(params: object): void {
    for (const store of this.#subscribers) {
      // Delivered later, like a frame on the wire.
      setTimeout(() => store.applyChange(params), 0);
    }
  }
}

async function coreStore(
  core = new FakeCore(),
): Promise<{ store: CoreCredentialStore; core: FakeCore }> {
  const connection = core.connect();
  const store = new CoreCredentialStore({ core: connection, log: () => undefined });
  connection.attach(store);
  await store.load();
  return { store, core };
}

// ---------------------------------------------------------------------------------------------
// Test providers (shapes as in Pi's models-runtime tests).

function testModel(provider: string): Model<'test-api'> {
  return {
    id: 'model-a',
    name: 'model-a',
    api: 'test-api',
    provider,
    baseUrl: 'https://example.test/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 10_000,
    maxTokens: 1_000,
  };
}

function testProvider(id: string, auth: ProviderAuth): Provider {
  const respond = (model: Model<'test-api'>): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    };
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: 'stop', message });
    stream.end(message);
    return stream;
  };
  return {
    id,
    name: id,
    auth,
    getModels: () => [testModel(id)],
    stream: (model) => respond(model as Model<'test-api'>),
    streamSimple: (model) => respond(model as Model<'test-api'>),
  };
}

function envKeyAuth(key: string | undefined): ApiKeyAuth {
  return {
    name: 'Test API key',
    resolve: ({ credential }) => {
      const resolved = credential?.key ?? key;
      return Promise.resolve(
        resolved === undefined
          ? undefined
          : { auth: { apiKey: resolved }, source: credential ? 'stored' : 'env' },
      );
    },
  };
}

function testOAuth(overrides?: Partial<OAuthAuth>): OAuthAuth {
  return {
    name: 'Test OAuth',
    login: () => Promise.reject(new Error('not used')),
    refresh: (credential) => Promise.resolve(credential),
    toAuth: (credential) => Promise.resolve({ apiKey: credential.access }),
    ...overrides,
  };
}

function accessOf(credential: Credential | undefined): string | undefined {
  return credential?.type === 'oauth' ? credential.access : undefined;
}

const stores: [string, () => Promise<CredentialStore>][] = [
  ['InMemoryCredentialStore', () => Promise.resolve(new InMemoryCredentialStore())],
  ['CoreCredentialStore', async () => (await coreStore()).store],
];

// ---------------------------------------------------------------------------------------------

describe.each(stores)('Pi CredentialStore contract: %s', (_name, make) => {
  it('runs provider login and logout through the credential store', async () => {
    const credentials = await make();
    const apiKey = envKeyAuth(undefined);
    apiKey.login = () => Promise.resolve({ type: 'api_key', key: 'logged-in' });
    const models = createModels({ credentials });
    models.setProvider(testProvider('p1', { apiKey }));
    const credential = await models.login('p1', 'api_key', {
      prompt: () => Promise.resolve('unused'),
      notify: () => undefined,
    });
    expect(credential).toEqual({ type: 'api_key', key: 'logged-in' });
    expect(await credentials.read('p1')).toEqual(credential);
    expect(await credentials.list()).toEqual([{ providerId: 'p1', type: 'api_key' }]);
    await models.logout('p1');
    expect(await credentials.read('p1')).toBeUndefined();
    expect(await credentials.list()).toEqual([]);
  });

  it('refreshes oauth credentials with less than five minutes remaining', async () => {
    const credentials = await make();
    let refreshes = 0;
    const models = createModels({ credentials });
    models.setProvider(
      testProvider('p1', {
        oauth: testOAuth({
          refresh: (credential) => {
            refreshes++;
            return Promise.resolve({
              ...credential,
              access: 'new-token',
              expires: Date.now() + 3_600_000,
            });
          },
        }),
      }),
    );
    await credentials.modify('p1', () =>
      Promise.resolve({
        type: 'oauth',
        access: 'old-token',
        refresh: 'r',
        expires: Date.now() + 60_000,
      }),
    );
    expect((await models.getAuth('p1'))?.auth.apiKey).toBe('new-token');
    expect(refreshes).toBe(1);
    expect(accessOf(await credentials.read('p1'))).toBe('new-token');
  });

  it('serializes concurrent OAuth refreshes through store.modify (no double refresh)', async () => {
    const credentials = await make();
    await credentials.modify('p1', () =>
      Promise.resolve({ type: 'oauth', access: 'old', refresh: 'r1', expires: 0 }),
    );
    let refreshes = 0;
    const models = createModels({ credentials });
    models.setProvider(
      testProvider('p1', {
        oauth: testOAuth({
          refresh: async () => {
            refreshes++;
            await new Promise((resolve) => setTimeout(resolve, 10));
            return {
              type: 'oauth',
              access: `new-${String(refreshes)}`,
              refresh: 'r2',
              expires: Date.now() + 3_600_000,
            };
          },
        }),
      }),
    );
    const [a, b] = await Promise.all([models.getAuth('p1'), models.getAuth('p1')]);
    expect(refreshes).toBe(1);
    expect(a?.auth.apiKey).toBe('new-1');
    expect(b?.auth.apiKey).toBe('new-1');
  });

  it('rejects with code oauth when refresh fails, preserving the stored credential', async () => {
    const credentials = await make();
    const models = createModels({ credentials });
    models.setProvider(
      testProvider('p1', {
        oauth: testOAuth({ refresh: () => Promise.reject(new Error('invalid_grant')) }),
      }),
    );
    await credentials.modify('p1', () =>
      Promise.resolve({ type: 'oauth', access: 'old', refresh: 'r', expires: 0 }),
    );
    await expect(models.getAuth('p1')).rejects.toMatchObject({ code: 'oauth' });
    expect(accessOf(await credentials.read('p1'))).toBe('old');
  });

  it('cancels queued credential mutations without running them later', async () => {
    const credentials = await make();
    let finishFirst: () => void = () => undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let secondRan = false;
    const first = credentials.modify('p1', async () => {
      await firstBlocked;
      return { type: 'api_key', key: 'first' };
    });
    const controller = new AbortController();
    const second = credentials.modify(
      'p1',
      () => {
        secondRan = true;
        return Promise.resolve({ type: 'api_key', key: 'second' });
      },
      { signal: controller.signal },
    );
    controller.abort();
    finishFirst();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    await first;
    expect(secondRan).toBe(false);
    expect(await credentials.read('p1')).toEqual({ type: 'api_key', key: 'first' });
  });

  it('a stored credential owns the provider: no fallback to the environment', async () => {
    const credentials = await make();
    const models = createModels({ credentials });
    models.setProvider(testProvider('p1', { apiKey: envKeyAuth('env-key'), oauth: testOAuth() }));
    expect((await models.getAuth('p1'))?.auth.apiKey).toBe('env-key');
    await credentials.modify('p1', () => Promise.resolve({ type: 'api_key', key: 'stored-key' }));
    expect((await models.getAuth('p1'))?.auth.apiKey).toBe('stored-key');
  });
});

describe('CoreCredentialStore', () => {
  it('answers reads from memory without asking Core', async () => {
    const core = new FakeCore();
    core.write('provider/p1', { type: 'api_key', key: 'k1' });
    const { store } = await coreStore(core);
    const before = core.requests.length;
    for (let i = 0; i < 100; i++) {
      expect(await store.read('p1')).toEqual({ type: 'api_key', key: 'k1' });
    }
    await store.list();
    expect(core.requests.length).toBe(before);
  });

  it('updates memory before Core acknowledges the write, and resolves after', async () => {
    const { store, core } = await coreStore();
    let release: () => void = () => undefined;
    core.holdSets = new Promise((resolve) => {
      release = resolve;
    });
    let resolved = false;
    const writing = store
      .modify('p1', () => Promise.resolve({ type: 'api_key', key: 'new' }))
      .then((value) => {
        resolved = true;
        return value;
      });
    await expect.poll(() => core.requests).toContain('secrets/set');
    expect(core.entries.has('provider/p1')).toBe(false);
    expect(await store.read('p1')).toEqual({ type: 'api_key', key: 'new' });
    expect(resolved).toBe(false);
    release();
    expect(await writing).toEqual({ type: 'api_key', key: 'new' });
    expect(core.entries.get('provider/p1')?.value).toEqual({ type: 'api_key', key: 'new' });
    expect(core.requests.slice(-1)).toEqual(['secrets/unlock']);
  });

  it('rejects a write Core did not store and keeps the value in memory', async () => {
    const { store, core } = await coreStore();
    core.failing.set(
      'secrets/set',
      new AhpError('credentialStoreUnavailable', 'keychain locked', { retryable: true }),
    );
    const models = createModels({ credentials: store });
    models.setProvider(
      testProvider('p1', {
        oauth: testOAuth({
          refresh: () =>
            Promise.resolve({
              type: 'oauth',
              access: 'rotated',
              refresh: 'r2',
              expires: Date.now() + 3_600_000,
            }),
        }),
      }),
    );
    core.failing.delete('secrets/set');
    await store.modify('p1', () =>
      Promise.resolve({ type: 'oauth', access: 'old', refresh: 'r', expires: 0 }),
    );
    core.failing.set(
      'secrets/set',
      new AhpError('credentialStoreUnavailable', 'keychain locked', { retryable: true }),
    );
    // The refresh runs inside modify; its failed write-back fails the request (a session error).
    await expect(models.getAuth('p1')).rejects.toMatchObject({ code: 'auth' });
    expect(accessOf(await store.read('p1'))).toBe('rotated');
    expect(core.requests.slice(-1)).toEqual(['secrets/unlock']);
    expect(accessOf(core.entries.get('oauth/p1')?.value as Credential)).toBe('old');
  });

  it('reports an unavailable vault and never falls back to the environment', async () => {
    const core = new FakeCore();
    core.failing.set(
      'secrets/getAll',
      new AhpError('credentialStoreUnavailable', 'access denied', {
        retryable: true,
        details: { reason: 'accessDenied' },
      }),
    );
    const { store } = await coreStore(core);
    expect(store.loaded).toBe(false);
    await expect(store.read('p1')).rejects.toMatchObject({ kind: 'credentialStoreUnavailable' });
    const models = createModels({ credentials: store });
    models.setProvider(testProvider('p1', { apiKey: envKeyAuth('ambient-key-from-env') }));
    await expect(models.getAuth('p1')).rejects.toMatchObject({ code: 'auth' });
    await expect(
      store.modify('p1', () => Promise.resolve({ type: 'api_key', key: 'x' })),
    ).rejects.toMatchObject({ kind: 'credentialStoreUnavailable' });
    expect(core.requests).not.toContain('secrets/set');
    // Access granted: the next operation loads again.
    core.failing.delete('secrets/getAll');
    expect(await store.read('p1')).toBeUndefined();
    expect(store.loaded).toBe(true);
  });

  it('switching a provider to OAuth removes its API key entry', async () => {
    const { store, core } = await coreStore();
    await store.modify('p1', () => Promise.resolve({ type: 'api_key', key: 'k' }));
    await store.modify('p1', () =>
      Promise.resolve({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 }),
    );
    expect([...core.entries.keys()]).toEqual(['oauth/p1']);
    expect((await store.read('p1'))?.type).toBe('oauth');
    await store.delete('p1');
    expect(core.entries.size).toBe(0);
  });

  it('applies changes pushed by Core and ignores stale ones', async () => {
    const { store, core } = await coreStore();
    const r1 = core.write('provider/p1', { type: 'api_key', key: 'one' });
    await expect.poll(() => store.read('p1')).toEqual({ type: 'api_key', key: 'one' });
    core.write('provider/p1', { type: 'api_key', key: 'two' });
    await expect.poll(() => store.read('p1')).toEqual({ type: 'api_key', key: 'two' });
    expect(
      store.applyChange({
        key: 'provider/p1',
        revision: r1,
        value: { type: 'api_key', key: 'one' },
      }),
    ).toBe(true);
    expect(await store.read('p1')).toEqual({ type: 'api_key', key: 'two' });
    expect(store.applyChange({ key: 'provider/p1' })).toBe(false);
    // MCP tokens are not model credentials.
    store.applyChange({ key: 'mcp/server', revision: 99, value: { token: 't' } });
    expect(await store.list()).toEqual([{ providerId: 'p1', type: 'api_key' }]);
  });

  it('renews a lease while waiting for a credential rotation', async () => {
    const { store, core } = await coreStore();
    core.leaseMs = 30;
    await store.modify('p', async () => {
      await expect.poll(() => core.requests.includes('secrets/renew')).toBe(true);
      return { type: 'api_key', key: 'rotated' };
    });
    expect(core.requests.at(-1)).toBe('secrets/unlock');
  });

  it('two Agent Hosts refresh one expiring token once and end with the same token', async () => {
    const core = new FakeCore();
    core.write('oauth/p1', {
      type: 'oauth',
      access: 'gen-1',
      refresh: 'refresh-1',
      expires: Date.now() + 60_000,
    });
    const hosts = [await coreStore(core), await coreStore(core)];
    const used: string[] = [];
    let refreshes = 0;
    const oauth = testOAuth({
      refresh: async (credential) => {
        refreshes++;
        used.push(credential.refresh);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          type: 'oauth',
          access: 'gen-2',
          refresh: 'refresh-2',
          expires: Date.now() + 3_600_000,
        };
      },
    });
    const runtimes = hosts.map(({ store }) => {
      const models = createModels({ credentials: store });
      models.setProvider(testProvider('p1', { oauth }));
      return models;
    });
    // Three sessions per Agent Host ask at once.
    const auths = await Promise.all(
      runtimes.flatMap((m) => [m.getAuth('p1'), m.getAuth('p1'), m.getAuth('p1')]),
    );
    expect(refreshes).toBe(1);
    expect(used).toEqual(['refresh-1']);
    expect(auths.map((a) => a?.auth.apiKey)).toEqual(Array<string>(6).fill('gen-2'));
    for (const { store } of hosts) {
      await expect.poll(async () => accessOf(await store.read('p1'))).toBe('gen-2');
    }
    expect(accessOf(core.entries.get('oauth/p1')?.value as Credential)).toBe('gen-2');
  });

  it('loses no update when sessions of two Agent Hosts modify one credential at once', async () => {
    const core = new FakeCore();
    core.write('provider/p1', { type: 'api_key', key: '0' });
    const hosts = [await coreStore(core), await coreStore(core)];
    const bump = (store: CoreCredentialStore): Promise<Credential | undefined> =>
      store.modify('p1', async (current) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        const n = Number(current?.type === 'api_key' ? current.key : 'NaN');
        return { type: 'api_key', key: String(n + 1) };
      });
    await Promise.all(hosts.flatMap(({ store }) => Array.from({ length: 20 }, () => bump(store))));
    expect(core.entries.get('provider/p1')?.value).toEqual({ type: 'api_key', key: '40' });
    for (const { store } of hosts) {
      await expect.poll(() => store.read('p1')).toEqual({ type: 'api_key', key: '40' });
    }
  });
});
