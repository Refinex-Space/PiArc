// What the organization's managed settings lock (T47, design addendum section 5.4). The settings
// window reads Core's `managedSettings` once per page and when the window regains focus; every
// control bound to a setting asks `isManaged` (the same rule as Core's
// `piarc_config::managed::locked`) and, when locked, shows `ManagedBadge` and stays read-only.
// Core refuses a write to a locked setting anyway: the marks are presentation, not the boundary.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

import { useApp } from '../app/app-context.js';

export interface ManagedSource {
  readonly location: string;
  readonly family: 'piarc' | 'claudeCode';
  readonly channel: 'policy' | 'file';
  readonly status: 'loaded' | 'invalid' | 'stale' | 'unreadable';
  readonly issues: readonly string[];
}

export interface ManagedView {
  readonly configured: boolean;
  readonly sources: readonly ManagedSource[];
  /** JSON Pointers of the scalars and objects the managed settings set. */
  readonly locked: readonly string[];
  /** Their values. */
  readonly values: Readonly<Record<string, unknown>>;
  /** Entries the managed settings add to lists, by the list's pointer. */
  readonly entries: Readonly<Record<string, readonly unknown[]>>;
  /** Lists a managed lock takes over (permission rules, hooks, …). */
  readonly taken: readonly string[];
}

export const NO_MANAGED: ManagedView = {
  configured: false,
  sources: [],
  locked: [],
  values: {},
  entries: {},
  taken: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

const STATUSES = ['loaded', 'invalid', 'stale', 'unreadable'] as const;

/** Core's `managedSettings` answer, validated. */
export function parseManagedView(raw: string): ManagedView {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) throw new Error('Invalid managed settings');
  const sources = Array.isArray(value.sources)
    ? value.sources.flatMap((s): ManagedSource[] => {
        if (!isRecord(s) || typeof s.location !== 'string') return [];
        const status = STATUSES.find((x) => x === s.status);
        if (status === undefined) return [];
        return [
          {
            location: s.location,
            family: s.family === 'claudeCode' ? 'claudeCode' : 'piarc',
            channel: s.channel === 'policy' ? 'policy' : 'file',
            status,
            issues: strings(s.issues),
          },
        ];
      })
    : [];
  const entries: Record<string, readonly unknown[]> = {};
  if (isRecord(value.entries)) {
    for (const [pointer, list] of Object.entries(value.entries)) {
      if (Array.isArray(list)) entries[pointer] = list as unknown[];
    }
  }
  return {
    configured: value.configured === true,
    sources,
    locked: strings(value.locked),
    values: isRecord(value.values) ? value.values : {},
    entries,
    taken: strings(value.taken),
  };
}

/**
 * Whether the managed settings lock the setting at `pointer`: a value they set at it, above it
 * or inside it, or a list a managed lock takes over. A list they only add entries to stays
 * editable (its other entries are the user's).
 */
export function isManaged(view: ManagedView, pointer: string): boolean {
  const within = (outer: string, inner: string) => inner === outer || inner.startsWith(`${outer}/`);
  return (
    view.taken.some((list) => within(list, pointer)) ||
    view.locked.some((locked) => within(locked, pointer) || within(pointer, locked))
  );
}

/** `key` as one JSON Pointer token (`a/b` → `a~1b`). */
export function pointerToken(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** The value the managed settings give `pointer`, when they set one. */
export function managedValue(view: ManagedView, pointer: string): unknown {
  return view.values[pointer];
}

interface ManagedState {
  readonly view: ManagedView;
  readonly reload: () => void;
}

const ManagedContext = createContext<ManagedState>({ view: NO_MANAGED, reload: () => undefined });

/** Provides the managed view to the settings window; `page` changes reload it. */
export function ManagedProvider({
  page,
  children,
}: {
  readonly page: string | undefined;
  readonly children: ReactNode;
}) {
  const [view, setView] = useState<ManagedView>(NO_MANAGED);
  const reload = useCallback(() => {
    window.piarc
      .managedSettings()
      .then((raw) => {
        setView(parseManagedView(raw));
      })
      // Without the view nothing is marked; Core still refuses locked writes.
      .catch(() => undefined);
  }, []);
  useEffect(reload, [reload, page]);
  useEffect(() => {
    window.addEventListener('focus', reload);
    return () => {
      window.removeEventListener('focus', reload);
    };
  }, [reload]);
  return <ManagedContext.Provider value={{ view, reload }}>{children}</ManagedContext.Provider>;
}

/** The managed view of the settings window. */
export function useManaged(): ManagedState {
  return useContext(ManagedContext);
}

/** Whether `pointer` is locked, from the window's managed view. */
export function useIsManaged(pointer: string): boolean {
  return isManaged(useManaged().view, pointer);
}

/** The mark next to a control the organization manages. */
export function ManagedBadge({ testId }: { readonly testId?: string }) {
  const { t } = useApp();
  return (
    <span
      className="managed-badge"
      data-testid={testId ?? 'managed-badge'}
      title={t('managed.badgeHint')}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12" focusable="false">
        <path
          fill="currentColor"
          d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-.5V4.5A3.5 3.5 0 0 0 8 1Zm2 5H6V4.5a2 2 0 1 1 4 0V6Z"
        />
      </svg>
      {t('managed.badge')}
    </span>
  );
}

/** The line at the top of the settings window when managed settings exist. */
export function ManagedBanner() {
  const { t } = useApp();
  const { view } = useManaged();
  if (!view.configured) return null;
  const broken = view.sources.some((s) => s.status !== 'loaded');
  return (
    <p className="managed-banner" role="note" data-testid="managed-banner">
      <ManagedBadge testId="managed-banner-badge" />
      <span>{t(broken ? 'managed.bannerProblem' : 'managed.banner')}</span>
      <button
        type="button"
        className="button button-small"
        data-testid="managed-banner-link"
        onClick={() => {
          window.location.hash = '#/settings/diagnostics';
        }}
      >
        {t('managed.bannerLink')}
      </button>
    </p>
  );
}
