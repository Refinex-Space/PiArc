// PiArc addition (not in upstream ego-browser): the type of the `globalThis.ego` object the
// ported SDK calls. Upstream reads `globalThis.ego` untyped; it is the native binding object of
// Ego Lite (reference/ego-lite/docs/native-bindings-api.md). In PiArc the script host builds it
// from `window.piarcBrowserHost` (../bindings.ts, ADR-0091); the methods below the PiArc marker
// replace upstream's Node file system and the clipboard.

import type {
  BrowserServerInfo,
  BrowserServersResult,
  SnapshotOptions,
  SnapshotResult,
  TabInfo,
  TaskSpaceInfo,
} from '../../shared/browser-host.js';

/** A failure a binding resolves with instead of rejecting (ego's `{ error, error_code }`). */
export interface EgoErrorResult {
  readonly error: string;
  readonly error_code: string;
}

/** What a binding resolves with: its result, or an error object. */
export type EgoResult<T> = T | EgoErrorResult;

export interface EgoProfile {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
}

/** Snapshot options as the SDK passes them; PiArc names the tab explicitly. */
export interface EgoSnapshotOptions extends SnapshotOptions {
  /** The tab to capture; the selected Space's active tab when absent. */
  readonly targetId?: string;
}

export interface EgoBindings {
  listProfiles(): Promise<EgoResult<{ readonly profiles: readonly EgoProfile[] }>>;
  listTaskSpaces(): Promise<EgoResult<{ readonly taskSpaces: readonly TaskSpaceInfo[] }>>;
  createTaskSpace(name: string, profileId?: string): Promise<EgoResult<TaskSpaceInfo>>;
  claimTaskSpace(id: number, name?: string): Promise<EgoResult<TaskSpaceInfo>>;
  /** Selects the Space later task-scoped calls use; local to this host. */
  useTaskSpace(id: number): number;
  closeTaskSpace(): Promise<EgoResult<string>>;
  completeTaskSpace(): Promise<EgoResult<string>>;
  handOffTaskSpace(): Promise<EgoResult<string>>;
  takeOverTaskSpace(): Promise<EgoResult<string>>;
  setAgentTaskState(state: string): Promise<EgoResult<string>>;
  /** Shows the agent cursor at `x`, `y` (CSS pixels) in `targetId`, or the active tab. */
  animationHighlightMouseToPosition(
    x: number,
    y: number,
    targetId?: string,
  ): Promise<EgoResult<string>>;
  createTab(url: string): Promise<EgoResult<TabInfo>>;
  listTabs(): Promise<EgoResult<{ readonly tabs: readonly TabInfo[] }>>;
  /** Rejects with an `Error` carrying `error_code` on failure, as ego does. */
  snapshot(options?: EgoSnapshotOptions): Promise<SnapshotResult>;
  sendCDPMessage(message: string): void;
  onCDPMessage: ((message: string) => void) | undefined;
  onSendCDPMessageError: ((message: string, errorCode: string) => void) | undefined;

  // PiArc: replacements for upstream's file system and clipboard use.
  /** The Page ledger of a Space (JSON text), or null (or an empty string) when none is saved. */
  ledgerLoad(space: number): Promise<EgoResult<string | null>>;
  /** Replaces the Page ledger of a Space; an empty string discards it. */
  ledgerSave(space: number, data: string): Promise<EgoResult<null>>;
  /** Copies local files to the session's upload staging area; answers the staged paths. */
  stageUpload(paths: readonly string[]): Promise<EgoResult<readonly string[]>>;
  /** Saves a finished download (its guid) to `path` through Core's write policy. */
  saveFile(source: string, path: string): Promise<EgoResult<null>>;
  /** Adds an image to the tool result; answers its number in the result. */
  attachImage(image: {
    readonly base64: string;
    readonly mediaType: 'image/png' | 'image/jpeg';
    readonly width: number;
    readonly height: number;
  }): Promise<EgoResult<number>>;
  /** Asks the user to let the agent reach `hosts`; answers whether they were allowed. */
  requestAccess(hosts: readonly string[], reason: string): Promise<EgoResult<boolean>>;
  /** The project's launch configurations and the session's local services (ADR-0092). */
  servers(): Promise<EgoResult<BrowserServersResult>>;
  /** Starts a launch configuration; resolves once it is ready or failed (ADR-0092). */
  startServer(name: string): Promise<EgoResult<BrowserServerInfo>>;
}

declare global {
  // The SDK reads the bindings from the global, as upstream does (host.ts installs them).
  var ego: EgoBindings | undefined;
}
