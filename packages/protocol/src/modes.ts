import type { PermissionMode } from './generated/ahp.js';

/** Every permission mode a session can be in (architecture section 6.2.1). */
export const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
];

/** Narrow an untrusted value to a permission mode. */
export function isPermissionMode(value: unknown): value is PermissionMode {
  return PERMISSION_MODES.some((mode) => mode === value);
}
