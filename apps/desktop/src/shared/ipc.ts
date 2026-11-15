// The IPC contract between the preload script and the main process: channel names and the
// shape of `window.piarc`. Every channel is registered in the main process through
// `registerHandler` (src/main/ipc/register.ts), which checks the sender's origin first.

/** Channel names, one per `window.piarc` command. */
export const IPC_CHANNELS = {
  getAppVersion: 'piarc:app.getVersion',
  openExternal: 'piarc:shell.openExternal',
  eventsConnect: 'piarc:events.connect',
  eventsSubscribe: 'piarc:events.subscribe',
  eventsUnsubscribe: 'piarc:events.unsubscribe',
} as const;

/**
 * Main → preload message that carries the window's event port (`webContents.postMessage`
 * with the port in its transfer list). Not an invoke channel: nothing is registered for it.
 */
export const EVENTS_PORT_CHANNEL = 'piarc:events.port';

/**
 * One batch of Core events (architecture section 7.6). The main process forwards it by
 * `route` and never reads `payload`.
 */
export interface EventBatch {
  /** Route key the batch was delivered under: a test or demo topic, later a `sessionId`. */
  readonly route: string;
  /** Per-route batch number, starting at 1 and consecutive. */
  readonly seq: number;
  /** UTF-8 JSON array of the batch's events. */
  readonly payload: Uint8Array;
}

/** What the main process posts on a window's event port for one Core delivery. */
export interface EventPortMessage {
  /** The batches of the delivery whose route this window subscribed to. */
  readonly batches: readonly EventBatch[];
}

/** Receives the batches of one route. */
export type EventListener = (batch: EventBatch) => void;

/** Longest route key, in bytes (the limit Core enforces as well). */
export const MAX_ROUTE_KEY_LENGTH = 128;

/** Route keys: 1 to 128 ASCII letters, digits and `. _ : / -` (Core's grammar). */
export function isRouteKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ROUTE_KEY_LENGTH &&
    /^[A-Za-z0-9._:/-]+$/.test(value)
  );
}

/**
 * The API the preload script exposes to the renderer as `window.piarc`. Adding a member
 * means adding a channel above, a handler in the main process, and updating the key
 * snapshot in `e2e/preload.e2e.ts`.
 */
export interface PiarcApi {
  /** The application version (`app.getVersion()`). */
  getAppVersion(): Promise<string>;
  /**
   * Asks the main process to open `url` in the system browser. The main process accepts only
   * `https:`, `http:` and `mailto:` URLs and shows a native confirmation dialog first.
   * Resolves `true` when the link was opened, `false` when it was rejected or cancelled.
   */
  openExternal(url: string): Promise<boolean>;
  /**
   * Receives the Core event batches of `route` in this window. One listener per route:
   * subscribing again replaces it. The listener gets the batch only, never an Electron
   * event object. Resolves once the main process routes `route` to this window.
   */
  subscribeEvents(route: string, listener: EventListener): Promise<void>;
  /** Stops the batches of `route`. Resolves once the main process stopped routing them. */
  unsubscribeEvents(route: string): Promise<void>;
}
