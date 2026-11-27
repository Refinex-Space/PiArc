// Core's market answers (ADR-0102) read defensively: a page, a package's details and the
// `core/market` events. Malformed entries are dropped, unknown values become safe defaults; the
// page never trusts a shape it did not check.
import type {
  MarketCounts,
  MarketDetail,
  MarketEntry,
  MarketInstalled,
  MarketKind,
  MarketPage,
  MarketProblem,
  MarketStatus,
} from '@piarc/protocol';

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const bool = (v: unknown): boolean => v === true;
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
const optional = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const KINDS: readonly MarketKind[] = ['extension', 'skill', 'prompt', 'theme'];

function problem(v: unknown): MarketProblem | undefined {
  if (!isRecord(v) || typeof v.code !== 'string') return undefined;
  return { code: v.code, message: str(v.message) };
}

function installed(v: unknown): MarketInstalled | undefined {
  if (!isRecord(v) || typeof v.id !== 'string') return undefined;
  const scope = v.scope === 'user' || v.scope === 'project' ? v.scope : undefined;
  return {
    id: v.id,
    enabled: bool(v.enabled),
    ...(typeof v.version === 'string' ? { version: v.version } : {}),
    ...(typeof v.update === 'string' ? { update: v.update } : {}),
    ...(scope === undefined ? {} : { scope }),
  };
}

export function parseEntry(v: unknown): MarketEntry | undefined {
  if (!isRecord(v) || typeof v.name !== 'string' || typeof v.version !== 'string') return undefined;
  const install = installed(v.installed);
  return {
    name: v.name,
    version: v.version,
    description: str(v.description),
    publisher: str(v.publisher),
    downloadsMonthly: num(v.downloadsMonthly),
    updated: num(v.updated),
    kinds: Array.isArray(v.kinds)
      ? v.kinds.filter((k): k is MarketKind => KINDS.some((known) => known === k))
      : [],
    kindsFromManifest: bool(v.kindsFromManifest),
    insecure: bool(v.insecure),
    deprecated: bool(v.deprecated),
    installing: bool(v.installing),
    ...(install === undefined ? {} : { installed: install }),
  };
}

export function parseStatus(v: unknown): MarketStatus {
  const raw = isRecord(v) ? v : {};
  const state = raw.state === 'syncing' || raw.state === 'failed' ? raw.state : 'idle';
  const issue = problem(raw.problem);
  return {
    state,
    done: num(raw.done),
    total: num(raw.total),
    classified: num(raw.classified),
    indexed: num(raw.indexed),
    ...(typeof raw.syncedAt === 'number' ? { syncedAt: raw.syncedAt } : {}),
    ...(issue === undefined ? {} : { problem: issue }),
  };
}

function counts(v: unknown): MarketCounts {
  const raw = isRecord(v) ? v : {};
  return {
    all: num(raw.all),
    extension: num(raw.extension),
    skill: num(raw.skill),
    prompt: num(raw.prompt),
  };
}

/** A `MarketPage` (throws when the answer is not one). */
export function parsePage(text: string): MarketPage {
  const v: unknown = JSON.parse(text);
  if (!isRecord(v) || !Array.isArray(v.entries)) throw new Error('not a market page');
  return {
    entries: v.entries.flatMap((e: unknown) => {
      const entry = parseEntry(e);
      return entry === undefined ? [] : [entry];
    }),
    total: num(v.total),
    counts: counts(v.counts),
    status: parseStatus(v.status),
    live: bool(v.live),
  };
}

/** A `MarketDetail` (throws when the answer is not one). */
export function parseDetail(text: string): MarketDetail {
  const v: unknown = JSON.parse(text);
  const entry = isRecord(v) ? parseEntry(v.entry) : undefined;
  if (!isRecord(v) || entry === undefined) throw new Error('not a market package');
  const issue = problem(v.problem);
  const opt = (key: string) => {
    const value = optional(v[key]);
    return value === undefined ? {} : { [key]: value };
  };
  return {
    entry,
    keywords: strings(v.keywords),
    readmeTruncated: bool(v.readmeTruncated),
    readmeTooLarge: bool(v.readmeTooLarge),
    installScripts: strings(v.installScripts),
    foreignDependencies: strings(v.foreignDependencies),
    dependencies: strings(v.dependencies),
    ...opt('license'),
    ...opt('npmUrl'),
    ...opt('repositoryUrl'),
    ...opt('homepageUrl'),
    ...opt('readme'),
    ...opt('deprecatedMessage'),
    ...(issue === undefined ? {} : { problem: issue }),
  };
}

/** What a batch of `core/market` events asks the page to do. */
export interface MarketChanges {
  readonly status?: MarketStatus;
  /** The list may have changed (a sync page, kinds, an install). */
  readonly refresh: boolean;
  /** Installs that finished or failed, by name. */
  readonly installs: readonly { name: string; state: string; problem?: MarketProblem }[];
}

export function parseEvents(payload: Uint8Array): MarketChanges {
  let status: MarketStatus | undefined;
  let refresh = false;
  const installs: { name: string; state: string; problem?: MarketProblem }[] = [];
  try {
    const events: unknown = JSON.parse(new TextDecoder().decode(payload));
    for (const e of Array.isArray(events) ? events : []) {
      if (!isRecord(e)) continue;
      if (e.type === 'sync') {
        status = parseStatus(e.status);
        refresh = true;
      } else if (e.type === 'kinds') {
        refresh = true;
      } else if (e.type === 'install' && typeof e.name === 'string') {
        refresh = true;
        const issue = problem(e.problem);
        installs.push({
          name: e.name,
          state: str(e.state),
          ...(issue === undefined ? {} : { problem: issue }),
        });
      }
    }
  } catch {
    // A batch that is not JSON changes nothing.
  }
  return { ...(status === undefined ? {} : { status }), refresh, installs };
}

/** What the primary button of an entry does for the workspace shown. */
export type EntryAction =
  | { readonly kind: 'install' }
  | { readonly kind: 'installing' }
  | { readonly kind: 'update'; readonly version: string; readonly id: string }
  | { readonly kind: 'enable'; readonly id: string; readonly scope: 'user' | 'project' }
  | { readonly kind: 'addHere'; readonly id: string }
  | { readonly kind: 'enabled' };

export function actionOf(entry: MarketEntry, workspace: string | null): EntryAction {
  if (entry.installing) return { kind: 'installing' };
  const installed = entry.installed;
  if (installed == null) return { kind: 'install' };
  if (installed.update != null) {
    return { kind: 'update', version: installed.update, id: installed.id };
  }
  if (installed.scope == null) {
    return workspace === null
      ? { kind: 'enable', id: installed.id, scope: 'user' }
      : { kind: 'addHere', id: installed.id };
  }
  if (!installed.enabled) return { kind: 'enable', id: installed.id, scope: installed.scope };
  return { kind: 'enabled' };
}
