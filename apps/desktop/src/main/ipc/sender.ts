// IPC sender validation (architecture section 10.3, Electron security checklist item 17).

/** The part of Electron's `WebFrameMain` the check needs. */
export interface SenderFrame {
  readonly origin: string;
}

/**
 * True when the IPC message comes from a frame whose origin is exactly one of
 * `trustedOrigins`. A missing frame (destroyed or navigated away) is rejected. Origins are
 * compared as whole strings, never by URL prefix.
 */
export function isTrustedSender(
  frame: SenderFrame | null | undefined,
  trustedOrigins: readonly string[],
): boolean {
  return frame != null && trustedOrigins.includes(frame.origin);
}
