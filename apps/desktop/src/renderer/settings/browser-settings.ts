// The "Browser" settings page's data (design addendum B5.5): Core's and the main process's
// answers checked before use, the site list's filter for the import dialog, and the agent's
// allowed sites among the user's permission rules.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

export interface ChromeProfile {
  readonly id: string;
  readonly name: string;
}

/** `chromeProfiles`: whether Chrome's folder is there, and its profiles. */
export function parseProfiles(raw: string): { chrome: boolean; profiles: ChromeProfile[] } {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) return { chrome: false, profiles: [] };
  const profiles = Array.isArray(value.profiles)
    ? value.profiles.flatMap((p: unknown) => {
        if (!isRecord(p)) return [];
        const id = text(p.id);
        return id === undefined ? [] : [{ id, name: text(p.name) ?? id }];
      })
    : [];
  return { chrome: value.chrome === true, profiles };
}

export interface SiteCount {
  readonly site: string;
  readonly count: number;
}

/** `chromeSites`: the profile's sites with their cookie counts. */
export function parseSites(raw: string): SiteCount[] {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || !Array.isArray(value.sites)) return [];
  return value.sites.flatMap((s: unknown) => {
    if (!isRecord(s)) return [];
    const site = text(s.site);
    return site === undefined ? [] : [{ site, count: count(s.count) }];
  });
}

export interface ImportedSite {
  readonly site: string;
  readonly count: number;
  readonly profile: string;
  /** Unix milliseconds. */
  readonly importedAt: number;
}

/** `browserImports`: the workspace's imported sites. */
export function parseImports(raw: string): ImportedSite[] {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || !Array.isArray(value.imports)) return [];
  return value.imports.flatMap((i: unknown) => {
    if (!isRecord(i)) return [];
    const site = text(i.site);
    if (site === undefined) return [];
    return [
      {
        site,
        count: count(i.count),
        profile: text(i.profile) ?? '',
        importedAt: count(i.importedAt),
      },
    ];
  });
}

export interface SkippedCount {
  readonly reason: string;
  readonly count: number;
}

export interface SiteOutcome {
  readonly site: string;
  readonly imported: number;
  readonly skipped: readonly SkippedCount[];
}

export type ImportOutcome =
  | { readonly status: 'imported'; readonly sites: readonly SiteOutcome[] }
  | { readonly status: 'cancelled' }
  | { readonly status: 'unavailable' };

/** `chromeImport`'s outcome (counts only). */
export function parseOutcome(raw: string): ImportOutcome {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) throw new Error('Invalid import outcome');
  if (value.status === 'cancelled') return { status: 'cancelled' };
  if (value.status === 'unavailable') return { status: 'unavailable' };
  if (value.status !== 'imported' || !Array.isArray(value.sites)) {
    throw new Error('Invalid import outcome');
  }
  return {
    status: 'imported',
    sites: value.sites.flatMap((s: unknown) => {
      if (!isRecord(s)) return [];
      const site = text(s.site);
      if (site === undefined) return [];
      const skipped = Array.isArray(s.skipped)
        ? s.skipped.flatMap((k: unknown) => {
            if (!isRecord(k)) return [];
            const reason = text(k.reason);
            return reason === undefined ? [] : [{ reason, count: count(k.count) }];
          })
        : [];
      return [{ site, imported: count(s.imported), skipped }];
    }),
  };
}

/** Whether `site`'s cookies go to `host` or `site` is under `host` (the page's site). */
export function relatedToHost(site: string, host: string): boolean {
  const name = host.replace(/\.$/, '').toLowerCase();
  return site === name || name.endsWith(`.${site}`) || site.endsWith(`.${name}`);
}

/**
 * The sites the dialog lists: those related to `forHost` when given (the site information
 * menu), filtered by `query` (a substring of the site).
 */
export function visibleSites(
  sites: readonly SiteCount[],
  query: string,
  forHost?: string,
): SiteCount[] {
  const needle = query.trim().toLowerCase();
  return sites.filter(
    (s) =>
      (forHost === undefined || relatedToHost(s.site, forHost)) &&
      (needle === '' || s.site.includes(needle)),
  );
}

/** The domain of a `Browser(domain:…)` rule, or undefined for another rule. */
export function browserDomain(rule: string): string | undefined {
  return /^Browser\(domain:([^)\s]+)\)$/.exec(rule.trim())?.[1];
}

/** The sites the agent may always visit: the user file's `Browser(domain:…)` allow rules. */
export function agentSites(view: unknown): string[] {
  if (!isRecord(view) || !Array.isArray(view.sources)) return [];
  const sources: unknown[] = view.sources;
  const user = sources.find((s) => isRecord(s) && s.id === 'user');
  if (!isRecord(user) || !Array.isArray(user.rules)) return [];
  return user.rules.flatMap((r: unknown) => {
    if (!isRecord(r) || r.behavior !== 'allow') return [];
    const rule = text(r.rule);
    return rule !== undefined && browserDomain(rule) !== undefined ? [rule] : [];
  });
}

/** Local development names typed as a list (commas, spaces or new lines). */
export function splitNames(input: string): string[] {
  return [
    ...new Set(
      input
        .split(/[\s,]+/u)
        .map((n) => n.trim().toLowerCase())
        .filter((n) => n !== ''),
    ),
  ];
}
