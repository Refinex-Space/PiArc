// Pi's credential store backed by Core's vault (architecture section 5.4, ADR-0021).
//
// `ModelRuntime.create({ credentials })` takes pi-ai's `CredentialStore`. This one keeps every
// credential of the vault in memory and talks to Core over AHP (`secrets/*`):
//
// - Startup: `load()` fetches every model credential once (`secrets/getAll` with the
//   `provider/` and `oauth/` prefixes). If that fails (the vault's
//   master key is missing, Keychain access was denied, ...), every operation retries the load
//   once and then rejects with Core's structured error; pi-ai turns the rejection into a
//   failed model request, which the session reports. Nothing falls back to plaintext or to
//   environment variables.
// - Reads: `read` and `list` answer from memory without a Core round trip.
// - Writes: `modify` and `delete` run one at a time per provider (a promise chain). Each takes
//   Core's lock on the provider's keys (`secrets/lock`), which also returns the current
//   entries, so `fn` sees writes another Agent Host made; then memory is updated and the
//   result is written back (`secrets/set` / `secrets/delete` under the lock). `modify`
//   resolves once Core has stored the value, and rejects when it could not: pi-ai runs OAuth
//   refreshes inside `modify`, so a failed write-back fails that model request (a session
//   error). The value stays in memory then, because a rotated refresh token exists nowhere
//   else.
// - Other writers: Core pushes `secrets/changed`; `applyChange` keeps an entry newer than the
//   known revision and ignores older ones.
//
// Keys: an API key credential of provider `<id>` is `provider/<id>`, an OAuth credential
// `oauth/<id>`. pi-ai keeps one credential per provider, so writing one removes the other.
// Credential values never appear in logs or error messages.
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from '@earendil-works/pi-ai';

import { AhpError, describeError } from '../protocol/errors.js';
import type { RequestOptions } from './core-bridge.js';

/** The part of `CoreBridge` the store uses. */
export interface SecretsRequester {
  request(method: string, params: object, options?: RequestOptions): Promise<unknown>;
}

interface Cached {
  readonly credential: Credential;
  readonly revision: number;
}

interface Entry {
  readonly key: string;
  readonly revision: number;
  readonly value: unknown;
}

const API_KEY_PREFIX = 'provider/';
const OAUTH_PREFIX = 'oauth/';

function keysOf(providerId: string): [string, string] {
  return [`${API_KEY_PREFIX}${providerId}`, `${OAUTH_PREFIX}${providerId}`];
}

