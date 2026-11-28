// The keyboard of approval rows (T20, shared with T26's plan card and question form): Mod+Enter,
// Mod+Shift+Enter and Esc answer the first approval visible in the transcript, never during an
// input method composition, never in the first 400 ms of a card (`APPROVAL_DELAY_MS`), and Esc
// only when the card has focus or the composer is empty. Keys typed into another text field (a
// diff comment's editor) stay with that field. Each card maps the keys to its own answers.
import { useEffect, useRef, type RefObject } from 'react';

import { useApp } from '../app/app-context.js';
import { useApprovalFocus } from './use-approval-focus.js';
import {
  approvalKey,
  canAnswerByKey,
  draftKeeps,
  typedElsewhere,
  type ApprovalKey,
} from '../transcript/rows/approval-keys.js';

function firstVisible(card: HTMLElement): boolean {
  const scroller = card.closest('.transcript-scroller');
  if (!scroller) return false;
  const bounds = scroller.getBoundingClientRect();
  return (
    Array.from(scroller.querySelectorAll('[data-approval-card]')).find((el) => {
      const rect = el.getBoundingClientRect();
      return rect.height > 0 && rect.top < bounds.bottom && rect.bottom > bounds.top;
    }) === card
  );
}

/**
 * Calls `onKey` for an approval shortcut meant for `card`. `skip` keys are consumed but not
 * answered (for example "allow for session" on a protected path).
 */
export function useApprovalKeys(
  card: RefObject<HTMLElement | null>,
  onKey: (key: ApprovalKey) => void,
  skip: (key: ApprovalKey) => boolean = () => false,
  yieldToComposer = false,
): void {
  const { keyPlatform } = useApp();
  // Every card calls this hook: it also takes focus when it appears (T43).
  useApprovalFocus(card, yieldToComposer);
  const mountedAt = useRef(performance.now());
  const latest = useRef({ onKey, skip });
  latest.current = { onKey, skip };
  useEffect(() => {
    let composing = false;
    const start = () => {
      composing = true;
    };
    const end = () => {
      composing = false;
    };
    const keydown = (ev: KeyboardEvent) => {
      const el = card.current;
      if (
        composing ||
        !el ||
        ev.defaultPrevented ||
        document.querySelector('dialog[open], [role="dialog"], [role="menu"]')
      )
        return;
      const key = approvalKey(ev, keyPlatform);
      if (!key || !firstVisible(el)) return;
      const composer = document.querySelector('.composer');
      const target = ev.target instanceof HTMLElement ? ev.target : null;
      if (
        target !== null &&
        typedElsewhere({
          editable: target.isContentEditable || target.matches('input, textarea, select'),
          inCard: el.contains(target),
          inComposer: composer?.contains(target) === true,
        })
      )
        return;
      const input = composer?.querySelector('[contenteditable="true"]');
      const composerEmpty =
        !input?.textContent && !composer?.querySelector('.composer-attachments');
      // A draft keeps its send and queue keys (a reply to a plan is typed there).
      if (
        draftKeeps(key, {
          inComposer: target !== null && composer?.contains(target) === true,
          composerEmpty,
        })
      )
        return;
      // Consume the shortcut even during the guard: it must not fall through to stop/queue.
      ev.preventDefault();
      ev.stopPropagation();
      if (latest.current.skip(key)) return;
      if (
        canAnswerByKey(key, {
          firstVisible: true,
          ageMs: performance.now() - mountedAt.current,
          composerEmpty,
          cardFocused: el.contains(document.activeElement),
          repeat: ev.repeat,
        })
      )
        latest.current.onKey(key);
    };
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('compositionstart', start, true);
    window.addEventListener('compositionend', end, true);
    return () => {
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('compositionstart', start, true);
      window.removeEventListener('compositionend', end, true);
    };
  }, [card, keyPlatform]);
}
