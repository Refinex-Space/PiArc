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
  terminalOpenSession: 'piarc:terminal.openSession',
  terminalShare: 'piarc:terminal.share',
  terminalClose: 'piarc:terminal.close',
  terminalInput: 'piarc:terminal.input',
  terminalKey: 'piarc:terminal.key',
  terminalMouse: 'piarc:terminal.mouse',
  terminalFocus: 'piarc:terminal.focus',
  terminalPaste: 'piarc:terminal.paste',
  terminalResize: 'piarc:terminal.resize',
  terminalRequestFrame: 'piarc:terminal.requestFrame',
  terminalScroll: 'piarc:terminal.scroll',
  terminalColors: 'piarc:terminal.colors',
  terminalClearSelection: 'piarc:terminal.clearSelection',
  terminalSelectionText: 'piarc:terminal.selectionText',
  terminalLinkAt: 'piarc:terminal.linkAt',
  terminalSearch: 'piarc:terminal.search',
  terminalScreenText: 'piarc:terminal.screenText',
  terminalInfo: 'piarc:terminal.info',
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
  setModelPreferences: 'piarc:providers.modelPreferences',
  startLogin: 'piarc:providers.login',
  answerLogin: 'piarc:providers.answerLogin',
  logoutProvider: 'piarc:providers.logout',
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
  subagentTranscript: 'piarc:subagent.transcript',
  subagentStop: 'piarc:subagent.stop',
  taskStop: 'piarc:task.stop',
  taskOutput: 'piarc:task.output',
  agentsList: 'piarc:agents.list',
  commandsList: 'piarc:commands.list',
  skillsList: 'piarc:skills.list',
  outputStyleSet: 'piarc:outputStyle.set',
  webSearchSettings: 'piarc:webSearch.settings',
  webSearchBackendSet: 'piarc:webSearch.backend.set',
  webSearchKeySet: 'piarc:webSearch.key.set',
  snapshotsResend: 'piarc:snapshots.resend',
  trustGet: 'piarc:trust.get',
  trustDecide: 'piarc:trust.decide',
  attentionNotify: 'piarc:attention.notify',
  attentionCount: 'piarc:attention.count',
  permissionRules: 'piarc:permissions.rules',
  permissionCheck: 'piarc:permissions.check',
  permissionUpdate: 'piarc:permissions.update',
  auditEvents: 'piarc:permissions.audit',
  usageReport: 'piarc:usage.report',
  sessionUsage: 'piarc:usage.session',
  modelPriceSet: 'piarc:usage.price.set',
  sandboxSettings: 'piarc:sandbox.settings',
  sandboxUpdate: 'piarc:sandbox.update',
  packagesList: 'piarc:packages.list',
  packageInstall: 'piarc:packages.install',
  packageUpdate: 'piarc:packages.update',
  packageEnable: 'piarc:packages.enable',
  packageConfirm: 'piarc:packages.confirm',
  packageUninstall: 'piarc:packages.uninstall',
  configDiagnostics: 'piarc:config.diagnostics',
  diagnosticsPrepare: 'piarc:diagnostics.prepare',
  diagnosticsExport: 'piarc:diagnostics.export',
  worktreeBranches: 'piarc:worktree.branches',
  worktreeIgnore: 'piarc:worktree.ignore',
  worktreeRemove: 'piarc:worktree.remove',
  worktreeKeep: 'piarc:worktree.keep',
  sessionSearch: 'piarc:session.search',
  sessionOpenWindow: 'piarc:session.openWindow',
  launchTargets: 'piarc:app.launchTargets',
  mcpStatus: 'piarc:mcp.status',
  mcpReconnect: 'piarc:mcp.reconnect',
  mcpSetEnabled: 'piarc:mcp.setEnabled',
  mcpLogin: 'piarc:mcp.login',
} as const;

/** The new-session form's worktree choice (T35). */
export interface WorktreeOptions {
  /** 1–64 of `[A-Za-z0-9._-]`, starting with a letter or digit; Core picks one when absent. */
  readonly name?: string;
  /** The branch or commit it starts from; the workspace's HEAD when absent. */
  readonly base?: string;
}

/** Worktree names as Core accepts them (`piarc_git::worktree::check_name`). */
export function isWorktreeName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) &&
    !value.includes('..') &&
    !value.endsWith('.') &&
    !value.endsWith('.lock')
  );
}

