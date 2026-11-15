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
  terminalCreate: 'piarc:terminal.create',
  terminalClose: 'piarc:terminal.close',
  terminalInput: 'piarc:terminal.input',
  terminalKey: 'piarc:terminal.key',
  terminalResize: 'piarc:terminal.resize',
  terminalRequestFrame: 'piarc:terminal.requestFrame',
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

/** Grid size and the cell size in CSS pixels (for pixel size reports). */
export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
}

/** A `KeyboardEvent` as the terminal needs it; Core encodes it with the terminal's modes. */
export interface TerminalKeyMessage {
  readonly action: 'press' | 'repeat' | 'release';
  /** `KeyboardEvent.code`. */
  readonly code: string;
  /** The character the key produced (`KeyboardEvent.key` when it is one grapheme), else ''. */
  readonly text: string;
  /** Bits: 1 Shift, 2 Ctrl, 4 Alt/Option, 8 Meta/Command. */
  readonly mods: number;
  /** Part of an input-method composition. */
  readonly composing: boolean;
}

/** Largest grid side Core accepts. */
export const MAX_TERMINAL_SIDE = 1000;

/** Validates a terminal size received over IPC. */
export function isTerminalSize(value: unknown): value is TerminalSize {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const side = (v: unknown) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_TERMINAL_SIDE;
  const cell = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 256;
  return (
    'cols' in value &&
    side(value.cols) &&
    'rows' in value &&
    side(value.rows) &&
    'cellWidth' in value &&
    cell(value.cellWidth) &&
    'cellHeight' in value &&
    cell(value.cellHeight)
  );
}

/** Validates a key message received over IPC. */
export function isTerminalKeyMessage(value: unknown): value is TerminalKeyMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'action' in value &&
    (value.action === 'press' || value.action === 'repeat' || value.action === 'release') &&
    'code' in value &&
    typeof value.code === 'string' &&
    value.code.length <= 64 &&
    'text' in value &&
    typeof value.text === 'string' &&
    value.text.length <= 64 &&
    'mods' in value &&
    typeof value.mods === 'number' &&
    Number.isInteger(value.mods) &&
    value.mods >= 0 &&
    value.mods <= 15 &&
    'composing' in value &&
    typeof value.composing === 'boolean'
  );
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
  /**
   * Starts a terminal running the user's login shell in the home directory and resolves its
   * id. Its title, bell and exit events arrive on the event route `term/<id>`. The terminal
   * belongs to this window: other windows cannot use it, and it is closed with the window.
   */
  createTerminal(size: TerminalSize): Promise<number>;
  /** Kills the terminal's program and forgets the terminal. */
  closeTerminal(id: number): Promise<void>;
  /** Writes text to the terminal as typed (committed input-method text). */
  terminalInput(id: number, text: string): Promise<void>;
  /** Sends a key event; Core encodes it with the terminal's current modes. */
  terminalKey(id: number, key: TerminalKeyMessage): Promise<void>;
  /** Resizes the terminal and its PTY. */
  terminalResize(id: number, size: TerminalSize): Promise<void>;
  /**
   * Resolves with the terminal's next frame (the draft format of `piarc_protocol::term_frame`;
   * 14 bytes when nothing changed); `full` asks for a RESET frame (after a reload or a decode
   * error). The frame is the reply to this request, not a message on the event port: after a
   * key, Chromium handles event-port messages only after the next rendered frame (ADR-0023).
   * Pull one frame per animation frame, never for a hidden terminal.
   */
  requestTerminalFrame(id: number, full: boolean): Promise<Uint8Array>;
}
