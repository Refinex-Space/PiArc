// Usage and cost (T41, architecture section 8.2): the session rail's usage card and the
// settings window's "Usage" page read Core's report; the page edits the user's model prices
// (user settings only, read when a report is built). Core does the arithmetic.
import path from 'node:path';

import { IPC_CHANNELS, isSessionId, type ModelPriceInput } from '../../shared/ipc.js';
import type { RegisterHandler } from '../ipc/register.js';
import type { CoreRuntime } from './native/piarc-core.js';

/** The part of Core these commands use. */
export type UsageCore = Pick<CoreRuntime, 'usageReport' | 'sessionUsage' | 'setModelPrice'>;

/** Highest price accepted, in USD per million tokens. */
const MAX_PRICE = 1_000_000;

function workspace(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4096) {
    throw new TypeError('workspace must be an absolute path or null');
  }
  return value;
}

/** A provider or model id: 1-256 characters without control characters. */
export function modelId(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError(`${name} must be 1-256 characters`);
  }
  return value;
}

/** A user's price: the four rates, each a finite number from 0 to `MAX_PRICE`. */
export function modelPrice(value: unknown): ModelPriceInput | null {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid price');
  const record = value as Record<string, unknown>;
  const keys = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
  for (const key of Object.keys(record)) {
    if (!(keys as readonly string[]).includes(key)) throw new TypeError(`unknown price ${key}`);
  }
  const rate = (key: (typeof keys)[number]): number => {
    const v = record[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_PRICE) {
      throw new TypeError(`${key} must be a number from 0 to ${String(MAX_PRICE)}`);
    }
    return v;
  };
  return {
    input: rate('input'),
    output: rate('output'),
    cacheRead: rate('cacheRead'),
    cacheWrite: rate('cacheWrite'),
  };
}

/** Registers the usage commands. */
export function registerUsageHandlers(registerHandler: RegisterHandler, core: UsageCore): void {
  registerHandler(IPC_CHANNELS.usageReport, (_event, [dir]) => core.usageReport(workspace(dir)));
  registerHandler(IPC_CHANNELS.sessionUsage, (_event, [id]) => {
    if (!isSessionId(id)) throw new TypeError('sessionId must be a session id');
    return core.sessionUsage(id);
  });
  registerHandler(IPC_CHANNELS.modelPriceSet, async (_event, [provider, model, price]) => {
    const providerId = modelId(provider, 'provider');
    if (providerId.includes('/')) throw new TypeError('provider must not contain /');
    const parsed = modelPrice(price);
    await core.setModelPrice(
      providerId,
      modelId(model, 'model'),
      parsed === null ? null : JSON.stringify(parsed),
    );
  });
}
