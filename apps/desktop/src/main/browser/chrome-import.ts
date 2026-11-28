// Chrome sign-in import in the main process (ADR-0090, design addendum B5.1–B5.4). The user
// picks a Chrome profile and ticks sites in the settings page; this module shows the native
// confirmation (the agent will act as them on these sites, the import is a copy, macOS will
// ask for the keychain and "Allow" is enough), asks Core to decrypt (Core reads the key once,
// records the sites and audits them) and writes the cookies into the workspace's persistent
// partition. Cookie values never reach a page: the page gets per-site counts only. Removing a
// site deletes its cookies from the partition first and Core's record after, so a site with
// imported cookies is always on record (and sensitive for the agent).
import { session as sessions, type BrowserWindow, type Session } from 'electron';

import type { Translator } from '../../shared/i18n/index.js';
import type { ShownConfirmation } from '../core/plugins-ipc.js';
import type { CoreRuntime } from '../core/native/piarc-core.js';
import { partitionKey, partitionName, type BrowserStorage } from './partitions.js';

/** The part of Core the import uses. */
export type ImportCore = Pick<
  CoreRuntime,
  'chromeProfiles' | 'chromeSites' | 'chromeImport' | 'browserImports' | 'forgetBrowserImport'
>;

/** Sites one import may take (Core's `MAX_SITES`). */
export const MAX_IMPORT_SITES = 50;
const MAX_PATH = 4096;

/** The native confirmation (`NativeConfirm` in production, a stub in tests). */
export interface Confirm {
  ask(
    window: BrowserWindow | null,
    text: ShownConfirmation,
    buttons: readonly [string, string],
  ): Promise<boolean>;
}

/** Whether `host` gets cookies of the imported `site`: the site or one of its subdomains. */
export function covered(host: string, site: string): boolean {
  const name = host
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  const root = site
    .replace(/^\./, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return root !== '' && (name === root || name.endsWith(`.${root}`));
}

/** Whether `host` gets cookies of any of `sites` (B5.4: sensitive for the agent). */
export function importedHost(host: string, sites: readonly string[]): boolean {
  return sites.some((site) => covered(host, site));
}

/** A site name as Core lists it: a lowercase host name or IP literal. */
export function isSite(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 253 &&
    !value.startsWith('.') &&
    /^[a-z0-9._:[\]-]+$/.test(value)
  );
}

/** A Chrome profile directory name (`Default`, `Profile 1`). */
export function isProfileId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    value !== '.' &&
    value !== '..' &&
    // eslint-disable-next-line no-control-regex -- control characters are what is refused
    !/[/\\:\u0000-\u001f\u007f]/.test(value)
  );
}

/** An absolute workspace path from a page. */
export function workspaceArg(value: unknown, isAbsolute: (p: string) => boolean): string {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.length > MAX_PATH ||
    // eslint-disable-next-line no-control-regex -- control characters are what is refused
    /[\u0000-\u001f\u007f]/.test(value) ||
    !isAbsolute(value)
  ) {
    throw new TypeError('workspace must be an absolute path');
  }
  return value;
}

