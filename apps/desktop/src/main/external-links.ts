// Opening links in the system browser (architecture section 10.3, Electron security checklist
// item 15). The dialog and `shell.openExternal` sit behind `ExternalLinkPort` so tests can
// replace them; the production port is in external-link-port.ts.

/** URL schemes that may be handed to the operating system. */
export const EXTERNAL_PROTOCOLS: readonly string[] = ['https:', 'http:', 'mailto:'];

/** Longest URL accepted from the renderer. */
export const MAX_EXTERNAL_URL_LENGTH = 8192;

/** Side effects of opening a link. */
export interface ExternalLinkPort {
  /** Shows the full target address and resolves `true` only if the user confirms. */
  confirm(url: string): Promise<boolean>;
  /** Hands `url` to the system. */
  open(url: string): Promise<void>;
}

/**
 * Parses an untrusted value into an external URL. Returns `null` for non-strings, overlong or
 * malformed input, and for any scheme outside `EXTERNAL_PROTOCOLS` (`javascript:`, `file:`,
 * `data:`, custom schemes, ...).
 */
export function parseExternalUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > MAX_EXTERNAL_URL_LENGTH) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return EXTERNAL_PROTOCOLS.includes(url.protocol) ? url : null;
}

/**
 * Opens `value` after the user confirms. Resolves `true` when the link was opened and
 * `false` when it was rejected or the user cancelled. The normalized `href` is both shown and
 * opened, so the user confirms exactly the address that is used.
 */
export async function openExternalLink(value: unknown, port: ExternalLinkPort): Promise<boolean> {
  const url = parseExternalUrl(value);
  if (url === null) {
    console.warn('[security] rejected external link with a disallowed or malformed URL');
    return false;
  }
  if (!(await port.confirm(url.href))) {
    return false;
  }
  await port.open(url.href);
  return true;
}
