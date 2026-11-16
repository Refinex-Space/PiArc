import { describe, expect, it } from 'vitest';

import { entitlementKeys, parseCodesignDisplay } from './check-app-layout.mjs';

describe('parseCodesignDisplay', () => {
  it('reads an ad-hoc signature with the hardened runtime', () => {
    const info = parseCodesignDisplay(
      [
        'Executable=/x/PiArc.app/Contents/MacOS/PiArc',
        'Identifier=cn.piarc.desktop',
        'CodeDirectory v=20500 size=297 flags=0x10002(adhoc,runtime) hashes=3+7 location=embedded',
        'Signature=adhoc',
        'TeamIdentifier=not set',
      ].join('\n'),
    );
    expect(info).toEqual({
      identifier: 'cn.piarc.desktop',
      flags: ['adhoc', 'runtime'],
      adhoc: true,
      authorities: [],
    });
  });

  it('reads a Developer ID signature with its authorities and team', () => {
    const info = parseCodesignDisplay(
      [
        'Identifier=node',
        'CodeDirectory v=20500 size=950480 flags=0x10000(runtime) hashes=29692+7 location=embedded',
        'Authority=Developer ID Application: Node.js Foundation (HX7739G8FX)',
        'Authority=Developer ID Certification Authority',
        'Authority=Apple Root CA',
        'TeamIdentifier=HX7739G8FX',
      ].join('\n'),
    );
    expect(info.adhoc).toBe(false);
    expect(info.teamId).toBe('HX7739G8FX');
    expect(info.authorities[0]).toBe('Developer ID Application: Node.js Foundation (HX7739G8FX)');
    expect(info.flags).toEqual(['runtime']);
  });
});

describe('entitlementKeys', () => {
  it('lists the keys set to true, sorted', () => {
    const xml =
      '<plist><dict><key>com.b</key><true/><key>com.a</key><true />' +
      '<key>com.off</key><false/></dict></plist>';
    expect(entitlementKeys(xml)).toEqual(['com.a', 'com.b']);
  });
});
