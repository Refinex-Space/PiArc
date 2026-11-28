// The Pi package market of the settings window (ADR-0102). Core finds packages in the npm
// registry and installs one through the extension package manager; the page only ever sends a
// query, an npm name and an exact version, never a spec, URL or path, so it cannot make npm
// reach anything else. Installing runs no package code and leaves the package off: turning it
// on still goes through `setPackageEnabled`'s native confirmation.
import path from 'node:path';

import { IPC_CHANNELS, type MarketInstallInput, type MarketQueryInput } from '../../shared/ipc.js';
import type { RegisterHandler } from '../ipc/register.js';
import type { CoreRuntime } from './native/piarc-core.js';

/** The part of Core these commands use. */
export type MarketCore = Pick<
  CoreRuntime,
  'marketQuery' | 'marketDetail' | 'marketRefresh' | 'marketInstall'
>;

const MAX_PATH = 4096;
const CATEGORIES = ['all', 'extension', 'skill', 'prompt'] as const;
const SORTS = ['popular', 'updated'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function workspace(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > MAX_PATH) {
    throw new TypeError('workspace must be an absolute path or null');
  }
  return value;
}

/** npm's name rules for new packages (Core checks again): `name` or `@scope/name`. */
export function npmName(value: unknown): string {
  const part = /^(?![._])[a-z0-9\-._~]+$/u;
  const ok =
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 214 &&
    (value.startsWith('@')
      ? value.slice(1).split('/').length === 2 &&
        value
          .slice(1)
          .split('/')
          .every((p) => part.test(p))
      : part.test(value));
  if (!ok) throw new TypeError('name must be an npm package name');
  return value;
}

/** An exact semantic version: no range, tag, URL or path. */
export function exactVersion(value: unknown): string {
  const semver =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
  if (typeof value !== 'string' || value.length > 256 || !semver.test(value)) {
    throw new TypeError('version must be an exact semantic version');
  }
  return value;
}

/** A validated market query. */
export function marketQuery(raw: unknown): MarketQueryInput {
  if (!isRecord(raw)) throw new TypeError('invalid market query');
  const query = raw.query ?? '';
  if (typeof query !== 'string' || query.length > 200 || hasControl(query)) {
    throw new TypeError('query must be at most 200 characters without control characters');
  }
  const category = raw.category ?? 'all';
  const sort = raw.sort ?? 'popular';
  if (!CATEGORIES.some((c) => c === category)) throw new TypeError('unknown category');
  if (!SORTS.some((s) => s === sort)) throw new TypeError('unknown sort');
  const offset = raw.offset ?? 0;
  const limit = raw.limit;
  if (!Number.isSafeInteger(offset) || typeof offset !== 'number' || offset < 0 || offset > 20000) {
    throw new TypeError('offset must be 0–20000');
  }
  if (!Number.isSafeInteger(limit) || typeof limit !== 'number' || limit < 1 || limit > 100) {
    throw new TypeError('limit must be 1–100');
  }
  return {
    query,
    category: category as MarketQueryInput['category'],
    sort: sort as MarketQueryInput['sort'],
    offset,
    limit,
    workspace: workspace(raw.workspace),
  };
}

/** A validated install request. */
export function marketInstall(raw: unknown): MarketInstallInput {
  if (!isRecord(raw)) throw new TypeError('invalid market install request');
  if (raw.scope !== 'user' && raw.scope !== 'project') {
    throw new TypeError('scope must be user or project');
  }
  const root = workspace(raw.workspace);
  if (raw.scope === 'project' && root === null) {
    throw new TypeError('the project scope needs a workspace');
  }
  return {
    name: npmName(raw.name),
    version: exactVersion(raw.version),
    scope: raw.scope,
    workspace: root,
  };
}

function withoutNull<T extends { workspace: string | null }>(value: T) {
  const { workspace: root, ...rest } = value;
  return root === null ? rest : { ...rest, workspace: root };
}

export function registerMarketHandlers(registerHandler: RegisterHandler, core: MarketCore): void {
  registerHandler(IPC_CHANNELS.marketQuery, (_event, [raw]) =>
    core.marketQuery(JSON.stringify(withoutNull(marketQuery(raw)))),
  );
  registerHandler(IPC_CHANNELS.marketDetail, (_event, [name, dir]) =>
    core.marketDetail(npmName(name), workspace(dir)),
  );
  registerHandler(IPC_CHANNELS.marketRefresh, () => core.marketRefresh());
  registerHandler(IPC_CHANNELS.marketInstall, (_event, [raw]) =>
    core.marketInstall(JSON.stringify(withoutNull(marketInstall(raw)))),
  );
}
