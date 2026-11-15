import { describe, expect, it } from 'vitest';

import { APP_ORIGIN } from '../app-scheme.js';
import { isPermissionAllowed, PERMISSION_ALLOWLIST } from './permissions.js';

describe('isPermissionAllowed', () => {
  const trusted = [APP_ORIGIN];

  it('grants nothing while the allowlist is empty', () => {
    expect(PERMISSION_ALLOWLIST).toEqual([]);
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
