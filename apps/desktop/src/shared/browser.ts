// The built-in browser's contract between the renderer and the main process (ADR-0088, design
// addendum docs/architecture/addenda/browser.md). The main process owns every tab and view;
// the renderer only shows the state it is sent and asks for changes.

/** Who opened a tab (ego-browser's `openedBy`). */
export type TabOrigin = 'user' | 'agent';

/** Who controls a Space (ego-browser's ownership). */
export type SpaceOwnership = 'agent' | 'agentDelegatedToUser' | 'user';

/** How the page's connection looks in the address bar. */
export type SiteSecurity = 'secure' | 'insecure' | 'local' | 'file' | 'internal';

/** A device the page is emulated on; `null` in state means the panel's own size. */
export interface BrowserEmulation {
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  readonly mobile: boolean;
  readonly touch: boolean;
  /** Who set it: the agent's emulation shows a badge until the user resets it. */
  readonly by: 'user' | 'agent';
}

/** Page-level preferences that are not a device. */
export interface BrowserMedia {
  readonly colorScheme: 'system' | 'light' | 'dark';
  readonly reducedMotion: boolean;
}

export interface BrowserTabState {
  readonly id: string;
  readonly space: string;
  readonly url: string;
  readonly title: string;
  /** A `data:` URL of the favicon, at most 32 KiB; absent while unknown. */
  readonly favicon?: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly openedBy: TabOrigin;
  readonly security: SiteSecurity;
  /** Page zoom in percent (100 is none). */
  readonly zoom: number;
  readonly audible: boolean;
  /** The tab was discarded while hidden and reloads its URL when shown. */
  readonly discarded: boolean;
  readonly emulation: BrowserEmulation | null;
  readonly media: BrowserMedia;
  readonly devtools: 'closed' | 'docked' | 'window';
  /** The last main-frame load failed (Chromium's error name, such as `ERR_CONNECTION_REFUSED`). */
  readonly failure?: { readonly url: string; readonly code: number; readonly name: string };
  /** The renderer went away (crash, out of memory, killed). */
  readonly crashed: boolean;
  /** The agent ran script in this document (B2.5.4): reload before typing secrets. */
  readonly tainted?: boolean;
}

export interface BrowserSpaceState {
  readonly id: string;
  readonly name: string;
  readonly kind: 'user' | 'agent';
  readonly ownership: SpaceOwnership;
  /** An agent's script is running in this Space now. */
  readonly running: boolean;
  /** The agent's last action label (`page.click(…, { label })`), while running. */
  readonly action?: string;
  /** What the agent asked the user to do when it handed the Space over (B2.5.3). */
  readonly handOff?: string;
}

/** Something the page or Chromium asks the user, shown in the panel's DOM. */
export type BrowserPrompt =
  | {
      readonly id: string;
      readonly kind: 'permission';
      readonly tab: string;
      readonly origin: string;
      readonly permission: string;
    }
  | {
      readonly id: string;
      readonly kind: 'dialog';
      readonly tab: string;
      readonly origin: string;
      readonly dialog: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
      readonly message: string;
      readonly defaultValue?: string;
    }
  | {
      readonly id: string;
      readonly kind: 'auth';
      readonly tab: string;
      readonly host: string;
      readonly realm: string;
      readonly proxy: boolean;
    }
  | {
      readonly id: string;
      readonly kind: 'certificate';
      readonly tab: string;
      readonly host: string;
      readonly error: string;
      readonly fingerprint: string;
      /** Only local and private hosts may go on past a certificate error. */
      readonly bypassable: boolean;
    };

export interface BrowserDownload {
  readonly id: string;
  readonly name: string;
  readonly state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  readonly received: number;
  readonly total: number;
}

export interface BrowserFind {
  readonly tab: string;
  readonly text: string;
  readonly active: number;
  readonly matches: number;
}

/** Everything the panel of one session shows. */
export interface BrowserSessionState {
  readonly sessionId: string;
  /** Grows with every change; a window drops an older state. */
  readonly revision: number;
  readonly spaces: readonly BrowserSpaceState[];
  /** In strip order. */
  readonly tabs: readonly BrowserTabState[];
  readonly activeTab?: string;
  readonly prompts: readonly BrowserPrompt[];
  readonly downloads: readonly BrowserDownload[];
  readonly find?: BrowserFind;
  /** Another window shows this session's page now. */
  readonly shownElsewhere: boolean;
}

