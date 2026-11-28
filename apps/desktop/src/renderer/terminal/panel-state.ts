// Core task ids identify terminal tabs across reconnects. This window remembers names and
// the active tab for each session; WorkbenchPanels owns the visibility of the tool.
import { useSyncExternalStore } from 'react';

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

/** A new terminal is wanted when the panel shows a session without one (Ctrl+`). */
let wantedSession: string | undefined;
let focusSession: string | undefined;
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

/** Explicit user input may start a shell. Restoring a layout only reconnects to existing tasks. */
export function requestTerminalFocus(sessionId: string, createIfEmpty = false): void {
  wantedSession = createIfEmpty ? sessionId : undefined;
  focusSession = sessionId;
  focusNonce += 1;
  changed();
}

/** Takes the "open a terminal if there is none" request. */
export function takeTerminalWish(sessionId: string): boolean {
  if (wantedSession !== sessionId) return false;
  wantedSession = undefined;
  return true;
}

export function useTerminalFocusRequest(sessionId: string): number {
  return useSyncExternalStore(subscribe, () => (focusSession === sessionId ? focusNonce : 0));
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
  requestTerminalFocus(sessionId);
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
