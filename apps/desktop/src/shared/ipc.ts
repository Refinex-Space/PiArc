// The IPC contract between the preload script and the main process: channel names and the
// shape of `window.piarc`. Every channel is registered in the main process through
// `registerHandler` (src/main/ipc/register.ts), which checks the sender's origin first.
import type {
  ModelRef,
  ApprovalAnswer,
  DiscardRequest,
  PermissionMode,
  InputAttachment,
  InputMention,
  RewindRequest,
} from '@piarc/protocol';

import type { CommandId } from './keybindings.js';
import type { Locale } from './i18n/index.js';
import type { PreferenceChange, Preferences } from './preferences.js';

export type { ApprovalAnswer, PermissionMode } from '@piarc/protocol';

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
  appState: 'piarc:app.state',
  preferencesSet: 'piarc:preferences.set',
  settingsOpen: 'piarc:settings.open',
  folderDialog: 'piarc:workspace.folderDialog',
  workspaceOpen: 'piarc:workspace.open',
  sessionCreate: 'piarc:session.create',
  sessionResume: 'piarc:session.resume',
  sessionClose: 'piarc:session.close',
  sessionPrompt: 'piarc:session.prompt',
  sessionSteer: 'piarc:session.steer',
  sessionFollowUp: 'piarc:session.followUp',
  sessionAbort: 'piarc:session.abort',
  sessionPermissionMode: 'piarc:session.permissionMode',
  approvalAnswer: 'piarc:approval.answer',
  sessionCompact: 'piarc:session.compact',
  sessionContextUsage: 'piarc:session.contextUsage',
  sessionRewindPreview: 'piarc:session.rewindPreview',
  sessionRewind: 'piarc:session.rewind',
  sessionUndoRewind: 'piarc:session.undoRewind',
  sessionChanges: 'piarc:session.changes',
  sessionDiscardChange: 'piarc:session.discardChange',
  sessionSwitchBranch: 'piarc:session.switchBranch',
  sessionFork: 'piarc:session.fork',
  queueEdit: 'piarc:session.queueEdit',
  queueDelete: 'piarc:session.queueDelete',
  attachmentStore: 'piarc:session.attachmentStore',
  filesSearch: 'piarc:files.search',
  filesCancel: 'piarc:files.cancel',
  providerSettings: 'piarc:providers.list',
  saveProvider: 'piarc:providers.save',
  deleteProvider: 'piarc:providers.delete',
  setCatalogRefresh: 'piarc:providers.catalogRefresh',
  workspaceModels: 'piarc:workspace.models',
  sessionModels: 'piarc:session.models',
  previewModelSwitch: 'piarc:session.previewModelSwitch',
  setSessionModel: 'piarc:session.setModel',
  setSessionEffort: 'piarc:session.setEffort',
  composerInfo: 'piarc:composer.info',
  sessionMarkRead: 'piarc:session.markRead',
  sessionRename: 'piarc:session.rename',
  sessionSetPinned: 'piarc:session.setPinned',
  sessionSetArchived: 'piarc:session.setArchived',
  sessionDelete: 'piarc:session.delete',
  sessionTranscript: 'piarc:session.transcript',
  snapshotsResend: 'piarc:snapshots.resend',
  trustGet: 'piarc:trust.get',
  trustDecide: 'piarc:trust.decide',
  attentionNotify: 'piarc:attention.notify',
  attentionCount: 'piarc:attention.count',
  permissionRules: 'piarc:permissions.rules',
  permissionCheck: 'piarc:permissions.check',
  permissionUpdate: 'piarc:permissions.update',
  auditEvents: 'piarc:permissions.audit',
  configDiagnostics: 'piarc:config.diagnostics',
} as const;

/** The list a permission rule is in. */
export type RuleBehavior = 'allow' | 'ask' | 'deny';

/** Writable settings files the permission page may change (T23). */
export const RULE_LAYERS = ['projectLocal', 'project', 'user'] as const;
export type RuleLayer = (typeof RULE_LAYERS)[number];

/** Add (no `old`), replace, or remove (no `rule`) one rule of a writable source. */
export interface PermissionRuleChange {
  readonly workspace: string;
  readonly layer: RuleLayer;
  readonly behavior: RuleBehavior;
  readonly old?: string;
  readonly rule?: string;
}

/** Filters of the permission audit view; absent fields match everything. */
export interface AuditQuery {
  readonly workspace?: string;
  readonly sessionId?: string;
  readonly tool?: string;
  readonly conclusion?: 'allow' | 'deny';
  readonly since?: number;
  readonly limit?: number;
}

/**
 * Main → preload messages about the app (`webContents.send`): preference changes, commands
 * from the menu, focus changes. Not an invoke channel.
 */
export const APP_EVENT_CHANNEL = 'piarc:app.event';

