// In-app updates on the page side (ADR-0111): Core's `UpdateStatus` snapshots, checked before
// use (unknown values become safe defaults), and the words the About page and the sidebar
// notice show for them.
import type { UpdateProblem, UpdateRelease, UpdateState, UpdateStatus } from '@piarc/protocol';

import type { Locale, MessageId } from '../../shared/i18n/index.js';

const STATES: readonly UpdateState[] = [
  'idle',
  'checking',
  'upToDate',
  'available',
  'downloading',
  'ready',
  'failed',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function text(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function releaseOf(value: unknown): UpdateRelease | undefined {
  if (!isRecord(value) || typeof value.version !== 'string' || value.version === '') {
    return undefined;
  }
  const notes: Record<string, string> = {};
  if (isRecord(value.notes)) {
    for (const [locale, body] of Object.entries(value.notes)) {
      if (typeof body === 'string') notes[locale] = body.slice(0, 200_000);
    }
  }
  const page = text(value.pageUrl, 2048);
  return {
    version: text(value.version, 64),
    date: text(value.date, 32),
    security: value.security === true,
    notes,
    size: count(value.size),
    pageUrl: page.startsWith('https://') ? page : '',
  };
}

function problemOf(value: unknown): UpdateProblem | undefined {
  if (!isRecord(value) || typeof value.code !== 'string') return undefined;
  return { code: text(value.code, 32), message: text(value.message, 2000) };
}

/** A checked snapshot; `undefined` for anything that is not one. */
export function parseUpdateStatus(raw: unknown): UpdateStatus | undefined {
  const value: unknown = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!isRecord(value)) return undefined;
  const state = STATES.find((s) => s === value.state);
  if (state === undefined) return undefined;
  const release = releaseOf(value.release);
  const problem = problemOf(value.problem);
  const unavailable =
    value.unavailable === 'noTrustedKey' || value.unavailable === 'platform'
      ? value.unavailable
      : undefined;
  return {
    state,
    current: text(value.current, 64),
    ...(unavailable === undefined ? {} : { unavailable }),
    ...(typeof value.checkedAt === 'number' ? { checkedAt: value.checkedAt } : {}),
    ...(release === undefined ? {} : { release }),
    ...(isRecord(value.progress)
      ? {
          progress: {
            received: count(value.progress.received),
            total: count(value.progress.total),
          },
        }
      : {}),
    ...(problem === undefined ? {} : { problem }),
  };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** The last snapshot of a `core/updates` batch (a JSON array of snapshots). */
export function lastStatusOf(payload: Uint8Array): UpdateStatus | undefined {
  const value = safeJson(new TextDecoder().decode(payload));
  if (!Array.isArray(value)) return undefined;
  for (let i = value.length - 1; i >= 0; i--) {
    const status = parseUpdateStatus(value[i]);
    if (status !== undefined) return status;
  }
  return undefined;
}

/** The release notes in `locale`, else English, else none. */
export function notesFor(release: UpdateRelease, locale: Locale): string {
  return release.notes[locale] ?? release.notes.en ?? '';
}

const PROBLEMS: Record<string, MessageId> = {
  network: 'about.problem.network',
  proxy: 'about.problem.proxy',
  tls: 'about.problem.tls',
  timeout: 'about.problem.network',
  refused: 'about.problem.network',
  integrity: 'about.problem.integrity',
  notFound: 'about.problem.notFound',
  disk: 'about.problem.disk',
  diskFull: 'about.problem.diskFull',
};

/** The localized reason of a failed check or download. */
export function problemText(problem: UpdateProblem | null | undefined): MessageId {
  return (problem && PROBLEMS[problem.code]) ?? 'about.problem.other';
}

/** Whether the sidebar shows its notice: a newer release found, downloading or ready. */
export function noticeOf(
  status: UpdateStatus | undefined,
): { readonly version: string; readonly ready: boolean; readonly security: boolean } | undefined {
  const release = status?.release;
  if (status === undefined || release === undefined || release === null) return undefined;
  if (status.state !== 'available' && status.state !== 'downloading' && status.state !== 'ready') {
    return undefined;
  }
  return { version: release.version, ready: status.state === 'ready', security: release.security };
}

/** Download progress in whole percent (0–100). */
export function percentOf(status: UpdateStatus): number {
  const { received = 0, total = 0 } = status.progress ?? {};
  if (total <= 0) return 0;
  return Math.min(100, Math.floor((received / total) * 100));
}
