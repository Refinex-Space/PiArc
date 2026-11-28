// One subscription to this window's dictation route, shared by every composer and the settings
// page's microphone test (the preload keeps one listener per route). The route comes from the
// main process (`dictation/<webContentsId>`); only this window may subscribe to it.

type Listener = (payload: Uint8Array) => void;

const listeners = new Set<Listener>();
let route: Promise<string> | undefined;
let subscribed: Promise<void> | undefined;

/** This window's dictation route. */
export function dictationRoute(): Promise<string> {
  route ??= window.piarc.dictationStatus().then((text) => {
    const status: unknown = JSON.parse(text);
    if (
      typeof status === 'object' &&
      status !== null &&
      'route' in status &&
      typeof status.route === 'string'
    ) {
      return status.route;
    }
    throw new TypeError('dictation status without a route');
  });
  return route;
}

async function ensureSubscribed(): Promise<void> {
  subscribed ??= dictationRoute().then((key) =>
    window.piarc.subscribeEvents(key, (batch) => {
      for (const listener of listeners) listener(batch.payload);
    }),
  );
  try {
    await subscribed;
  } catch (error: unknown) {
    subscribed = undefined;
    throw error;
  }
}

/** Calls `listener` with every batch of this window's dictation events until unsubscribed. */
export function onDictationEvents(listener: Listener): () => void {
  listeners.add(listener);
  void ensureSubscribed().catch((error: unknown) => {
    console.error('[dictation] cannot subscribe to the window route', error);
  });
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && subscribed !== undefined) {
      subscribed = undefined;
      void dictationRoute().then((key) => window.piarc.unsubscribeEvents(key));
    }
  };
}

/** Composers that can take the dictation shortcut, the most recently shown last. */
const toggles: (() => void)[] = [];

/** The `composer.dictation` shortcut: starts or stops dictation in the composer on screen. */
export function requestDictationToggle(): void {
  toggles.at(-1)?.();
}

/** Makes `toggle` the shortcut's target until the returned function is called. */
export function onDictationToggle(toggle: () => void): () => void {
  toggles.push(toggle);
  return () => {
    const at = toggles.lastIndexOf(toggle);
    if (at >= 0) toggles.splice(at, 1);
  };
}
