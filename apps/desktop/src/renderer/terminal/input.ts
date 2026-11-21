// Keyboard, input method, paste and copy of a terminal view (T34, architecture section 8.5).
//
// - While the terminal has the focus every key goes to it, except the few shortcuts the
//   registry marks global (`isGlobalKey`) and, on macOS, ⌘ shortcuts (the app's and the
//   system's: Core never gets ⌘). Keys go to Core as events (`keys.ts`); libghostty-vt encodes
//   them with the terminal's modes.
// - Copy: ⌘C on macOS; on Windows Ctrl+Shift+C, and Ctrl+C while something is selected (with no
//   selection Ctrl+C goes to the program as the interrupt). The text comes from Core's
//   selection.
// - Paste: ⌘V on macOS, Ctrl+V or Ctrl+Shift+V on Windows: the browser's paste event gives the
//   text, Core wraps it as the program's modes require.
// - Input method: the input-method guard (`isImeComposing`) keeps composing keys away from Core;
//   the preedit text is drawn at the cursor; `compositionend` writes the committed text once.
import { isImeComposing } from '../composer/ime-guard.js';
import type { TerminalKeyMessage } from '../../shared/ipc.js';
import { keyMessage } from './keys.js';

export interface InputHost {
  readonly platform: 'mac' | 'other';
  readonly isGlobalKey: (event: KeyboardEvent) => boolean;
  attached(): boolean;
  hasSelection(): boolean;
  copy(): void;
  key(message: TerminalKeyMessage, event: KeyboardEvent): void;
  text(text: string): void;
  paste(text: string): void;
  preedit(text: string): void;
}

/** What a key event means before it reaches the terminal. */
export type KeyIntent = 'global' | 'copy' | 'paste' | 'app' | 'terminal';

/** Decides who handles `event` (exported for tests). */
export function keyIntent(
  event: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  platform: 'mac' | 'other',
  hasSelection: boolean,
  global: boolean,
): KeyIntent {
  if (global) return 'global';
  const c = event.code === 'KeyC';
  const v = event.code === 'KeyV';
  if (platform === 'mac') {
    if (event.metaKey && !event.ctrlKey && !event.altKey) {
      if (c) return 'copy';
      if (v) return 'paste';
    }
    // Other ⌘ shortcuts stay with the app and the system.
    return event.metaKey ? 'app' : 'terminal';
  }
  if (event.ctrlKey && !event.altKey && !event.metaKey) {
    if (c && (event.shiftKey || hasSelection)) return 'copy';
    if (v) return 'paste';
  }
  return 'terminal';
}

/** Wires `textarea`; returns the function that unwires it. */
export function attachInput(host: InputHost, textarea: HTMLTextAreaElement): () => void {
  let composing = false;
  /** Codes whose press went to the terminal, so only their releases follow. */
  const pressed = new Set<string>();
  const listeners: [string, (event: Event) => void][] = [];
  const on = (type: string, listener: (event: Event) => void) => {
    textarea.addEventListener(type, listener);
    listeners.push([type, listener]);
  };

  const onKey = (event: Event) => {
    if (!(event instanceof KeyboardEvent) || !host.attached() || isImeComposing(event, composing)) {
      return;
    }
    if (event.type === 'keyup') {
      if (pressed.delete(event.code)) {
        const message = keyMessage(event);
        if (message !== undefined) host.key(message, event);
      }
      return;
    }
    switch (keyIntent(event, host.platform, host.hasSelection(), host.isGlobalKey(event))) {
      case 'global':
      case 'app':
        // The window's shortcut handler (and the menu) take it.
        return;
      case 'paste':
        // The browser's paste event follows; it carries the text.
        return;
      case 'copy':
        event.preventDefault();
        event.stopPropagation();
        host.copy();
        return;
      case 'terminal': {
        const message = keyMessage(event);
        if (message === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        pressed.add(event.code);
        host.key(message, event);
      }
    }
  };
  on('keydown', onKey);
  on('keyup', onKey);
  on('compositionstart', () => {
    composing = true;
  });
  on('compositionupdate', (event) => {
    host.preedit(event instanceof CompositionEvent ? event.data : '');
  });
  on('compositionend', (event) => {
    composing = false;
    host.preedit('');
    textarea.value = '';
    const text = event instanceof CompositionEvent ? event.data : '';
    if (text !== '') {
      host.text(text);
    }
  });
  on('input', (event) => {
    // Text that arrived without a key event the view handled (the emoji picker, dictation).
    const isComposing = event instanceof InputEvent && event.isComposing;
    if (composing || isComposing || textarea.value === '') {
      return;
    }
    const text = textarea.value;
    textarea.value = '';
    host.text(text);
  });
  on('paste', (event) => {
    if (!(event instanceof ClipboardEvent)) return;
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') ?? '';
    textarea.value = '';
    host.paste(text);
  });
  return () => {
    for (const [type, listener] of listeners) {
      textarea.removeEventListener(type, listener);
    }
  };
}
