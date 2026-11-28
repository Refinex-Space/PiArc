// T35-A10: the Windows registration of `piarc://` and of Explorer's "Open with PiArc", and the
// arguments Explorer and the scheme hand to a new instance (parsed by `launch.ts`). Runs on
// every platform; Windows CI covers it there.
import { describe, expect, it } from 'vitest';

import { launchTargets } from '../launch.js';
import {
  OPEN_WITH_LABEL,
  regExe,
  runRegistry,
  shellRegistration,
  shellUnregistration,
} from './windows-shell.js';

const EXE = 'C:\\Users\\张 三\\AppData\\Local\\cn.piarc.desktop\\current\\PiArc.exe';

describe('Windows shell registration', () => {
  it('registers the URL scheme and both folder verbs under HKCU', () => {
    const commands = shellRegistration(EXE);
    expect(commands.every((c) => c[1]?.startsWith('HKCU\\Software\\Classes\\'))).toBe(true);
    expect(commands.every((c) => c.at(-1) === '/f')).toBe(true);
    // `add <key> /ve /d <data> /f` sets the default value, `add <key> /v <name> /d <data> /f` a
    // named one.
    const values = new Map(
      commands.map((c) => [
        `${c[1] ?? ''}|${c[2] === '/ve' ? '' : (c[3] ?? '')}`,
        c[c.indexOf('/d') + 1],
      ]),
    );
    expect(values.get('HKCU\\Software\\Classes\\piarc|')).toBe('URL:PiArc');
    expect(values.get('HKCU\\Software\\Classes\\piarc|URL Protocol')).toBe('');
    expect(values.get('HKCU\\Software\\Classes\\piarc\\shell\\open\\command|')).toBe(
      `"${EXE}" "%1"`,
    );
    expect(values.get('HKCU\\Software\\Classes\\Directory\\shell\\PiArc|')).toBe(OPEN_WITH_LABEL);
    expect(values.get('HKCU\\Software\\Classes\\Directory\\shell\\PiArc\\command|')).toBe(
      `"${EXE}" "%1"`,
    );
    expect(
      values.get('HKCU\\Software\\Classes\\Directory\\Background\\shell\\PiArc\\command|'),
    ).toBe(`"${EXE}" "%V"`);
  });

  it('removes what it registered', () => {
    const removed = shellUnregistration().map((c) => c[1]);
    for (const command of shellRegistration(EXE)) {
      const key = command[1] ?? '';
      expect(removed.some((root) => root !== undefined && key.startsWith(root))).toBe(true);
    }
  });

  it('runs reg.exe from the system directory and reports failed writes', () => {
    expect(regExe('D:\\Windows')).toBe('D:\\Windows\\System32\\reg.exe');
    const calls: string[][] = [];
    const failed = runRegistry(
      [...shellRegistration(EXE).slice(0, 2), ...shellUnregistration().slice(0, 1)],
      (_file, args) => {
        calls.push([...args]);
        return { status: args[0] === 'delete' ? 1 : calls.length === 2 ? 1 : 0 };
      },
    );
    expect(calls).toHaveLength(3);
    expect(failed).toBe(1);
  });

  it('gets the argument Explorer and the scheme pass to a new instance', () => {
    // Explorer: `"PiArc.exe" "D:\work\repo 仓库"`; scheme: `"PiArc.exe" "piarc://session/s1"`.
    expect(launchTargets([EXE, 'D:\\work\\repo 仓库'], false, 'C:\\')).toEqual([
      { kind: 'workspace', path: 'D:\\work\\repo 仓库' },
    ]);
    expect(
      launchTargets([EXE, '--allow-file-access', 'piarc://session/s1'], false, 'C:\\'),
    ).toEqual([{ kind: 'session', sessionId: 's1' }]);
  });
});