/** Commands the main process sends to a window: shortcuts plus menu-only commands. */
export type AppCommand = CommandId | 'workspace.openFolder' | 'view.toggleSidebar';

/** What a window learns about the app when it starts. */
export interface AppState {
  /** `process.platform` of the main process. */
  readonly platform: string;
  readonly preferences: Preferences;
  /** The locale the preferences and the system languages resolve to. */
  readonly locale: Locale;
  /** Whether the asking window is the one in front (keyboard focus). */
  readonly focused: boolean;
}

/** Messages on `APP_EVENT_CHANNEL`. */
export type AppEvent =
  | { readonly type: 'preferences'; readonly preferences: Preferences; readonly locale: Locale }
  | { readonly type: 'providersChanged' }
  | { readonly type: 'command'; readonly command: AppCommand }
  | { readonly type: 'openSession'; readonly sessionId: string }
  /**
   * The window came to the front or left it. The main process tells: a page cannot trust
   * `document.hasFocus()` for this (it stays true under automation and in some window
   * arrangements).
   */
  | { readonly type: 'focus'; readonly focused: boolean };

/** Something the user should look at (architecture section 8.8): the main process notifies. */
export interface AttentionNotice {
  readonly kind: 'completed' | 'awaiting' | 'failed';
  readonly sessionId: string;
  /** The session's title as the sidebar shows it. */
  readonly title: string;
}

/** Longest text the renderer may send as one prompt (bytes of UTF-16 code units). */
export const MAX_PROMPT_LENGTH = 1_000_000;

/**
 * Largest attachment the main process passes to Core. Core enforces the real limits per kind
 * (`composerInfo().attachments`); this only bounds what one IPC message may carry.
 */
export const MAX_ATTACHMENT_IPC_BYTES = 33 * 1024 * 1024;

/**
 * What the composer sends (ADR-0030): the text the model reads (mentions spelled `@<path>`),
 * where the mentions are, the attachments Core stored for this session, and the client's
 * idempotency key, so sending the same message again does not repeat it.
 */
export interface OutgoingInput {
  readonly requestId: string;
  readonly text: string;
  readonly mentions: readonly InputMention[];
  readonly attachments: readonly InputAttachment[];
}

