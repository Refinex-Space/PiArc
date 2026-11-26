import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { quarantine, type QuarantinePorts } from './quarantine.js';

function ports(platform: string, present = false) {
  const calls: { file: string; args: readonly string[] }[] = [];
  const written: { file: string; text: string }[] = [];
  const port: QuarantinePorts = {
    platform,
    run: (file, args) => {
      calls.push({ file, args });
      // `xattr -p` fails when the attribute is missing.
      return Promise.resolve(args[0] === '-p' && !present ? 1 : 0);
    },
    exists: () => Promise.resolve(present),
    write: (file, text) => {
      written.push({ file, text });
      return Promise.resolve();
    },
    now: () => 0x6560_0000 * 1000,
    uuid: () => '0F1E2D3C-0000-4000-8000-000000000000',
  };
  return { port, calls, written };
}

const file = path.join('/Users', 'me', 'Downloads', 'report 报告.pdf');

describe('quarantine (B1.3.6)', () => {
  it('adds the macOS attribute when the download has none', async () => {
    const p = ports('darwin');
    await quarantine(file, 'https://user:pw@example.com/r.pdf', p.port);
    expect(p.calls).toEqual([
      { file: '/usr/bin/xattr', args: ['-p', 'com.apple.quarantine', file] },
      {
        file: '/usr/bin/xattr',
        args: [
          '-w',
          'com.apple.quarantine',
          '0081;65600000;PiArc;0F1E2D3C-0000-4000-8000-000000000000',
          file,
        ],
      },
    ]);
  });

  it('keeps an attribute Chromium already wrote', async () => {
    const p = ports('darwin', true);
    await quarantine(file, 'https://example.com/r.pdf', p.port);
    expect(p.calls).toHaveLength(1);
  });

  it('writes the Windows zone stream without credentials or line breaks', async () => {
    const p = ports('win32');
    await quarantine(
      'C:\\Users\\me\\Downloads\\a.exe',
      'https://u:p@example.com/a.exe?x=1\r\n',
      p.port,
    );
    expect(p.written).toEqual([
      {
        file: 'C:\\Users\\me\\Downloads\\a.exe:Zone.Identifier',
        text: '[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://example.com/a.exe?x=1\r\n',
      },
    ]);
  });

  it('leaves an existing zone stream and other platforms alone', async () => {
    const present = ports('win32', true);
    await quarantine('C:\\a.exe', 'https://example.com/', present.port);
    expect(present.written).toEqual([]);
    const linux = ports('linux');
    await quarantine('/tmp/a', 'https://example.com/', linux.port);
    expect(linux.calls).toEqual([]);
    expect(linux.written).toEqual([]);
  });
});
