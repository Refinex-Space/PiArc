// Keyboard shortcuts of the main window: key events are matched against the effective bindings
// (src/shared/keybindings.ts) and the command runs; a handled key does not reach the page or
// the menu. Commands from the application menu arrive as app events and run the same way.
// Keys are ignored while an input method composes (architecture section 8.5).
import { useEffect, useRef } from 'react';

import type { AppCommand } from '../../shared/ipc.js';
import { commandForEvent, effectiveBindings } from '../../shared/keybindings.js';
import { isImeComposing } from '../composer/ime-guard.js';
import { useApp } from '../app/app-context.js';

export function useCommands(run: (command: AppCommand) => void): void {
  const { preferences, keyPlatform } = useApp();
  const runRef = useRef(run);
  runRef.current = run;
  const bindings = effectiveBindings(preferences.keybindings);
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isImeComposing(event)) {
        return;
      }
      const command = commandForEvent(event, bindingsRef.current, keyPlatform);
      if (command === undefined) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (command === 'app.settings') {
        void window.piarc.openSettings();
        return;
      }
      runRef.current(command);
    };
    window.addEventListener('keydown', onKeyDown);
    const stop = window.piarc.onAppEvent((event) => {
      if (event.type === 'command') {
        runRef.current(event.command);
      }
    });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      stop();
    };
  }, [keyPlatform]);
}
