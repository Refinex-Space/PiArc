// The text of a failed `window.piarc` call for the user.

/** The reason of `error`, without the prefix `ipcRenderer.invoke` adds. */
export function reason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // `ipcRenderer.invoke` prefixes "Error invoking remote method '<channel>': Error: ".
  return text.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/u, '');
}
