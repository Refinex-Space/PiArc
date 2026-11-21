// Presentation state of the terminal panel (architecture section 8.3 rule 2): whether it is in
// the dock, which tab each session shows, and the names the person gave tabs. Ctrl+` opens and
// closes it. The open flag survives a reload of the window (sessionStorage), so the panel comes
// back and re-attaches to the session's terminals; names are kept per window in localStorage.
// Storage can be unavailable; the panel then simply starts closed and unnamed.
import { useSyncExternalStore } from 'react';

const OPEN_KEY = 'piarc.terminal.open';
const NAMES_KEY = 'piarc.terminal.names';

function read(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function write(storage: () => Storage, key: string, value: string): void {
  try {
    storage().setItem(key, value);
  } catch {
    // Not kept; the panel still works.
  }
}

let open = read(() => sessionStorage, OPEN_KEY) === 'true';
/** A new terminal is wanted when the panel shows a session without one (Ctrl+`). */
let wantTerminal = false;
/** Bumped to ask the panel to move the focus into its terminal. */
let focusNonce = 0;
const active = new Map<string, string>();
let names: Readonly<Record<string, string>> = parseNames(read(() => localStorage, NAMES_KEY));
const listeners = new Set<() => void>();

function parseNames(text: string | null): Record<string, string> {
  if (text === null) return {};
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

function changed(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setTerminalPanelOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  write(() => sessionStorage, OPEN_KEY, String(next));
  changed();
}

/** Ctrl+`: opens the panel (with a terminal and the focus in it) or closes it. */
export function toggleTerminalPanel(): boolean {
  setTerminalPanelOpen(!open);
  if (open) {
    wantTerminal = true;
    focusNonce += 1;
    changed();
  }
  return open;
}

/** Asks the panel to open (if needed) and focus. */
export function focusTerminalPanel(): void {
  setTerminalPanelOpen(true);
  focusNonce += 1;
  changed();
}

/** Takes the "open a terminal if there is none" request. */
export function takeTerminalWish(): boolean {
  const wanted = wantTerminal;
  wantTerminal = false;
  return wanted;
}

export function useTerminalPanelOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open);
}

export function useTerminalFocusRequest(): number {
  return useSyncExternalStore(subscribe, () => focusNonce);
}

/** The tab (task id) session `sessionId` shows. */
export function useActiveTerminal(sessionId: string): string | undefined {
  return useSyncExternalStore(subscribe, () => active.get(sessionId));
}

export function setActiveTerminal(sessionId: string, taskId: string): void {
  if (active.get(sessionId) === taskId) return;
  active.set(sessionId, taskId);
  changed();
}

/** Shows `taskId` in its session's panel (the background task card's button). */
export function showTerminal(sessionId: string, taskId: string): void {
  active.set(sessionId, taskId);
  focusTerminalPanel();
}

export function useTerminalNames(): Readonly<Record<string, string>> {
  return useSyncExternalStore(subscribe, () => names);
}

/** Names tab `taskId`; '' gives it back its title. */
export function renameTerminal(taskId: string, name: string): void {
  const kept = Object.entries(names).filter(([id]) => id !== taskId);
  const trimmed = name.trim().slice(0, 80);
  const next: Record<string, string> = Object.fromEntries(
    trimmed === '' ? kept : [...kept, [taskId, trimmed]],
  );
  names = next;
  write(() => localStorage, NAMES_KEY, JSON.stringify(next));
  changed();
}
