import { documentWindow, useSurfaceDocument } from '../app/surface-document.js';
// One terminal on screen (T34): a `TerminalController` fitted to its box, attached to Core's
// terminal `terminalId`. Only the panel's visible tab mounts a surface, so a hidden tab or a
// closed panel pulls no frames; mounting again (another tab, a reload) starts with one full
// frame. Core's events wake the view (`output`) and fill the clipboard (OSC 52).
import { useEffect, useRef, useSyncExternalStore } from 'react';

import { commandForEvent, effectiveBindings, isGlobalCommand } from '../../shared/keybindings.js';
import { useApp } from '../app/app-context.js';
import { TerminalController } from './controller.js';
import { onTerminalEvents } from './events.js';
import { readTheme } from './theme.js';
import type { ThemeColors } from './remote-renderable.js';

const QUERIES = [
  '(prefers-color-scheme: dark)',
  '(prefers-contrast: more)',
  '(prefers-reduced-motion: reduce)',
] as const;

/** A counter that moves when one of the system's appearance settings changes. */
function useSystemAppearance(): string {
  return useSyncExternalStore(
    (listener) => {
      const lists = QUERIES.map((query) => window.matchMedia(query));
      for (const list of lists) list.addEventListener('change', listener);
      return () => {
        for (const list of lists) list.removeEventListener('change', listener);
      };
    },
    () => QUERIES.map((query) => String(window.matchMedia(query).matches)).join(','),
  );
}

const FALLBACK_THEME: ThemeColors = {
  background: { r: 248, g: 249, b: 250 },
  foreground: { r: 29, g: 32, b: 39 },
  cursor: { r: 63, g: 81, b: 181 },
  selection: { r: 221, g: 227, b: 253 },
  findMatch: { r: 255, g: 242, b: 201 },
  findCurrent: { r: 230, g: 160, b: 0 },
};

export interface SurfaceHandlers {
  /** The person Mod+clicked a link: show its address and ask before opening. */
  readonly openLink: (uri: string) => void;
  /** The paste could run commands by itself; resolve true to paste anyway. */
  readonly confirmPaste: (text: string) => Promise<boolean>;
  readonly copied: () => void;
}

export function TerminalSurface({
  terminalId,
  label,
  handlers,
  onController,
  focusNonce,
}: {
  readonly terminalId: number;
  /** Accessible name of the terminal. */
  readonly label: string;
  readonly handlers: SurfaceHandlers;
  /** The view, for the panel's find bar, copy and text view; null when it goes. */
  readonly onController: (controller: TerminalController | null) => void;
  /** A new value moves the focus into the terminal. */
  readonly focusNonce: number;
}) {
  const ownerDoc = useSurfaceDocument();
  const { keyPlatform, preferences } = useApp();
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<TerminalController | null>(null);
  const bindings = useRef(effectiveBindings(preferences.keybindings));
  bindings.current = effectiveBindings(preferences.keybindings);
  const latest = useRef(handlers);
  latest.current = handlers;
  const appearance = useSystemAppearance();

  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    const view = new TerminalController(element, window.piarc, {
      platform: keyPlatform,
      isGlobalKey: (event) => {
        const command = commandForEvent(event, bindings.current, keyPlatform);
        return command !== undefined && isGlobalCommand(command);
      },
      label,
      fit: true,
      openLink: (uri) => {
        latest.current.openLink(uri);
      },
      confirmPaste: (text) => latest.current.confirmPaste(text),
      copied: () => {
        latest.current.copied();
      },
    });
    view.setTheme(readTheme(element, FALLBACK_THEME));
    view.attach(terminalId);
    controller.current = view;
    onController(view);
    globalThis.__piarcTerminalPanel = view.probe();
    const stop = onTerminalEvents(terminalId, (event) => {
      if (event.type === 'output') {
        view.wake();
      } else if (event.type === 'clipboard') {
        void documentWindow(ownerDoc)
          .navigator.clipboard.writeText(event.text)
          .catch(() => undefined);
      }
    });
    return () => {
      stop();
      onController(null);
      controller.current = null;
      globalThis.__piarcTerminalPanel = undefined;
      view.dispose();
    };
    // The view follows the label and handlers through refs; a new terminal is a new view.
  }, [terminalId, keyPlatform, ownerDoc]);

  // The theme's colors follow the appearance settings (the app's and the system's).
  useEffect(() => {
    const element = host.current;
    if (element !== null) controller.current?.setTheme(readTheme(element, FALLBACK_THEME));
    const motion = preferences.appearance.reduceMotion;
    controller.current?.setReducedMotion(
      motion === 'on' ||
        (motion === 'system' && window.matchMedia('(prefers-reduced-motion: reduce)').matches),
    );
  }, [preferences.appearance, appearance, ownerDoc]);

  useEffect(() => {
    if (focusNonce > 0) controller.current?.focus();
  }, [focusNonce, ownerDoc]);

  useEffect(() => {
    controller.current?.setLabel(label);
  }, [label]);

  // The canvas sits in an inner box: the surface's padding keeps the focus ring off the cells.
  return (
    <div
      className="terminal-surface"
      role="group"
      aria-label={label}
      data-testid="terminal-surface"
      data-terminal={terminalId}
    >
      <div ref={host} className="terminal-host" />
    </div>
  );
}
