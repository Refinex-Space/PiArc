// The IPC contract between the preload script and the main process: channel names and the
// shape of `window.piarc`. Every channel is registered in the main process through
// `registerHandler` (src/main/ipc/register.ts), which checks the sender's origin first.

/** Channel names, one per `window.piarc` command. */
export const IPC_CHANNELS = {
  getAppVersion: 'piarc:app.getVersion',
  openExternal: 'piarc:shell.openExternal',
} as const;

/**
 * The API the preload script exposes to the renderer as `window.piarc`. Adding a member
 * means adding a channel above, a handler in the main process, and updating the key
 * snapshot in `e2e/preload.e2e.ts`.
 */
export interface PiarcApi {
  /** The application version (`app.getVersion()`). */
  getAppVersion(): Promise<string>;
  /**
   * Asks the main process to open `url` in the system browser. The main process accepts only
   * `https:`, `http:` and `mailto:` URLs and shows a native confirmation dialog first.
   * Resolves `true` when the link was opened, `false` when it was rejected or cancelled.
   */
  openExternal(url: string): Promise<boolean>;
}
