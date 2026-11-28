// Windows shell integration of the installed app (T35, ADR-0018 rule 3, ADR-0052): the
// `piarc://` URL scheme and the Explorer context menu "Open with PiArc" on folders and on a
// folder's background. Velopack installs per user without elevation, so the keys go under
// HKCU\Software\Classes, written by `reg.exe` from Velopack's install and update hooks and
// removed by its uninstall hook. The command lists are pure (unit-tested on every platform);
// running them is Windows-only.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { URL_SCHEME } from '../launch.js';

const CLASSES = 'HKCU\\Software\\Classes';

/** Explorer's verb keys, each with the placeholder Explorer fills in. */
const FOLDER_VERBS = [
  { key: 'Directory\\shell\\PiArc', placeholder: '%1' },
  { key: 'Directory\\Background\\shell\\PiArc', placeholder: '%V' },
] as const;

/** The text of the context menu item. */
export const OPEN_WITH_LABEL = 'Open with PiArc';

/** `reg.exe` argument lists that register the scheme and the context menu for `exe`. */
export function shellRegistration(exe: string): string[][] {
  const quoted = `"${exe}"`;
  const scheme = `${CLASSES}\\${URL_SCHEME}`;
  const commands: string[][] = [
    ['add', scheme, '/ve', '/d', 'URL:PiArc', '/f'],
    ['add', scheme, '/v', 'URL Protocol', '/d', '', '/f'],
    ['add', `${scheme}\\DefaultIcon`, '/ve', '/d', `${quoted},0`, '/f'],
    ['add', `${scheme}\\shell\\open\\command`, '/ve', '/d', `${quoted} "%1"`, '/f'],
  ];
  for (const verb of FOLDER_VERBS) {
    const key = `${CLASSES}\\${verb.key}`;
    commands.push(
      ['add', key, '/ve', '/d', OPEN_WITH_LABEL, '/f'],
      ['add', key, '/v', 'Icon', '/d', `${quoted},0`, '/f'],
      ['add', `${key}\\command`, '/ve', '/d', `${quoted} "${verb.placeholder}"`, '/f'],
    );
  }
  return commands;
}

/** `reg.exe` argument lists that remove everything `shellRegistration` wrote. */
export function shellUnregistration(): string[][] {
  return [
    ['delete', `${CLASSES}\\${URL_SCHEME}`, '/f'],
    ...FOLDER_VERBS.map((verb) => ['delete', `${CLASSES}\\${verb.key}`, '/f']),
  ];
}

/** `reg.exe` in the system directory (never one found on the PATH). */
export function regExe(systemRoot: string | undefined): string {
  return path.win32.join(systemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
}

/** Runs the commands with `reg.exe`, without a shell; failures are logged, not thrown. */
export function runRegistry(
  commands: readonly string[][],
  run: (file: string, args: readonly string[]) => { status: number | null } = (file, args) =>
    spawnSync(file, args, { stdio: 'ignore', windowsHide: true }),
): number {
  const reg = regExe(process.env.SystemRoot);
  let failed = 0;
  for (const args of commands) {
    const { status } = run(reg, args);
    // Deleting a key that is not there fails harmlessly.
    if (status !== 0 && args[0] !== 'delete') {
      failed += 1;
      console.warn(`[shell] reg ${args.slice(0, 2).join(' ')} failed (${String(status)})`);
    }
  }
  return failed;
}
