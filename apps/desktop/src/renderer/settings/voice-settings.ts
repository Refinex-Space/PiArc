// The speech models as the settings page shows them (`SpeechModels` of `speechModels` and of
// `core/speech` events), checked before use.

export type SpeechModelState =
  'ready' | 'missing' | 'corrupt' | 'downloading' | 'verifying' | 'failed';

export interface SpeechModelView {
  readonly id: string;
  readonly kind: 'base' | 'enhanced';
  readonly version: string;
  readonly state: SpeechModelState;
  readonly installedBytes: number;
  readonly downloadBytes: number;
  readonly receivedBytes?: number;
  readonly error?: string;
  readonly active: boolean;
}

const STATES = new Set<string>([
  'ready',
  'missing',
  'corrupt',
  'downloading',
  'verifying',
  'failed',
]);

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function modelOf(value: unknown): SpeechModelView | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const id: unknown = Reflect.get(value, 'id');
  const kind: unknown = Reflect.get(value, 'kind');
  const version: unknown = Reflect.get(value, 'version');
  const state: unknown = Reflect.get(value, 'state');
  const installed: unknown = Reflect.get(value, 'installedBytes');
  const download: unknown = Reflect.get(value, 'downloadBytes');
  const received: unknown = Reflect.get(value, 'receivedBytes');
  const error: unknown = Reflect.get(value, 'error');
  const active: unknown = Reflect.get(value, 'active');
  if (
    typeof id !== 'string' ||
    (kind !== 'base' && kind !== 'enhanced') ||
    typeof version !== 'string' ||
    typeof state !== 'string' ||
    !STATES.has(state) ||
    !count(installed) ||
    !count(download) ||
    typeof active !== 'boolean'
  ) {
    return undefined;
  }
  return {
    id,
    kind,
    version,
    state: state as SpeechModelState,
    installedBytes: installed,
    downloadBytes: download,
    ...(count(received) ? { receivedBytes: received } : {}),
    ...(typeof error === 'string' && /^[A-Za-z]{1,64}$/u.test(error) ? { error } : {}),
    active,
  };
}

/** The models of a `SpeechModels` JSON text or decoded object. */
export function parseSpeechModels(raw: unknown): readonly SpeechModelView[] {
  const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (typeof value !== 'object' || value === null) return [];
  const models: unknown = Reflect.get(value, 'models');
  if (!Array.isArray(models)) return [];
  return models.map(modelOf).filter((m): m is SpeechModelView => m !== undefined);
}

/** Calls `listener` with each `core/speech` payload (the latest state of every model). */
export function onSpeechModels(listener: (models: unknown) => void): () => void {
  let active = true;
  void window.piarc.subscribeEvents('core/speech', (batch) => {
    if (!active) return;
    try {
      const events: unknown = JSON.parse(new TextDecoder().decode(batch.payload));
      if (Array.isArray(events) && events.length > 0) listener(events.at(-1));
    } catch {
      // A malformed batch is ignored; the next one carries the full state again.
    }
  });
  return () => {
    active = false;
    void window.piarc.unsubscribeEvents('core/speech');
  };
}
