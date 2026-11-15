// Permission policy for every session (architecture section 10.3, Electron security
// checklist item 5): everything is denied unless it is on the allowlist below.
import type { Session } from 'electron';

import { originForLog } from './navigation.js';
import { originOf } from './origin.js';

/** A permission the app grants to its own pages, with the reason it is needed. */
export interface PermissionGrant {
  readonly permission: string;
  readonly reason: string;
}

/**
 * Permissions granted to pages of a trusted origin. Empty on purpose: a later task that needs
 * one (for example `clipboard-sanitized-write` for a copy button) adds an entry with a
 * `reason` and a test, and lists it in docs/spikes/S10-electron-security.md.
 */
export const PERMISSION_ALLOWLIST: readonly PermissionGrant[] = [];

/** True when `permission` is on the allowlist and requested by a trusted origin. */
export function isPermissionAllowed(
  permission: string,
  requestingOrigin: string,
  trustedOrigins: readonly string[],
  allowlist: readonly PermissionGrant[] = PERMISSION_ALLOWLIST,
): boolean {
  return (
    trustedOrigins.includes(requestingOrigin) &&
    allowlist.some((grant) => grant.permission === permission)
  );
}

/** Installs the deny-by-default request, check and device handlers on `session`. */
export function applyPermissionPolicy(session: Session, trustedOrigins: readonly string[]): void {
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const allowed = isPermissionAllowed(
      permission,
      originOf(details.requestingUrl),
      trustedOrigins,
    );
    if (!allowed) {
      console.warn(
        `[security] denied permission request ${permission} from ${originForLog(details.requestingUrl)}`,
      );
    }
    callback(allowed);
  });
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    isPermissionAllowed(permission, requestingOrigin, trustedOrigins),
  );
  session.setDevicePermissionHandler(() => false);
}
