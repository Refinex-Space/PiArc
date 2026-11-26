// The built-in browser's contract between the renderer and the main process (ADR-0088, design
// addendum docs/architecture/addenda/browser.md). The main process owns every tab and view;
// the renderer only shows the state it is sent and asks for changes.

import type { DevServerState, LaunchView, ListeningPort } from '@piarc/protocol';

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

/** A console message's level (Chromium's names). */
export type BrowserConsoleLevel = 'debug' | 'info' | 'warning' | 'error';

/** One console message or uncaught exception of a tab (B1.4.3); page data, shown as text. */
export interface BrowserConsoleEntry {
  readonly seq: number;
  readonly level: BrowserConsoleLevel;
  readonly text: string;
  /** The script's URL, `''` when the page gave none. */
  readonly source: string;
  readonly line: number;
  /** Unix milliseconds. */
  readonly at: number;
}

/** Where docked DevTools sit next to the page (B1.4.1); one choice for every tab. */
export type DevtoolsDock = 'bottom' | 'right';

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
  readonly failure?: {
    readonly url: string;
    readonly code: number;
    readonly name: string;
    /** A refused local server is loaded again with backoff (B1.3.1): the next attempt. */
    readonly retry?: { readonly attempt: number; readonly max: number };
  };
  /** The renderer went away (crash, out of memory, killed). */
  readonly crashed: boolean;
  /** The agent ran script in this document (B2.5.4): reload before typing secrets. */
  readonly tainted?: boolean;
  /** The tab's console (B1.4.3): the newest entry's number and the kept entries' counts. */
  readonly console: {
    readonly last: number;
    readonly count: number;
    readonly errors: number;
    readonly warnings: number;
  };
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
  /** The element picker is on in this tab (B3.1): collecting cards or one element's screenshot. */
  readonly picking?: { readonly tab: string; readonly mode: BrowserPickMode };
  /** The session's listening ports and development servers (B4.2, B4.4), when it has any. */
  readonly services?: BrowserServices;
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
  /** `newTab` opens the address in a new tab of "My tabs" (Mod+Enter in the address bar). */
  | {
      readonly op: 'navigate';
      readonly tab?: string;
      readonly input: string;
      readonly newTab?: boolean;
    }
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
  /** The tab's console entries newer than `after` (B1.4.3); answers `BrowserConsoleEntry[]`. */
  | { readonly op: 'console'; readonly tab: string; readonly after: number }
  | { readonly op: 'consoleClear'; readonly tab: string }
  | { readonly op: 'clearData' }
  /**
   * The user and an agent Space (B2.5): take it over (the agent's calls then fail with "user
   * in control"), hand it back, or stop the agent's current `Browser` call.
   */
  | { readonly op: 'control'; readonly space: string; readonly action: BrowserControl }
  /** Starts or stops the element picker in the tab (B3.1); `off` stops it. */
  | { readonly op: 'pick'; readonly tab: string; readonly mode: BrowserPickMode | 'off' }
  /** A screenshot of the tab's page (B3.3, B3.4); answers a `BrowserImage`. */
  | { readonly op: 'capture'; readonly tab: string; readonly kind: BrowserCaptureKind }
  /** Puts a PNG (`data:image/png;base64,…`) the panel made on the clipboard (B3.4). */
  | { readonly op: 'copyImage'; readonly image: string }
  /** What the start page lists (B1.1.1): recent pages and launch configurations. */
  | { readonly op: 'startPage' }
  /** Runs or stops a launch configuration (B4.2); answers its `DevServerState`. */
  | { readonly op: 'startServer'; readonly name: string }
  | { readonly op: 'stopServer'; readonly name: string }
  /** The address bar's suggestions for what the user typed (B1.2.3). */
  | { readonly op: 'suggest'; readonly input: string }
  /** "Open HTML file…" (B1.6.2): the native open dialog; answers the tab, or null. */
  | { readonly op: 'openHtmlFile' };

/** A page the user opened in this workspace (start page, suggestions). */
export interface BrowserRecent {
  /** The address, or `./path` for a workspace file. */
  readonly url: string;
  readonly title: string;
}

/** What Core reports of a session's services (ADR-0092). */
export interface BrowserServices {
  readonly ports: readonly ListeningPort[];
  readonly servers: readonly DevServerState[];
}

/** What the start page lists besides the live services. */
export interface BrowserStartPage {
  /** This workspace's recent pages, newest first. */
  readonly recents: readonly BrowserRecent[];
  /** The launch configurations; absent when Core could not read them. */
  readonly launch?: LaunchView;
}

/** What the picker collects: cards for the tray, or one element's screenshot (B3.1, B3.4). */
export type BrowserPickMode = 'collect' | 'shot';

/** Screenshots the main process takes; a region is cut from `visible` by the panel (B3.4). */
export type BrowserCaptureKind = 'visible' | 'full';

/** A captured image: a PNG data URL and its size in pixels. */
export interface BrowserImage {
  readonly data: string;
  readonly width: number;
  readonly height: number;
}

/** Where an element's code is (B3.2): relative to the session's workspace, with `/`. */
export interface BrowserSourceLocation {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}

/**
 * What the picker learned about one element (B3.2). Everything but `source` comes from the page
 * and is data: shown as text, sent inside the `<browser-context>` boundary.
 */
export interface BrowserElementContext {
  /** The page's address when the element was picked. */
  readonly url: string;
  readonly tag: string;
  /** A CSS selector that matched only this element when it was picked. */
  readonly selector: string;
  readonly xpath: string;
  readonly role: string;
  readonly name: string;
  /** Allow-listed attributes (`id`, `class`, `aria-*`, `data-testid`, …). */
  readonly attributes: Readonly<Record<string, string>>;
  readonly text: string;
  /** The element's markup: scripts and event attributes removed, password values masked. */
  readonly html: string;
  /** Computed styles that differ from the defaults. */
  readonly styles: Readonly<Record<string, string>>;
  /** The element's box in the viewport, in CSS pixels. */
  readonly box: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** Component names, innermost first (React, Vue, Svelte dev builds). */
  readonly components: readonly string[];
  /** Only when the file resolved inside the session's workspace. */
  readonly source?: BrowserSourceLocation;
}

/** One picked element (B3.1), sent to the panel as an app event. */
export interface BrowserPick {
  readonly id: string;
  readonly tab: string;
  readonly context: BrowserElementContext;
  /** The element with a margin around it; absent when the element has no visible box. */
  readonly image?: BrowserImage;
}

/** The limits of B3.2 and of the images the panel hands back. */
export const BROWSER_CONTEXT_LIMITS = {
  /** Characters of an element's text. */
  text: 200,
  /** Bytes of an element's markup, and with a source location. */
  html: 2048,
  htmlWithSource: 800,
  styles: 20,
  components: 4,
  /** Margin around an element screenshot, CSS pixels. */
  margin: 16,
  /** Longest edge of an element screenshot, pixels. */
  imageEdge: 1200,
  /** Characters of a `copyImage` data URL. */
  image: 24 * 1024 * 1024,
  /** Characters of a comment on a card or a marker. */
  comment: 2000,
  /** Cards in the tray. */
  picks: 20,
} as const;

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
  /** Characters of a launch configuration's name. */
  serverName: 200,
  /** Recent pages the start page lists. */
  recents: 8,
  /** Address bar suggestions shown at once. */
  suggestions: 8,
} as const;
