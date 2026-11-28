// Chromium switches a release build refuses (T45, I10, THR-12): `--remote-debugging-port` and
// `--remote-debugging-pipe` start a DevTools server no fuse turns off, through which any local
// process that can start PiArc could run script in its pages and call `window.piarc`. The
// development flavor keeps them: Playwright drives the packaged app over them.

/** The switches that start Chromium's remote debugging server. */
export const REMOTE_DEBUGGING_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-pipe',
] as const;

/** The part of `app.commandLine` this needs. */
export interface CommandLineSwitches {
  hasSwitch(name: string): boolean;
  removeSwitch(name: string): void;
}

/**
 * Removes the remote debugging switches present on `commandLine` and returns their names; the
 * caller exits when there were any. Runs before `ready`, so Chromium never starts the server.
 */
export function refuseRemoteDebugging(commandLine: CommandLineSwitches): string[] {
  const present = REMOTE_DEBUGGING_SWITCHES.filter((name) => commandLine.hasSwitch(name));
  for (const name of present) commandLine.removeSwitch(name);
  return present;
}
