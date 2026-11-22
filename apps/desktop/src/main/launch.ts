// What `piarc://` links, folders given on the command line, a second start and macOS's
// open-file events ask the app to open (T35, architecture section 8.8). Pure functions: the
// main process routes the result to a window; nothing here opens or runs anything.
//
// Links only locate: `piarc://open?path=<absolute folder>` opens a folder as a workspace,
// `piarc://session/<id>` shows a session. Any other link or parameter is ignored, so a link
// cannot carry a prompt to send or a command to run. The folder is checked by Core when the
// window opens it, and its trust dialog shows as for any folder.
import path from 'node:path';

import { isSessionId, type LaunchTarget } from '../shared/ipc.js';

/** The URL scheme PiArc registers. */
export const URL_SCHEME = 'piarc';

/** Longest path a link or argument may name. */
const MAX_PATH = 4096;

function absolute(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

function folder(value: string): LaunchTarget | undefined {
  if (value.length === 0 || value.length > MAX_PATH || value.includes('\0') || !absolute(value)) {
    return undefined;
  }
  return { kind: 'workspace', path: value };
}

/** The target of a `piarc://` link, or `undefined` for anything else. */
export function parseLaunchUrl(text: string): LaunchTarget | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== `${URL_SCHEME}:`) return undefined;
  switch (url.hostname) {
    case 'open': {
      const target = url.searchParams.get('path');
      // A link names a local folder: a UNC path (`\\host\share`, `//host/share`) or a device
      // path (`\\?\`, `\\.\`) would make Core reach another host, which can leak the user's
      // NetNTLM hash on Windows (T45, I170). Folders given on the command line or dropped keep
      // their own rules.
      if (target === null || /^[\\/]{2}/u.test(target)) return undefined;
      return folder(target);
    }
    case 'session': {
      let id: string;
      try {
        id = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      } catch {
        return undefined;
      }
      return isSessionId(id) ? { kind: 'session', sessionId: id } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * The targets of a command line: `piarc://` links and folders (relative ones against `cwd`).
 * The first argument is the executable; when started as `electron <app>` (`defaultApp`), the
 * first argument that is not a switch is the app's path. Switches are ignored.
 */
export function launchTargets(
  argv: readonly string[],
  defaultApp: boolean,
  cwd: string,
): LaunchTarget[] {
  const targets: LaunchTarget[] = [];
  let appPath = defaultApp;
  for (const arg of argv.slice(1)) {
    if (arg.length === 0 || arg.startsWith('-')) continue;
    if (appPath) {
      appPath = false;
      continue;
    }
    const target = arg.toLowerCase().startsWith(`${URL_SCHEME}:`)
      ? parseLaunchUrl(arg)
      : folder(absolute(arg) ? arg : path.resolve(cwd, arg));
    if (target !== undefined) targets.push(target);
  }
  return targets;
}
