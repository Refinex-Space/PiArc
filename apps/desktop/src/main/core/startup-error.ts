// What the user reads when Core does not start (T47, design addendum section 8.1): invalid
// managed settings name their source and position, anything else says Core failed to load.
// The system's language decides, since the user's language setting is read by Core itself.
import type { Translator } from '../../shared/i18n/index.js';

export interface StartupFailure {
  readonly title: string;
  readonly message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The managed source's details of a `managedSettingsInvalid` error, or undefined. */
function managedDetails(
  error: unknown,
): { location: string; reason: string; line?: number; column?: number } | undefined {
  if (!(error instanceof Error)) return undefined;
  const data: unknown = Reflect.get(error, 'data');
  if (!isRecord(data) || data.kind !== 'managedSettingsInvalid' || !isRecord(data.details)) {
    return undefined;
  }
  const { location, reason, line, column } = data.details;
  if (typeof location !== 'string' || typeof reason !== 'string') return undefined;
  return {
    location,
    reason,
    ...(typeof line === 'number' ? { line } : {}),
    ...(typeof column === 'number' ? { column } : {}),
  };
}

/** The native error dialog's text for Core's start `error`. */
export function startupFailure(error: unknown, t: Translator): StartupFailure {
  const title = t.t('startup.failed.title');
  const managed = managedDetails(error);
  if (managed === undefined) {
    const reason = error instanceof Error ? error.message : String(error);
    return { title, message: t.t('startup.failed.core', { reason }) };
  }
  const position =
    managed.line === undefined
      ? ''
      : t.t('startup.managed.position', { line: managed.line, column: managed.column ?? 1 });
  return {
    title,
    message: t.t('startup.managed.message', {
      location: managed.location,
      reason: managed.reason,
      position,
    }),
  };
}
