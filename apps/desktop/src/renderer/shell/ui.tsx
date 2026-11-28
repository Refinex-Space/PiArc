// Presentation state of the main window (architecture section 8.3, rule 2): what is selected,
// open dialogs and in-app reminders. Business facts stay in the store.
import type { SearchTab } from './GlobalSearch.js';
import type { AppCommand } from '../../shared/ipc.js';
import { createContext, useContext } from 'react';

import type { ComposerInfo } from '../composer/attachments.js';
import type { HomeTools } from './home-draft.js';
import type { StoreConnection } from '../store/connection.js';
import type { TranscriptServices } from '../transcript/services.js';

/** What the main area shows. */
export type View =
  | {
      readonly kind: 'home';
      readonly workspace: string | undefined;
      /** Text to put back into the input (a start that failed). */
      readonly draft?: string;
      readonly error?: string;
    }
  | { readonly kind: 'session'; readonly id: string };

/** An in-app reminder (shown whether or not a system notification appeared, I43). */
export interface Toast {
  readonly id: string;
  readonly sessionId: string;
  readonly text: string;
  /** Takes the place of "Open" (B4.4: "Open in preview"); runs, then the toast goes. */
  readonly action?: { readonly label: string; readonly run: () => void };
}

/** How the trust dialog was opened. */
export type TrustMode = 'decide' | 'review';

export interface Ui {
  readonly view: View;
  readonly show: (view: View) => void;
  readonly connection: StoreConnection;
  /**
   * Receives session `id`'s notifications for the rest of the window's life: a session shown
   * once stays current in the store, so showing it again needs no reload.
   */
  readonly watchSession: (id: string) => void;
  /** The window's transcript workers, streaming driver and row heights. */
  readonly transcriptServices: TranscriptServices;
  /** Core's commands and attachment limits, once known. */
  readonly composer: ComposerInfo | undefined;
  /**
   * Shows the trust dialog for `workspace` when the user must decide (first session there, or
   * items added since the user trusted it; `review` always shows it). Resolves `true` when the
   * session may go ahead (a decision was made or none was needed), `false` when the user
   * cancelled.
   */
  readonly ensureTrust: (workspace: string, mode: TrustMode) => Promise<boolean>;
  /** Opens the folder picker, opens the folder as a workspace and returns its path. */
  readonly openFolder: () => Promise<string | undefined>;
  readonly toggleSidebar: () => void;
  readonly openShortcuts: () => void;
  /** Opens global search on `tab` (sessions, projects, commands and shortcuts in one dialog). */
  readonly openSearch: (tab: SearchTab) => void;
  /** Runs a registered command as its shortcut would (slash commands, the Mod+K palette). */
  readonly runCommand: (command: AppCommand) => void;
  /** The new-session view's draft session for its tools (ADR-0099). */
  readonly homeTools: HomeTools;
  readonly toasts: readonly Toast[];
  readonly addToast: (toast: Omit<Toast, 'id'>) => void;
  readonly dismissToast: (id: string) => void;
  /** Opens the first-run guide on "Connect a model" (ADR-0110), closing Settings first. */
  readonly openOnboarding: (from: 'settings' | 'home') => void;
}

export const UiContext = createContext<Ui | null>(null);

export function useUi(): Ui {
  const ui = useContext(UiContext);
  if (ui === null) {
    throw new Error('useUi outside UiContext');
  }
  return ui;
}

/** The last path segment, for a workspace's label when Core has none. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? path;
}
