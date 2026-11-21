// Registered containers of the window (architecture section 8.2): the session's right rail and
// the dockable panel area hold what other tasks register (Changes T28, terminal T34, context
// usage T27, ...). An area with nothing registered is not shown at all.
//
// Register at module load of the feature (`registerPanel({...})`); the returned function
// removes the panel (tests, hot reload).
import { useSyncExternalStore, type ReactNode } from 'react';

import type { MessageId } from '../../shared/i18n/index.js';

export type PanelArea = 'rail' | 'dock';

/** What a panel shows about. */
export interface PanelContext {
  /** The selected session, if any. */
  readonly sessionId: string | undefined;
  /** The selected session has a task list (T26). */
  readonly tasks?: boolean;
  /** The selected session has a plan, approved or waiting for review (T26). */
  readonly plan?: boolean;
  /** The Changes panel is open (T28: the changes card's button, Mod+Shift+D). */
  readonly changes?: boolean;
  /** The selected session has background tasks (T32). */
  readonly backgroundTasks?: boolean;
  /** The selected session's workspace has background tasks (T32). */
  readonly workspaceTasks?: boolean;
  /** The terminal panel is open (T34: Ctrl+`). */
  readonly terminal?: boolean;
}

export interface PanelSpec {
  /** Stable id (layout memory keys use it). */
  readonly id: string;
  readonly area: PanelArea;
  /** Message id of its title. */
  readonly title: MessageId;
  /** Lower first. */
  readonly order: number;
  /** Whether it applies now (for example only with a session selected); always by default. */
  readonly when?: (context: PanelContext) => boolean;
  readonly render: (context: PanelContext) => ReactNode;
}

let panels: readonly PanelSpec[] = [];
/** The last panel something asked to bring forward (`showPanel`). */
let requested: { readonly id: string; readonly nonce: number } | undefined;
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

/** Adds a panel; returns the function that removes it. */
export function registerPanel(spec: PanelSpec): () => void {
  panels = [...panels.filter((p) => p.id !== spec.id), spec].sort((a, b) => a.order - b.order);
  changed();
  return () => {
    panels = panels.filter((p) => p !== spec);
    changed();
  };
}

/** Brings panel `id` forward in its area (for example a card's "open in the plan panel"). */
export function showPanel(id: string): void {
  requested = { id, nonce: (requested?.nonce ?? 0) + 1 };
  changed();
}

/** The last request of `showPanel`. */
export function useRequestedPanel(): { readonly id: string; readonly nonce: number } | undefined {
  return useSyncExternalStore(subscribe, () => requested);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The registered panels of every area. */
export function usePanels(): readonly PanelSpec[] {
  return useSyncExternalStore(subscribe, () => panels);
}

/** The panels of `area` that apply in `context`. */
export function panelsFor(
  all: readonly PanelSpec[],
  area: PanelArea,
  context: PanelContext,
): readonly PanelSpec[] {
  return all.filter((p) => p.area === area && (p.when?.(context) ?? true));
}