/** Session ids as Core accepts them (`piarc_core::sessions::check_session_id`). */
export function isSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 128 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value)
  );
}

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

  /** Platform, preferences and locale, for the first render. */
  getAppState(): Promise<AppState>;
  /**
   * Changes one preference: written to the user's settings file through Core; every window
   * then receives the new preferences as an app event. Resolves with them.
   */
  setPreference(change: PreferenceChange): Promise<Preferences>;
  /** Receives app events; returns the function that stops them. */
  onAppEvent(listener: (event: AppEvent) => void): () => void;
  /** Opens the settings window (or focuses it) on `page`. */
  openSettings(page?: string): Promise<void>;

  /** Shows the system folder picker; resolves with the chosen directory, or `null`. */
  chooseFolder(): Promise<string | null>;
  /** Opens a directory as a workspace (starts its Agent Host); resolves with Core's JSON. */
  openWorkspace(path: string): Promise<string>;
  /** Creates a session in a workspace; resolves with `{ sessionId, ... }` as JSON. */
  createSession(workspace: string, model?: ModelRef): Promise<string>;
  providerSettings(): Promise<string>;
  saveProvider(configJson: string, secretJson?: string): Promise<string>;
  deleteProvider(id: string): Promise<string | null>;
  setCatalogRefresh(enabled: boolean): Promise<string>;
  workspaceModels(workspace: string): Promise<string>;
  sessionModels(sessionId: string): Promise<string>;
  previewModelSwitch(sessionId: string, provider: string, model: string): Promise<string>;
  setSessionModel(
    sessionId: string,
    provider: string,
    model: string,
    effort?: string,
  ): Promise<string>;
  setSessionEffort(sessionId: string, effort: string): Promise<string>;
  /** Reopens a session from its file. */
  resumeSession(id: string): Promise<string>;
  /** Closes an open session. */
  closeSession(id: string): Promise<string>;
  /** Starts a turn; resolves with `{ turnId }` as JSON. */
  prompt(id: string, input: string | OutgoingInput): Promise<string>;
  /**
   * A steering message for the running turn (a new turn when idle); resolves with
   * `{ disposition: "queued", itemId }` or `{ disposition: "started", turnId }` as JSON.
   */
  steer(id: string, input: string | OutgoingInput): Promise<string>;
  /** A follow-up queued for after the running turn (a new turn when idle); like `steer`. */
  followUp(id: string, input: string | OutgoingInput): Promise<string>;
  /** Stops the running turn; resolves with the returned queue as JSON. */
  abort(id: string): Promise<string>;
  setPermissionMode(id: string, mode: PermissionMode): Promise<void>;
  /** The permission rules of a workspace by source (JSON), the most recent one when null. */
  permissionRules(workspace: string | null): Promise<string>;
  /** Whether a rule parses for a list, and whether it is broad (JSON). */
  checkPermissionRule(rule: string, behavior: RuleBehavior): Promise<string>;
  /** Change one rule; new or changed allow rules need the native confirmation (JSON). */
  updatePermissionRule(change: PermissionRuleChange): Promise<string>;
  /** Permission audit events, newest first (JSON). */
  auditEvents(query: AuditQuery): Promise<string>;
  /**
   * The configuration diagnostics of a workspace (JSON), the most recent one when null:
   * every settings file with its load state and its applied, overridden and ignored keys.
   */
  configDiagnostics(workspace: string | null): Promise<string>;
  answerApproval(answer: ApprovalAnswer): Promise<string>;
  /**
   * Compacts the conversation as a turn of its own (`/compact [focus]`); `instructions` is what
   * the summary should focus on. Resolves with `{ turnId }`.
   */
  compact(id: string, instructions?: string): Promise<string>;
  /** The session's context usage by category (`ContextUsage` JSON, T27). */
  contextUsage(id: string): Promise<string>;
  /** What rewinding the files to before a turn would do (`RewindPreview` JSON, T28). */
  rewindPreview(id: string, turnId: string): Promise<string>;
  /** Rewinds the files, the conversation or both (`RewindReport` JSON, T28). */
  rewind(id: string, request: RewindRequest): Promise<string>;
  /** Undoes the files of a rewind (`RewindReport` JSON, T28). */
  undoRewind(id: string, restoreId: string): Promise<string>;
  /** The session's changed files, or one file with its diff (`ChangesView` JSON, T28). */
  sessionChanges(id: string, path?: string): Promise<string>;
  /** Discards a file's change or one hunk; the file's `ChangesView` afterwards (T28). */
  discardChange(id: string, request: DiscardRequest): Promise<string>;
  /** Continues the session on another branch (`SessionRewound` JSON, T28). */
  switchBranch(id: string, entryId: string): Promise<string>;
  /**
   * Opens a new session whose conversation stops where `beforeTurn` started ("branch from
   * here", T28); resolves with the new session as JSON.
   */
  forkSession(id: string, beforeTurn: string): Promise<string>;
  /** Changes the text of a queued input; resolves with the queue as JSON. */
  editQueueItem(id: string, itemId: string, text: string): Promise<string>;
  /** Removes a queued input; resolves with the queue as JSON. */
  deleteQueueItem(id: string, itemId: string): Promise<string>;
  /**
   * Hands an attachment's bytes to Core, which stores them in the session's directory;
   * resolves with the attachment (`InputAttachment`) as JSON.
   */
  storeAttachment(id: string, name: string, mimeType: string, data: Uint8Array): Promise<string>;
  /**
   * Fuzzy-searches the files below `root` (inside a workspace) for an `@` mention; a newer
   * search with the same `searchId` cancels this one. Resolves with `{ root, results: [{ path,
   * name, positions }], truncated }` as JSON.
   */
  searchFiles(searchId: string, root: string, query: string, limit: number): Promise<string>;
  /** Stops a file search. */
  cancelFileSearch(searchId: string): Promise<void>;
  /** The composer's configuration as JSON: commands, attachment limits, search cap. */
  composerInfo(): Promise<string>;
  /** Clears a session's unread flag. */
  markSessionRead(id: string): Promise<void>;
  /** Gives a session a title, or removes it (`null`). */
  renameSession(id: string, title: string | null): Promise<void>;
  setSessionPinned(id: string, pinned: boolean): Promise<void>;
  setSessionArchived(id: string, archived: boolean): Promise<void>;
  /**
   * Deletes a session after the user confirms in a native dialog shown by the main process
   * (`title` is what the dialog names). Resolves `false` when the user cancelled.
   */
  deleteSession(id: string, title: string): Promise<boolean>;
  /**
   * Items `start .. start + limit` of a session's persisted conversation (open or not), the
   * last `limit` when `start` is `null`, as JSON: `{ start, total, items: [{ entryId, item }] }`.
   */
  transcriptWindow(id: string, start: number | null, limit: number): Promise<string>;
  /** Asks Core to send the workspace and session snapshots again. */
  resendSnapshots(): Promise<void>;
  /** The trust view of a directory as JSON (`TrustView`). */
  projectTrust(path: string): Promise<string>;
  /** Records the user's trust decision; resolves with the new `TrustView` as JSON. */
  decideProjectTrust(path: string, trusted: boolean, version: string): Promise<string>;

  /**
   * Tells the main process a session needs the user: a system notification (when the window
   * is not in front and notifications are on), the Dock bounce or taskbar flash.
   */
  notifyAttention(notice: AttentionNotice): Promise<void>;
  /** The number of sessions that need the user (Dock badge, taskbar overlay icon). */
  setAttentionCount(count: number): Promise<void>;
}
