// Where focus goes when an approval card appears (T43, architecture section 8.7): to the card's
// container (named by `approval-label.ts`, so its kind and object are announced), not to a
// button, and only for the first card of the transcript. During an input method composition the
// move waits for the composition to end. For `APPROVAL_DELAY_MS` after the card appears, Enter
// and Space on its controls do nothing, like the shortcuts (a key meant for the composer must
// not answer it).
import { useEffect, type RefObject } from 'react';

import { APPROVAL_DELAY_MS } from '../transcript/rows/approval-keys.js';

let composing = false;
let listening = false;

/** Whether an input method is composing anywhere in the window. */
function trackComposition(): void {
  if (listening) return;
  listening = true;
  window.addEventListener(
    'compositionstart',
    () => {
      composing = true;
    },
    true,
  );
  window.addEventListener(
    'compositionend',
    () => {
      composing = false;
    },
    true,
  );
}

/** Whether `key` would activate a control under the card's guard. */
export function guardedKey(key: string, ageMs: number): boolean {
  return ageMs < APPROVAL_DELAY_MS && (key === 'Enter' || key === ' ');
}

// From the start: a composition may begin before the first card appears.
if (typeof window !== 'undefined') trackComposition();

export function useApprovalFocus(
  card: RefObject<HTMLElement | null>,
  /** The card invites a reply in the composer (a plan, ADR-0103): typing there keeps its focus. */
  yieldToComposer = false,
): void {
  useEffect(() => {
    const el = card.current;
    if (el === null) return;
    const shownAt = performance.now();
    const guard = (event: KeyboardEvent) => {
      if (event.target !== el && guardedKey(event.key, performance.now() - shownAt)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    el.addEventListener('keydown', guard, true);
    el.addEventListener('keyup', guard, true);
    const move = () => {
      if (yieldToComposer && document.activeElement?.closest('.composer') != null) return;
      if (el.isConnected && document.querySelector('[data-approval-card]') === el) {
        el.focus({ preventScroll: true });
      }
    };
    let waiting: (() => void) | undefined;
    if (composing) {
      waiting = () => {
        window.removeEventListener('compositionend', after, true);
        waiting = undefined;
      };
      const after = () => {
        waiting?.();
        // After the composition's own commit.
        setTimeout(move, 0);
      };
      window.addEventListener('compositionend', after, true);
    } else {
      move();
    }
    return () => {
      el.removeEventListener('keydown', guard, true);
      el.removeEventListener('keyup', guard, true);
      waiting?.();
    };
  }, [card, yieldToComposer]);
}