/** The viewport rectangle of a panel, in the window's CSS pixels. */
export interface BrowserBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where the panel of a session wants its page: `null` when the panel is gone, otherwise the
 * viewport rectangle and whether something covers it (then the page is hidden and a still
 * frame shows in its place).
 */
export type BrowserPlacement = {
  readonly bounds: BrowserBounds;
  readonly occluded: boolean;
  /** A tool window's ticket when the panel lives in a popped-out window. */
  readonly toolWindow?: string;
  /** Take the page from another window that shows it. */
  readonly claim?: boolean;
} | null;

/** Device presets of the device toolbar (B1.4.2). */
export const DEVICE_PRESETS = [
  { id: 'iphone-15', width: 393, height: 852, deviceScaleFactor: 3, mobile: true, touch: true },
  { id: 'pixel-8', width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, touch: true },
  { id: 'ipad', width: 820, height: 1180, deviceScaleFactor: 2, mobile: true, touch: true },
  { id: 'laptop', width: 1280, height: 800, deviceScaleFactor: 2, mobile: false, touch: false },
  { id: 'desktop', width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, touch: false },
] as const;

export type DevicePresetId = (typeof DEVICE_PRESETS)[number]['id'];

/** The limits of a custom device size. */
export const EMULATION_LIMITS = { min: 200, max: 4000 } as const;

/** What the panel asks the main process to do. */
export type BrowserRequest =
  | { readonly op: 'state' }
  | { readonly op: 'navigate'; readonly tab?: string; readonly input: string }
  | { readonly op: 'newTab'; readonly url?: string; readonly background?: boolean }
  | { readonly op: 'closeTab'; readonly tab: string }
  | { readonly op: 'closeOthers'; readonly tab: string }
  | { readonly op: 'selectTab'; readonly tab: string }
  | { readonly op: 'moveTab'; readonly tab: string; readonly index: number }
  | { readonly op: 'reopenClosed' }
  | { readonly op: 'history'; readonly tab: string; readonly direction: 'back' | 'forward' }
  | { readonly op: 'reload'; readonly tab: string; readonly hard?: boolean }
  | { readonly op: 'stop'; readonly tab: string }
  | { readonly op: 'zoom'; readonly tab: string; readonly step: 'in' | 'out' | 'reset' }
  | {
      readonly op: 'find';
      readonly tab: string;
      readonly text: string;
      readonly forward: boolean;
      readonly next: boolean;
    }
  | { readonly op: 'stopFind'; readonly tab: string }
  | { readonly op: 'devtools'; readonly tab: string; readonly mode: 'closed' | 'docked' | 'window' }
  | {
      readonly op: 'emulate';
      readonly tab: string;
      readonly emulation: Omit<BrowserEmulation, 'by'> | null;
    }
  | { readonly op: 'media'; readonly tab: string; readonly media: BrowserMedia }
  | {
      readonly op: 'answer';
      readonly prompt: string;
      readonly accept: boolean;
      readonly text?: string;
      readonly user?: string;
      readonly password?: string;
    }
  | { readonly op: 'openExternal'; readonly tab: string }
  /** Gives the page keyboard focus (Enter on the viewport). */
  | { readonly op: 'focus'; readonly tab: string }
  | { readonly op: 'contextMenu'; readonly tab: string }
  | { readonly op: 'download'; readonly download: string; readonly action: 'cancel' | 'show' }
  | { readonly op: 'clearData' }
  /**
   * The user and an agent Space (B2.5): take it over (the agent's calls then fail with "user
   * in control"), hand it back, or stop the agent's current `Browser` call.
   */
  | { readonly op: 'control'; readonly space: string; readonly action: BrowserControl };

/** What the user does to an agent Space from the panel (B2.5). */
export type BrowserControl = 'takeOver' | 'handBack' | 'stop';

/** The suggestions of the address bar. */
export interface BrowserSuggestion {
  readonly url: string;
  readonly title: string;
  readonly kind: 'history' | 'tab' | 'server';
}

export const BROWSER_LIMITS = {
  /** Tabs of one session across its Spaces. */
  tabs: 20,
  /** Closed tabs a session can reopen. */
  closed: 25,
  /** Characters of an address the user types. */
  input: 8192,
  /** Characters of a find query. */
  find: 512,
  /** Characters of a prompt answer (dialog text, user name, password). */
  answer: 4096,
} as const;
