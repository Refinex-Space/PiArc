import type { KeyPlatform } from '../../../shared/keybindings.js';
import { isImeComposing, type ImeKeyFields } from '../../composer/ime-guard.js';

/** An approval may first receive a shortcut this many milliseconds after it appears. */
export const APPROVAL_DELAY_MS = 400;
export type ApprovalKey = 'allowOnce' | 'allowSession' | 'deny';
type Key = ImeKeyFields &
  Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'repeat'>;

export function approvalKey(event: Key, platform: KeyPlatform): ApprovalKey | undefined {
  if (event.altKey || isImeComposing(event)) return undefined;
  if (event.key === 'Escape' && !event.shiftKey && !event.ctrlKey && !event.metaKey) return 'deny';
  const mod =
    platform === 'mac' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (event.key === 'Enter' && mod) return event.shiftKey ? 'allowSession' : 'allowOnce';
  return undefined;
}

export function canAnswerByKey(
  key: ApprovalKey,
  state: {
    firstVisible: boolean;
    ageMs: number;
    composerEmpty: boolean;
    cardFocused: boolean;
    repeat: boolean;
  },
): boolean {
  return (
    state.firstVisible &&
    !state.repeat &&
    state.ageMs >= APPROVAL_DELAY_MS &&
    (key !== 'deny' || state.cardFocused || state.composerEmpty)
  );
}

export function canAlwaysAllow(protectedPath: boolean, long: boolean, reviewed: boolean): boolean {
  return !protectedPath && (!long || reviewed);
}