/** The sites of an import request: 1–50 distinct site names. */
export function sitesArg(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IMPORT_SITES) {
    throw new TypeError(`sites must list 1 to ${String(MAX_IMPORT_SITES)} sites`);
  }
  const sites = value.filter(isSite);
  if (sites.length !== value.length) throw new TypeError('sites must be site names');
  return [...new Set(sites)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One cookie of Core's answer, in `cookies.set`'s shape. */
export interface ImportedCookie {
  readonly site: string;
  readonly url: string;
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly expirationDate?: number;
  readonly sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
}

/** Cookies skipped for one reason (Core's reasons, plus `rejected` by the partition). */
export interface SkippedCount {
  readonly reason: string;
  readonly count: number;
}

/** What one site gave. */
export interface SiteOutcome {
  readonly site: string;
  readonly imported: number;
  readonly skipped: readonly SkippedCount[];
}

const SAME_SITE = new Set(['unspecified', 'no_restriction', 'lax', 'strict']);

function cookieOf(raw: unknown): ImportedCookie | undefined {
  if (!isRecord(raw)) return undefined;
  const { site, url, name, value, domain, path, secure, httpOnly, expirationDate, sameSite } = raw;
  if (
    !isSite(site) ||
    typeof url !== 'string' ||
    !/^https?:\/\//.test(url) ||
    typeof name !== 'string' ||
    typeof value !== 'string' ||
    typeof path !== 'string' ||
    typeof secure !== 'boolean' ||
    typeof httpOnly !== 'boolean' ||
    typeof sameSite !== 'string' ||
    !SAME_SITE.has(sameSite) ||
    (domain !== undefined && typeof domain !== 'string') ||
    (expirationDate !== undefined && typeof expirationDate !== 'number')
  ) {
    return undefined;
  }
  return {
    site,
    url,
    name,
    value,
    path,
    secure,
    httpOnly,
    sameSite: sameSite as ImportedCookie['sameSite'],
    ...(domain === undefined ? {} : { domain }),
    ...(expirationDate === undefined ? {} : { expirationDate }),
  };
}

function skippedOf(raw: unknown): SkippedCount[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((s: unknown) =>
    isRecord(s) && typeof s.reason === 'string' && typeof s.count === 'number'
      ? [{ reason: s.reason, count: s.count }]
      : [],
  );
}

/** Core's import answer, checked; `undefined` when it is not one. */
export function parseImport(
  text: string,
): { cookies: ImportedCookie[]; sites: SiteOutcome[] } | undefined {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !Array.isArray(value.cookies) || !Array.isArray(value.sites)) {
    return undefined;
  }
  const cookies = value.cookies.map(cookieOf);
  if (cookies.some((c) => c === undefined)) return undefined;
  const sites = value.sites.flatMap((s: unknown) =>
    isRecord(s) && isSite(s.site) && typeof s.imported === 'number'
      ? [{ site: s.site, imported: s.imported, skipped: skippedOf(s.skipped) }]
      : [],
  );
  return { cookies: cookies.filter((c): c is ImportedCookie => c !== undefined), sites };
}

/** The sites of Core's `browserImports` answer. */
export function importedSites(text: string): string[] {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !Array.isArray(value.imports)) return [];
  return value.imports.flatMap((i: unknown) => (isRecord(i) && isSite(i.site) ? [i.site] : []));
}

/** The text of the native confirmation for importing `sites` from profile `profile`. */
export function confirmationText(
  t: Translator,
  profile: string,
  sites: readonly string[],
  platform: string,
): ShownConfirmation {
  const lines = [
    t.t('browserImport.confirm.sites', { profile }),
    sites.map((site) => `• ${site}`).join('\n'),
    t.t('browserImport.confirm.agent'),
    t.t('browserImport.confirm.copy'),
    ...(platform === 'darwin' ? [t.t('browserImport.confirm.keychain')] : []),
  ];
  return {
    message: t.t('browserImport.confirm.title', { count: sites.length }),
    detail: lines.join('\n\n'),
  };
}

/** The outcome a page sees: never a cookie value. */
export type ImportOutcome =
  | { readonly status: 'imported'; readonly sites: readonly SiteOutcome[] }
  | { readonly status: 'cancelled' }
  | { readonly status: 'unavailable' };

export interface ChromeImportDeps {
  readonly core: ImportCore;
  /** How browsing data is kept now (B5.5): no import in the clear-on-quit mode. */
  storage(): BrowserStorage;
  translator(): Translator;
  readonly confirm: Confirm;
  readonly platform: string;
  /** The workspace's persistent partition (Electron's session in production). */
  partition(workspace: string): CookieJar;
}

/** The part of Electron's `Session` the import uses. */
export interface CookieJar {
  readonly cookies: Pick<Session['cookies'], 'set' | 'get' | 'remove' | 'flushStore'>;
  clearStorageData(): Promise<void>;
  clearCache(): Promise<void>;
  clearAuthCache(): Promise<void>;
}

/** The persistent partition of `workspace`, as the browser service names it. */
export function persistentPartition(workspace: string): Session {
  return sessions.fromPartition(partitionName(partitionKey(workspace, 'persist'), 'persist'));
}

export class ChromeImports {
  /** Imported sites by workspace, read from Core once and after each change. */
  readonly #sites = new Map<string, Promise<readonly string[]>>();

  constructor(private readonly deps: ChromeImportDeps) {}

