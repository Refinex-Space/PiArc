import { describe, expect, it } from 'vitest';

import {
  entitlementKeys,
  findDevTools,
  parseCodesignDisplay,
  testPageChunks,
} from './check-app-layout.mjs';

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

describe('findDevTools', () => {
  it('finds the development binaries on both platforms and nothing else', () => {
    const paths = [
      '/x/PiArc.app/Contents/MacOS/PiArc',
      '/x/PiArc.app/Contents/Resources/piarc-devcli',
      'C:\\PiArc\\resources\\piarc-mock-provider.exe',
      '/native/piarc-devcli-notes.txt',
      '\\native\\piarc-core.darwin-arm64.node',
    ];
    expect(findDevTools(paths)).toEqual([
      '/x/PiArc.app/Contents/Resources/piarc-devcli',
      'C:\\PiArc\\resources\\piarc-mock-provider.exe',
    ]);
  });
});

describe('testPageChunks', () => {
  it("finds the renderer's test-page chunk on both separators and nothing else", () => {
    expect(
      testPageChunks([
        '/.vite/renderer/main_window/assets/test-pages-nmJjYXVk.js',
        '\\.vite\\renderer\\main_window\\assets\\test-pages-AbC.js',
        '/.vite/renderer/main_window/assets/index-B7F4qT1M.js',
        '/.vite/renderer/main_window/assets/test-pages-nmJjYXVk.js.map',
      ]),
    ).toEqual([
      '/.vite/renderer/main_window/assets/test-pages-nmJjYXVk.js',
      '\\.vite\\renderer\\main_window\\assets\\test-pages-AbC.js',
    ]);
  });
});
