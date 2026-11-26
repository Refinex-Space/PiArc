// The contract between the agent's script host (a sandboxed page that runs the browser SDK and
// the model's script, ADR-0089 rule 3) and the main process. The SDK sees these as
// `globalThis.ego`-style bindings (ADR-0091); every call crosses one IPC channel and the main
// process checks that the sender is the host of the run in progress.

/** The IPC channel the host invokes; one request shape per `op`. */
export const BROWSER_HOST_CHANNEL = 'piarc:browserHost';
/** Main → host: a CDP message (event or response) for the SDK. */
export const BROWSER_HOST_CDP_CHANNEL = 'piarc:browserHost.cdp';
/** Main → host: start a run (the script and its context). */
export const BROWSER_HOST_RUN_CHANNEL = 'piarc:browserHost.run';

/** Stable error codes, the same names ego-browser uses where they exist. */
export type BrowserErrorCode =
  | 'EGO_INVALID_ARGUMENT'
  | 'EGO_OPERATION_FAILED'
  | 'EGO_SNAPSHOT_FAILED'
  | 'EGO_TASK_SPACE_NOT_FOUND'
  | 'EGO_TASK_SPACE_NAME_IN_USE'
  | 'EGO_TASK_SPACE_INACTIVE'
  | 'EGO_TASK_SPACE_NOT_SELECTED'
  | 'EGO_TASK_SPACE_USER_IN_CONTROL'
  | 'EGO_WEB_CONTENTS_UNAVAILABLE'
  | 'EGO_CDP_SEND_FAILED'
  | 'PIARC_CDP_METHOD_REFUSED'
  | 'PIARC_SITE_REFUSED'
  | 'PIARC_FILE_REFUSED'
  | 'PIARC_RUN_ENDED'
  | 'PIARC_LIMIT';

/** A failed binding call answers this instead of throwing across IPC. */
export interface BrowserHostFailure {
  readonly error: string;
  readonly error_code: BrowserErrorCode;
  /** For `EGO_TASK_SPACE_USER_IN_CONTROL`: why (`manual_takeover`, `notifications`, …). */
  readonly reason?: string;
}

export interface TaskSpaceInfo {
  readonly id: number;
  /** The display name; `taskId` repeats it for ego compatibility. */
  readonly name: string;
  readonly taskId: string;
  readonly ownership: 'agent' | 'agentDelegatedToUser' | 'user';
  readonly createdBy: 'agent' | 'user';
  readonly recentTabTitles: readonly string[];
}

export interface TabInfo {
  readonly index: number;
  /** The CDP target id the SDK uses for this tab. */
  readonly targetId: string;
  readonly url: string;
  readonly title: string;
  readonly active: boolean;
  readonly openedBy: 'agent' | 'user' | 'unknown';
}

/** Options of a snapshot, as ego-browser's native `ego.snapshot` takes them. */
export interface SnapshotOptions {
  readonly scope?: 'full_page' | 'only_within_viewport' | 'subtree';
  /** `backendNodeId` for `subtree`. */
  readonly root?: number;
  /** The frame of `root` (CDP target id) when it is not the main frame. */
  readonly rootFrame?: string;
  readonly includeActionMarks?: boolean;
  readonly interactiveOnly?: boolean;
  readonly includeStableLocator?: boolean;
  /** Zero or absent: unlimited. */
  readonly maxResultLength?: number;
}

export interface SnapshotRef {
  /** The number printed as `[ref=N]`, unique within one snapshot. */
  readonly refId: number;
  readonly backendNodeId: number;
  /** The frame target owning the node; absent for the top document. */
  readonly frameId?: string;
  readonly role: string;
  readonly name: string;
  /** A stable locator (`role:button[name="Save"]`, `css:#id`, `href:/path`) when unique. */
  readonly loc?: string;
}

export interface SnapshotResult {
  readonly content: string;
  readonly refs: readonly SnapshotRef[];
  /** The content was cut at `maxResultLength` or the node limit. */
  readonly truncated: boolean;
}

/** One binding call from the host. */
export type BrowserHostRequest =
  | { readonly op: 'listProfiles' }
  | { readonly op: 'listTaskSpaces' }
  | { readonly op: 'createTaskSpace'; readonly name: string }
  | { readonly op: 'claimTaskSpace'; readonly id: number; readonly name?: string }
  | { readonly op: 'closeTaskSpace'; readonly space: number }
  | { readonly op: 'completeTaskSpace'; readonly space: number }
  | { readonly op: 'handOffTaskSpace'; readonly space: number; readonly reason?: string }
  | { readonly op: 'takeOverTaskSpace'; readonly space: number }
  | { readonly op: 'setAgentTaskState'; readonly space: number; readonly state: string }
  | {
      readonly op: 'highlight';
      readonly space: number;
      readonly targetId: string;
      readonly x: number;
      readonly y: number;
      readonly label?: string;
    }
  | { readonly op: 'createTab'; readonly space: number; readonly url: string }
  | { readonly op: 'listTabs'; readonly space: number }
  | {
      readonly op: 'snapshot';
      readonly space: number;
      readonly targetId: string;
      readonly options: SnapshotOptions;
    }
  /** A raw CDP message (JSON text) for a tab of `space`; the answer arrives on the CDP channel. */
  | { readonly op: 'cdp'; readonly space: number; readonly message: string }
  | { readonly op: 'ledgerLoad'; readonly space: number }
  | { readonly op: 'ledgerSave'; readonly space: number; readonly data: string }
  /** Copies the files to the session's upload staging area through Core; answers the copies. */
  | { readonly op: 'stageUpload'; readonly paths: readonly string[] }
  /** Saves a finished download (its staging path) to `path` through Core's write policy. */
  | { readonly op: 'saveFile'; readonly source: string; readonly path: string }
  /** Adds an image to the tool result; answers its number in the result. */
  | {
      readonly op: 'attachImage';
      readonly base64: string;
      readonly mediaType: 'image/png' | 'image/jpeg';
      readonly width: number;
      readonly height: number;
    }
  /** Asks the user to let the agent reach `hosts` (B2.6.4). */
  | { readonly op: 'requestAccess'; readonly hosts: readonly string[]; readonly reason: string }
  /** Output printed so far (batched), kept in case the run never finishes (timeout, crash). */
  | { readonly op: 'print'; readonly text: string }
  /** The run ended (the preload sends `finish` as this op). */
  | { readonly op: 'finish'; readonly result: BrowserHostResult };

/** What the main process sends to start a run. */
export interface BrowserHostRun {
  readonly runId: string;
  readonly script: string;
  readonly timeoutMs: number;
  /** The session's default Space id, if it has one already. */
  readonly defaultSpace?: number;
}

/** What the host answers when the run ends. */
export interface BrowserHostResult {
  readonly runId: string;
  /** What `console.*` printed, formatted as ego-browser formats it. */
  readonly output: string;
  readonly error?: { readonly name: string; readonly message: string; readonly code?: string };
}

/** The API the host's preload exposes to the host page (`window.piarcBrowserHost`). */
export interface BrowserHostApi {
  call(request: BrowserHostRequest): Promise<unknown>;
  /** Registers the listener of CDP messages for this run (one at a time). */
  onCdp(listener: (message: string) => void): void;
  /** Registers the run listener; the page answers with `finish`. */
  onRun(listener: (run: BrowserHostRun) => void): void;
  finish(result: BrowserHostResult): void;
}