/** What a link, a dropped folder or a second start asks the app to open (T35). */
export type LaunchTarget =
  | { readonly kind: 'workspace'; readonly path: string }
  | { readonly kind: 'session'; readonly sessionId: string };

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
  /** `permission` (the default) or `sandbox`: sandbox denials and network approvals (T39). */
  readonly kind?: 'permission' | 'sandbox';
  readonly sessionId?: string;
  readonly tool?: string;
  readonly conclusion?: 'allow' | 'deny';
  readonly since?: number;
  readonly limit?: number;
}

/** What the settings page installs (T40): a directory, a git URL or an npm spec, and where it
 * is declared (the project scope needs the workspace). */
export interface PackageInstallInput {
  readonly kind: 'directory' | 'git' | 'npm';
  readonly location: string;
  readonly scope: 'user' | 'project';
  readonly workspace?: string;
}

/** The user's sandbox values the settings page changes (T39); absent fields stay. */
/** A user's model price in USD per million tokens (T41). */
export interface ModelPriceInput {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface SandboxChange {
  readonly enabled?: boolean;
  readonly autoAllow?: boolean;
  readonly allowedDomains?: readonly string[];
  readonly denyRead?: readonly string[];
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
  /**
   * Whether the system shows PiArc's notifications at all (T42): without them PiArc falls back to
   * in-app reminders, the Dock bounce or taskbar flash and the badge (ADR-0018 item 6).
   */
  readonly notificationsSupported: boolean;
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
  | { readonly type: 'focus'; readonly focused: boolean }
  /** The window was minimized or hidden (`false`), restored or shown (`true`) (T34). */
  | { readonly type: 'visibility'; readonly visible: boolean }
  /** A link, a dropped folder or a second start asks to open something (T35). */
  | { readonly type: 'launch'; readonly target: LaunchTarget }
  /**
   * An answer given in a system notification was not applied (T42): the request was answered
   * elsewhere first or is no longer current.
   */
  | { readonly type: 'approvalNotice'; readonly sessionId: string; readonly status: string };

/**
 * The approval a waiting session's notification is about (T42): the card's identity as Core
 * gave it (the main process answers with it through the ledger) and what the notification
 * shows. `allow` is the card's `notificationAllow`; Core checks it again when answered.
 */
export interface NotificationApproval {
  readonly requestId: string;
  /** The ledger the answer goes to (a subagent's card answers to the subagent). */
  readonly sessionId: string;
  readonly revision: number;
  readonly connectionEpoch: number;
  readonly tool: string;
  /** The command or the file, cut to what a notification shows. */
  readonly summary: string;
  readonly allow: boolean;
}

/** Something the user should look at (architecture section 8.8): the main process notifies. */
export interface AttentionNotice {
  readonly kind: 'completed' | 'awaiting' | 'failed';
  readonly sessionId: string;
  /** The session's title as the sidebar shows it. */
  readonly title: string;
  /** `awaiting`: the first pending approval (T42). */
  readonly approval?: NotificationApproval;
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

/** A pointer event in pixels of the terminal's canvas (T34). */
export interface TerminalMouseMessage {
  readonly action: 'press' | 'release' | 'motion';
  /** 1 left, 2 right, 3 middle, 4–7 wheel up, down, left, right; absent for motion alone. */
  readonly button?: number;
  /** Bits: 1 Shift, 2 Ctrl, 4 Alt/Option, 8 Meta/Command. */
  readonly mods: number;
  readonly x: number;
  readonly y: number;
  /** For a press: clicks in a row (`MouseEvent.detail`). */
  readonly clicks?: number;
}

/** Validates a mouse message received over IPC. */
export function isTerminalMouseMessage(value: unknown): value is TerminalMouseMessage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const integer = (n: unknown, min: number, max: number) =>
    typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;
  const coordinate = (n: unknown) =>
    typeof n === 'number' && Number.isFinite(n) && n >= -100_000 && n <= 100_000;
  return (
    (v.action === 'press' || v.action === 'release' || v.action === 'motion') &&
    (v.button === undefined || integer(v.button, 1, 11)) &&
    integer(v.mods, 0, 15) &&
    coordinate(v.x) &&
    coordinate(v.y) &&
    (v.clicks === undefined || integer(v.clicks, 1, 3))
  );
}

/** Where to move a terminal's viewport (`piarc_protocol::terminal::TerminalScroll`). */
export type TerminalScrollTarget =
  | { readonly kind: 'top' }
  | { readonly kind: 'bottom' }
  | { readonly kind: 'delta'; readonly rows: number }
  | { readonly kind: 'row'; readonly row: number };

export function isTerminalScrollTarget(value: unknown): value is TerminalScrollTarget {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const integer = (n: unknown, min: number) =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= min;
  switch (v.kind) {
    case 'top':
    case 'bottom':
      return true;
    case 'delta':
      return integer(v.rows, -1_000_000) && (v.rows as number) <= 1_000_000;
    case 'row':
      return integer(v.row, 0);
    default:
      return false;
  }
}

/** A terminal's default colors from the theme, `0xRRGGBB` each (T34). */
export interface TerminalThemeColors {
  readonly foreground: number;
  readonly background: number;
  readonly cursor: number;
}

export function isTerminalThemeColors(value: unknown): value is TerminalThemeColors {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const color = (n: unknown) =>
    typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 0xffffff;
  return color(v.foreground) && color(v.background) && color(v.cursor);
}

/** A session terminal the panel opened (`openSessionTerminal`). */
export interface TerminalOpened {
  readonly terminalId: number;
  readonly taskId: string;
  /** How a saved terminal came back: `snapshot`, `replay`, `text`, or null for a new one. */
  readonly restored: string | null;
}

/** An OSC 8 link on a viewport row (`piarc_protocol::terminal::TerminalLink`). */
export interface TerminalLinkInfo {
  readonly uri: string;
  readonly row: number;
  readonly start: number;
  readonly end: number;
}

/** A search match, rows counted from the top of the scrollback. */
export interface TerminalMatchInfo {
  readonly start: { readonly row: number; readonly col: number };
  readonly end: { readonly row: number; readonly col: number };
}

/** What a terminal shows (`piarc_protocol::terminal::TerminalInfo`, the fields the panel reads). */
export interface TerminalInfoView {
  readonly terminalId: number;
  readonly cols: number;
  readonly rows: number;
  readonly title: string;
  readonly pwd: string;
  readonly alternateScreen: boolean;
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly shared: boolean;
}

/** What a paste did: `unsafe` text could run commands by itself (ask, then paste again). */
export type TerminalPasteOutcome = 'pasted' | 'unsafe' | 'empty';

/** Longest find-bar query. */
export const MAX_TERMINAL_QUERY = 1000;

/** Largest paste, in characters. */
export const MAX_TERMINAL_PASTE = 1024 * 1024;

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
   * Opens a terminal in session `sessionId` (T33, T34): the user's shell in the session's
   * directory and command environment, a background task of kind `terminal`. Its events
   * arrive on `term/<terminalId>`. It belongs to the session, not to this window: it survives
   * a reload and ends when it is closed, the session is archived or deleted, or PiArc quits.
   * Needs recent user input in this window; at most 16 per session.
   */
  openSessionTerminal(sessionId: string, size: TerminalSize): Promise<TerminalOpened>;
  /** Shares a user's terminal with the agent or stops sharing it (ADR-0050). */
  shareTerminal(id: number, shared: boolean): Promise<boolean>;
  /** Closes the terminal: its program and everything it started end. */
  closeTerminal(id: number): Promise<void>;
  /** Writes text to the terminal as typed (committed input-method text). */
  terminalInput(id: number, text: string): Promise<void>;
  /** Sends a key event; Core encodes it with the terminal's current modes. */
  terminalKey(id: number, key: TerminalKeyMessage): Promise<void>;
  /**
   * A pointer event: the program gets it while it tracks the mouse; otherwise it selects
   * (Shift extends, `clicks` 2 a word, 3 a line) and the wheel scrolls the scrollback.
   */
  terminalMouse(id: number, event: TerminalMouseMessage): Promise<void>;
  /** Reports focus to the program when it asked for focus reports. */
  terminalFocus(id: number, gained: boolean): Promise<void>;
  /** Pastes as the program's modes require; `unsafe` asks for confirmation first. */
  terminalPaste(id: number, text: string, allowUnsafe: boolean): Promise<TerminalPasteOutcome>;
  /** Resizes the terminal and its PTY. */
  terminalResize(id: number, size: TerminalSize): Promise<void>;
  /**
   * Resolves with the terminal's next frame (`piarc_protocol::term_frame`, version 2; 14 bytes
   * when nothing changed); `full` asks for a RESET frame (after a reload or a decode error).
   * With `park`, the view stops pulling when the frame is empty and Core sends an `output`
   * event on `term/<id>` at the next output. The frame is the reply to this request, not a
   * message on the event port: after a key, Chromium handles event-port messages only after
   * the next rendered frame (ADR-0023). One request in flight per terminal and window.
   */
  requestTerminalFrame(id: number, full: boolean, park?: boolean): Promise<Uint8Array>;
  /** Moves the viewport through the scrollback. */
  terminalScroll(id: number, to: TerminalScrollTarget): Promise<void>;
  /**
   * Gives the terminal the theme's default colors: cells without colors of their own and
   * programs that ask (OSC 10/11/12) get them.
   */
  terminalColors(id: number, colors: TerminalThemeColors): Promise<void>;
  /** Clears the selection. */
  terminalClearSelection(id: number): Promise<void>;
  /** The selected text, '' when nothing is selected. */
  terminalSelectionText(id: number): Promise<string>;
  /** The OSC 8 link at viewport cell (`col`, `row`), or null. */
  terminalLinkAt(id: number, col: number, row: number): Promise<TerminalLinkInfo | null>;
  /** Finds `query` in the screen and scrollback, newest match first. */
  terminalSearch(id: number, query: string): Promise<readonly TerminalMatchInfo[]>;
  /** The visible screen as plain text from Core's formatter (the screen reader view). */
  terminalScreenText(id: number): Promise<string>;
  /** Title, directory, size and sharing of the terminal. */
  terminalInfo(id: number): Promise<TerminalInfoView>;

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
  createSession(workspace: string, model?: ModelRef, worktree?: WorktreeOptions): Promise<string>;
  providerSettings(): Promise<string>;
  saveProvider(configJson: string, secretJson?: string): Promise<string>;
  deleteProvider(id: string): Promise<string | null>;
  setCatalogRefresh(enabled: boolean): Promise<string>;
  /** Saves per-model settings and the auxiliary model (T29); resolves with the settings. */
  setModelPreferences(preferencesJson: string): Promise<string>;
  /** Signs in to a provider (T29); steps arrive on `core/login`, resolves when it ended. */
  startLogin(provider: string): Promise<string>;
  /** Answers the sign-in's question; `null` cancels the sign-in. */
  answerLogin(loginId: string, value: string | null): Promise<void>;
  /** Signs out of a provider after a native confirmation; `null` when the user declined. */
  logoutProvider(provider: string): Promise<string | null>;
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
  /** Permission (or, with `kind: 'sandbox'`, sandbox) audit events, newest first (JSON). */
  auditEvents(query: AuditQuery): Promise<string>;
  /**
   * The sandbox of a workspace (JSON, T39), the most recent one when null: on or off, mode,
   * allowed domains and `denyRead` with their sources, writable places, project values that
   * do not apply, and whether the platform has a sandbox.
   */
  sandboxSettings(workspace: string | null): Promise<string>;
  /**
   * Usage by model and by session with estimated costs (JSON `UsageReport`, T41), for every
   * workspace or one.
   */
  usageReport(workspace: string | null): Promise<string>;
  /** One session's usage with its subagents and auxiliary calls (JSON `SessionUsage`, T41). */
  sessionUsage(sessionId: string): Promise<string>;
  /**
   * Sets the user's price of a model in USD per million tokens (T41); null removes it and the
   * catalog's price applies again.
   */
  setModelPrice(provider: string, model: string, price: ModelPriceInput | null): Promise<void>;
  /**
   * Writes the user's sandbox values; turning auto-approval on and adding domains need the
   * native confirmation (`{ status: 'cancelled' }`). Resolves with the new view (JSON).
   */
  setSandboxSettings(workspace: string | null, change: SandboxChange): Promise<string>;
  /**
   * The configuration diagnostics of a workspace (JSON), the most recent one when null:
   * every settings file with its load state and its applied, overridden and ignored keys.
   */
  configDiagnostics(workspace: string | null): Promise<string>;
  /**
   * Prepares the diagnostic bundle (T45) with a workspace's configuration diagnostics (the most
   * recent one when null) and resolves with its manifest (JSON): `{id, files: [{name, bytes}],
   * redactions: {<kind>: count}, excluded}`. Nothing is written yet.
   */
  prepareDiagnostics(workspace: string | null): Promise<string>;
  /**
   * Writes the prepared bundle `id` where the user chooses in the native save dialog; resolves
   * with `{path, bytes}` (JSON), or null when the user cancelled.
   */
  exportDiagnostics(id: string): Promise<string | null>;
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
  setSessionArchived(id: string, archived: boolean): Promise<boolean>;
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
  /**
   * Items of subagent `child`'s transcript (T31), read through session `parent` whose card
   * shows it; the same JSON as `transcriptWindow`.
   */
  subagentTranscript(
    parent: string,
    child: string,
    start: number | null,
    limit: number,
  ): Promise<string>;
  /** Stops subagent `child` of session `parent` (T31); resolves with `{ stopped }` as JSON. */
  stopSubagent(parent: string, child: string): Promise<string>;
  /**
   * Stops background task `taskId` with its whole process tree (T32, the panel's stop button;
   * the same Core entry as KillShell); resolves with `{ task, stopped, tail }` as JSON.
   */
  stopTask(taskId: string): Promise<string>;
  /**
   * At most 64 KiB of background task `taskId`'s output from byte `offset` (T32), as
   * `TaskOutputChunk` JSON; the window reads the file in parts instead of receiving it whole.
   */
  readTaskOutput(taskId: string, offset: number, length: number | null): Promise<string>;
  /**
   * The subagent types of a workspace (T31): definition files and built-in types with their
   * source, overrides, warnings and resolved model, as `AgentsList` JSON.
   */
  listAgents(workspace: string): Promise<string>;
  /**
   * The slash commands and output styles of a workspace from `cwd` (its root when null): built-in
   * commands, command files, Pi templates and user-invocable skills, as `CommandsList` JSON (T37).
   */
  listCommands(workspace: string, cwd: string | null): Promise<string>;
  /** The skills of a workspace with source, overrides and warnings, as `SkillsList` JSON (T37). */
  listSkills(workspace: string): Promise<string>;
  /**
   * The installed extension packages as `workspace` (or, when null, the user settings) sees
   * them, as `PackagesList` JSON (T40).
   */
  listPackages(workspace: string | null): Promise<string>;
  /** Installs a package, off; answers `PackageInstallResult` JSON (T40). */
  installPackage(input: PackageInstallInput): Promise<string>;
  /** Fetches a package's newest version; answers `PackageInstallResult` JSON (T40). */
  updatePackage(id: string, workspace: string | null): Promise<string>;
  /**
   * Turns a package on or off in a scope. Turning on shows the main process's native
   * confirmation of its source and executable items first; answers the `PackagesList` JSON, or
   * `{"status":"cancelled"}` (T40).
   */
  setPackageEnabled(
    id: string,
    enabled: boolean,
    scope: 'user' | 'project',
    workspace: string | null,
  ): Promise<string>;
  /**
   * Confirms the executable items of a package that wait for confirmation, after the native
   * confirmation lists them; answers the list or `{"status":"cancelled"}` (T40).
   */
  confirmPackage(id: string, workspace: string | null): Promise<string>;
  /** Uninstalls a package; answers the list (T40). */
  uninstallPackage(id: string, workspace: string | null): Promise<string>;
  /**
   * Sets the output style: the workspace's `.piarc/settings.local.json` (`/output-style`), or the
   * user's settings when `workspace` is null; a null name removes the choice (T37).
   */
  setOutputStyle(workspace: string | null, name: string | null): Promise<void>;
  /**
   * WebSearch's settings as JSON `{ backend, backends: [{ id, name, hasKey }] }`: the chosen
   * third-party backend and whether each has a key in the vault (T38). Keys never come back.
   */
  webSearchSettings(): Promise<string>;
  /** Chooses WebSearch's third-party backend in the user's settings; null chooses none (T38). */
  setWebSearchBackend(backend: string | null): Promise<void>;
  /** Saves a WebSearch backend's API key in the vault; null removes it (T38). */
  setWebSearchKey(backend: string, key: string | null): Promise<void>;
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
  worktreeBranches(workspace: string): Promise<string>;
  ignoreWorktrees(workspace: string): Promise<string>;
  removeSessionWorktree(id: string): Promise<boolean>;
  keepSessionWorktree(id: string): Promise<void>;
  searchSessions(query: string): Promise<string>;
  openSessionWindow(id: string): Promise<void>;
  takeLaunchTargets(): Promise<readonly LaunchTarget[]>;
  pathForFile(file: object): string;

  /**
   * The MCP servers of a workspace (T36): source, transport, state, tools and the last error,
   * as `McpStatus` JSON; changes arrive on `core/mcp`.
   */
  mcpStatus(workspace: string): Promise<string>;
  /** Connects an MCP server anew; its `McpServerStatus` as JSON. */
  mcpReconnect(workspace: string, name: string): Promise<string>;
  /** Turns an MCP server on or off for the workspace; its `McpServerStatus` as JSON. */
  mcpSetEnabled(workspace: string, name: string, enabled: boolean): Promise<string>;
  /**
   * Signs in to an OAuth MCP server; steps on `core/login` (provider `mcp:<name>`), answered
   * with `answerLogin`. Resolves with its `McpServerStatus` and `loginId` as JSON.
   */
  mcpLogin(workspace: string, name: string): Promise<string>;

  notifyAttention(notice: AttentionNotice): Promise<void>;
  /** The number of sessions that need the user (Dock badge, taskbar overlay icon). */
  setAttentionCount(count: number): Promise<void>;
}