function keyFor(providerId: string, credential: Credential): string {
  return credential.type === 'oauth'
    ? `${OAUTH_PREFIX}${providerId}`
    : `${API_KEY_PREFIX}${providerId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The credential stored under `key`, or undefined when the value does not fit the key. */
export function credentialOf(key: string, value: unknown): Credential | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (key.startsWith(OAUTH_PREFIX)) {
    const { access, refresh, expires } = value;
    return value.type === 'oauth' &&
      typeof access === 'string' &&
      typeof refresh === 'string' &&
      typeof expires === 'number'
      ? { ...value, type: 'oauth', access, refresh, expires }
      : undefined;
  }
  if (key.startsWith(API_KEY_PREFIX)) {
    const { key: apiKey, env } = value;
    if (value.type !== 'api_key' || (apiKey !== undefined && typeof apiKey !== 'string')) {
      return undefined;
    }
    let vars: Record<string, string> | undefined;
    if (env !== undefined) {
      if (!isRecord(env)) {
        return undefined;
      }
      vars = {};
      for (const [name, v] of Object.entries(env)) {
        if (typeof v !== 'string') {
          return undefined;
        }
        vars[name] = v;
      }
    }
    return {
      type: 'api_key',
      ...(typeof apiKey === 'string' ? { key: apiKey } : {}),
      ...(vars === undefined ? {} : { env: vars }),
    };
  }
  return undefined;
}

function entryOf(value: unknown): Entry | undefined {
  if (!isRecord(value) || typeof value.key !== 'string' || typeof value.revision !== 'number') {
    return undefined;
  }
  return { key: value.key, revision: value.revision, value: value.value };
}

function entriesOf(method: string, result: unknown): Entry[] {
  if (!isRecord(result) || !Array.isArray(result.entries)) {
    throw new AhpError('invalidRequest', `${method} returned a malformed result`);
  }
  return result.entries.map((raw) => {
    const entry = entryOf(raw);
    if (entry === undefined) {
      throw new AhpError('invalidRequest', `${method} returned a malformed entry`);
    }
    return entry;
  });
}

export interface CoreCredentialStoreOptions {
  readonly core: SecretsRequester;
  readonly log: (line: string) => void;
}

export class CoreCredentialStore implements CredentialStore {
  readonly #core: SecretsRequester;
  readonly #log: (line: string) => void;
  /** key → credential; only `provider/*` and `oauth/*` keys. */
  readonly #entries = new Map<string, Cached>();
  /** key → highest revision seen, deletions included. */
  readonly #revisions = new Map<string, number>();
  readonly #chains = new Map<string, Promise<unknown>>();
  #loaded = false;
  #loading: Promise<void> | undefined;
  #loadError: unknown;

  constructor(options: CoreCredentialStoreOptions) {
    this.#core = options.core;
    this.#log = options.log;
  }

  /**
   * Fetches every credential from Core. Never rejects: a failure is kept and reported by the
   * operations that need the credentials.
   */
  load(): Promise<void> {
    this.#loading ??= (async () => {
      try {
        const entries = entriesOf(
          'secrets/getAll',
          await this.#core.request('secrets/getAll', { prefixes: [API_KEY_PREFIX, OAUTH_PREFIX] }),
        );
        for (const entry of entries) {
          this.#apply(entry.key, entry.revision, entry.value);
        }
        this.#loaded = true;
        this.#loadError = undefined;
        this.#log(`credentials loaded from Core (${String(this.#entries.size)} model credentials)`);
      } catch (error) {
        this.#loadError = error;
        this.#log(`loading credentials from Core failed: ${describeError(error)}`);
      } finally {
        this.#loading = undefined;
      }
    })();
    return this.#loading;
  }

  /** Whether the credentials are in memory. */
  get loaded(): boolean {
    return this.#loaded;
  }

  /** Applies a `secrets/changed` notification from Core; false when it is malformed. */
  applyChange(params: unknown): boolean {
    if (
      !isRecord(params) ||
      typeof params.key !== 'string' ||
      typeof params.revision !== 'number'
    ) {
      return false;
    }
    this.#apply(params.key, params.revision, params.value);
    return true;
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    await this.#ready();
    return this.#current(providerId);
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    await this.#ready();
    const providers = new Set<string>();
    for (const key of this.#entries.keys()) {
      providers.add(key.slice(key.indexOf('/') + 1));
    }
    return [...providers].flatMap((providerId) => {
      const credential = this.#current(providerId);
      return credential === undefined ? [] : [{ providerId, type: credential.type }];
    });
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.#serialized(providerId, options, () =>
      this.#locked(providerId, options, async (lockId) => {
        const current = this.#current(providerId);
        const next = await fn(current);
        if (next === undefined) {
          return current;
        }
        const key = keyFor(providerId, next);
        if (credentialOf(key, next) === undefined) {
          throw new AhpError('invalidParams', `the new credential of ${providerId} is malformed`);
        }
        const [apiKey, oauthKey] = keysOf(providerId);
        const other = key === apiKey ? oauthKey : apiKey;
        const otherExisted = this.#entries.has(other);
        // Memory first: every session sees the new credential at once.
        this.#entries.set(key, { credential: next, revision: this.#revisions.get(key) ?? 0 });
        this.#entries.delete(other);
        const result = await this.#core.request('secrets/set', { key, value: next, lockId });
        this.#noteRevision(key, revisionOf('secrets/set', result));
        if (otherExisted) {
          const removed = await this.#core.request('secrets/delete', { key: other, lockId });
          if (isRecord(removed) && typeof removed.revision === 'number') {
            this.#noteRevision(other, removed.revision);
          }
        }
        return next;
      }),
    );
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.#serialized(providerId, options, () =>
      this.#locked(providerId, options, async (lockId) => {
        for (const key of keysOf(providerId)) {
          if (!this.#entries.delete(key)) {
            continue;
          }
          const removed = await this.#core.request('secrets/delete', { key, lockId });
          if (isRecord(removed) && typeof removed.revision === 'number') {
            this.#noteRevision(key, removed.revision);
          }
        }
      }),
    );
  }

  /** Waits for every write in progress (before the process exits). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.#chains.values()]);
  }

  async #ready(): Promise<void> {
    if (this.#loaded) {
      return;
    }
    await this.load();
    // `load()` sets the flag; read it through the getter so the check is not narrowed away.
    if (!this.loaded) {
      const error = this.#loadError;
      throw error instanceof AhpError
        ? error
        : new AhpError('internalError', `credentials unavailable: ${describeError(error)}`);
    }
  }

  /** The provider's credential: the more recently written of its two keys. */
  #current(providerId: string): Credential | undefined {
    const [apiKey, oauthKey] = keysOf(providerId);
    const a = this.#entries.get(apiKey);
    const o = this.#entries.get(oauthKey);
    if (a === undefined || o === undefined) {
      return (o ?? a)?.credential;
    }
    return (o.revision >= a.revision ? o : a).credential;
  }

  #apply(key: string, revision: number, value: unknown): void {
    if (!key.startsWith(API_KEY_PREFIX) && !key.startsWith(OAUTH_PREFIX)) {
      return; // MCP tokens and other kinds are not Pi model credentials.
    }
    if (revision <= (this.#revisions.get(key) ?? 0)) {
      return; // Stale: a newer write of this key is already applied.
    }
    this.#revisions.set(key, revision);
    if (value === undefined || value === null) {
      this.#entries.delete(key);
      return;
    }
    const credential = credentialOf(key, value);
    if (credential === undefined) {
      this.#entries.delete(key);
      this.#log(`ignored credential ${key} (revision ${String(revision)}): malformed value`);
      return;
    }
    this.#entries.set(key, { credential, revision });
  }

  #noteRevision(key: string, revision: number): void {
    if (revision > (this.#revisions.get(key) ?? 0)) {
      this.#revisions.set(key, revision);
      const entry = this.#entries.get(key);
      if (entry !== undefined) {
        this.#entries.set(key, { credential: entry.credential, revision });
      }
    }
  }

  /** Runs `task` after every earlier write of `providerId` settled. */
  #serialized<T>(
    providerId: string,
    options: AuthOperationOptions | undefined,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#chains.get(providerId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => {
        options?.signal?.throwIfAborted();
        return task();
      });
    const tail = run.catch(() => undefined);
    this.#chains.set(providerId, tail);
    void tail.then(() => {
      if (this.#chains.get(providerId) === tail) {
        this.#chains.delete(providerId);
      }
    });
    return run;
  }

  /**
   * Takes Core's lock on the provider's keys (the signal cancels only this wait), applies the
   * current entries it returns, runs `task` and releases the lock.
   */
  async #locked<T>(
    providerId: string,
    options: AuthOperationOptions | undefined,
    task: (lockId: string) => Promise<T>,
  ): Promise<T> {
    await this.#ready();
    const keys = keysOf(providerId);
    const result = await this.#core.request(
      'secrets/lock',
      { keys },
      options?.signal === undefined ? {} : { signal: options.signal },
    );
    if (!isRecord(result) || typeof result.lockId !== 'string') {
      throw new AhpError('invalidRequest', 'secrets/lock returned a malformed result');
    }
    const lockId = result.lockId;
    try {
      const entries = entriesOf('secrets/lock', result);
      for (const key of keys) {
        const entry = entries.find((e) => e.key === key);
        if (entry !== undefined) {
          this.#apply(key, entry.revision, entry.value);
        } else if (this.#entries.has(key)) {
          // Core has no such entry: it was deleted and the notification has not arrived yet.
          this.#entries.delete(key);
        }
      }
      return await task(lockId);
    } finally {
      try {
        await this.#core.request('secrets/unlock', { lockId });
      } catch (error) {
        // Core releases the lock after its lease or when the connection ends.
        this.#log(`releasing credential lock ${lockId} failed: ${describeError(error)}`);
      }
    }
  }
}

function revisionOf(method: string, result: unknown): number {
  if (!isRecord(result) || typeof result.revision !== 'number') {
    throw new AhpError('invalidRequest', `${method} returned a malformed result`);
  }
  return result.revision;
}
