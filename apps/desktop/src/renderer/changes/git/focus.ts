// Shortcuts the Git panel takes while focus is inside it (ADR-0084): Mod+P opens "Go to file"
// and Mod+Shift+Y the file list there, instead of the Files tool. The application menu sends
// these as commands, so the shell asks the panels first.

type Claim = (command: string) => boolean;

const claims = new Set<Claim>();

/** Registers a panel's claim until the returned function is called. */
export function claimCommands(claim: Claim): () => void {
  claims.add(claim);
  return () => {
    claims.delete(claim);
  };
}

/** Whether a panel with focus handled `command`. */
export function claimPanelCommand(command: string): boolean {
  for (const claim of claims) if (claim(command)) return true;
  return false;
}
