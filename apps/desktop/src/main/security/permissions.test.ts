import { describe, expect, it } from 'vitest';

import { APP_ORIGIN } from '../app-scheme.js';
import { isPermissionAllowed, PERMISSION_ALLOWLIST } from './permissions.js';

describe('isPermissionAllowed', () => {
  const trusted = [APP_ORIGIN];

  it('allows only sanitized clipboard writes, each entry with a reason', () => {
    expect(PERMISSION_ALLOWLIST.map((grant) => grant.permission)).toEqual([
      'clipboard-sanitized-write',
    ]);
    for (const grant of PERMISSION_ALLOWLIST) {
      expect(grant.reason.length, grant.permission).toBeGreaterThan(20);
    }
    expect(isPermissionAllowed('clipboard-sanitized-write', APP_ORIGIN, trusted)).toBe(true);
    for (const permission of ['notifications', 'media', 'geolocation', 'clipboard-read']) {
      expect(isPermissionAllowed(permission, APP_ORIGIN, trusted), permission).toBe(false);
    }
  });

  it('grants allowlisted permissions to trusted origins only', () => {
    const allowlist = [{ permission: 'clipboard-sanitized-write', reason: 'test' }];
    expect(isPermissionAllowed('clipboard-sanitized-write', APP_ORIGIN, trusted, allowlist)).toBe(
      true,
    );
    expect(
      isPermissionAllowed('clipboard-sanitized-write', 'https://example.com', trusted, allowlist),
    ).toBe(false);
    expect(isPermissionAllowed('media', APP_ORIGIN, trusted, allowlist)).toBe(false);
  });
});