  /** The imported sites of `workspace` (cached). */
  sites(workspace: string): Promise<readonly string[]> {
    let cached = this.#sites.get(workspace);
    if (cached === undefined) {
      cached = this.deps.core.browserImports(workspace).then(importedSites);
      // A failed read is not kept: the next question asks Core again.
      cached.catch(() => this.#sites.delete(workspace));
      this.#sites.set(workspace, cached);
    }
    return cached;
  }

  /** Whether `host` gets imported cookies in `workspace`. */
  async covers(workspace: string, host: string): Promise<boolean> {
    return importedHost(host, await this.sites(workspace));
  }

  /** Confirms with the user, imports through Core and writes the cookies into the partition. */
  async import(
    window: BrowserWindow | null,
    workspace: string,
    profile: string,
    sites: readonly string[],
  ): Promise<ImportOutcome> {
    if (this.deps.storage() !== 'persist') return { status: 'unavailable' };
    const name = await this.#profileName(profile);
    const t = this.deps.translator();
    const text = confirmationText(t, name, sites, this.deps.platform);
    const buttons = [t.t('browserImport.confirm.import'), t.t('dialog.cancel')] as const;
    if (!(await this.deps.confirm.ask(window, text, buttons))) return { status: 'cancelled' };
    this.#sites.delete(workspace);
    const answer = parseImport(
      await this.deps.core.chromeImport(JSON.stringify({ workspace, profile, sites })),
    );
    this.#sites.delete(workspace);
    if (answer === undefined) throw new Error('Core answered an invalid import');
    const jar = this.deps.partition(workspace);
    const rejected = new Map<string, number>();
    for (const cookie of answer.cookies) {
      try {
        await jar.cookies.set({
          url: cookie.url,
          name: cookie.name,
          value: cookie.value,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite,
          ...(cookie.domain === undefined ? {} : { domain: cookie.domain }),
          ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
        });
      } catch {
        // Chromium's reason may quote the cookie: only the count is kept.
        rejected.set(cookie.site, (rejected.get(cookie.site) ?? 0) + 1);
      }
    }
    answer.cookies.length = 0;
    await jar.cookies.flushStore();
    return {
      status: 'imported',
      sites: answer.sites.map((site) => {
        const refused = rejected.get(site.site) ?? 0;
        return {
          site: site.site,
          imported: site.imported - refused,
          skipped:
            refused === 0
              ? site.skipped
              : [...site.skipped, { reason: 'rejected', count: refused }],
        };
      }),
    };
  }

  /** Deletes `site`'s cookies from the partition, then Core's record of it. */
  async forget(workspace: string, site: string): Promise<string> {
    const jar = this.deps.partition(workspace);
    for (const cookie of await jar.cookies.get({ domain: site })) {
      const domain = (cookie.domain ?? '').replace(/^\./, '');
      if (domain !== site) continue;
      const scheme = cookie.secure === true ? 'https' : 'http';
      await jar.cookies.remove(`${scheme}://${domain}${cookie.path ?? '/'}`, cookie.name);
    }
    await jar.cookies.flushStore();
    this.#sites.delete(workspace);
    const answer = await this.deps.core.forgetBrowserImport(workspace, site);
    this.#sites.delete(workspace);
    return answer;
  }

  /**
   * Clears the workspace's browsing data (B5.5): storage, cache, HTTP sign-ins; the imported
   * cookies go with it, so their records are removed after.
   */
  async clearWorkspace(workspace: string): Promise<void> {
    const jar = this.deps.partition(workspace);
    await jar.clearStorageData();
    await jar.clearCache();
    await jar.clearAuthCache();
    this.#sites.delete(workspace);
    for (const site of importedSites(await this.deps.core.browserImports(workspace))) {
      await this.deps.core.forgetBrowserImport(workspace, site);
    }
    this.#sites.delete(workspace);
  }

  async #profileName(profile: string): Promise<string> {
    const value: unknown = JSON.parse(await this.deps.core.chromeProfiles());
    const profiles: unknown[] =
      isRecord(value) && Array.isArray(value.profiles) ? (value.profiles as unknown[]) : [];
    const found = profiles.find((p) => isRecord(p) && p.id === profile);
    if (!isRecord(found)) throw new TypeError(`no Chrome profile ${profile}`);
    return typeof found.name === 'string' ? found.name : profile;
  }
}
